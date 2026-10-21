import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createConnection, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "@omochi-ui/core/testing";

import { App } from "../src/index.js";
import { UnixSocketServerTransport } from "../src/node/index.js";
import type { JsonObject } from "../src/index.js";

async function runtimeDir(t: import("@omochi-ui/core/testing").TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "omochi-unix-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function connectClient(socketPath: string): { socket: Socket; next: () => Promise<JsonObject> } {
  const socket = createConnection(socketPath);
  const pending: JsonObject[] = [];
  const waiters: Array<(message: JsonObject) => void> = [];
  createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as JsonObject;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else pending.push(message);
  });
  return {
    socket,
    next: () => {
      const message = pending.shift();
      return message ? Promise.resolve(message) : new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function counterApp(): { app: App<{ count: number }> } {
  const app = new App({ count: 0 });
  const increment = app.action<null>("increment", async (_input, context) => {
    await context.update((current) => { current.count += 1; });
  });
  app.surface("main", (ui, current) => {
    ui.text(`Count: ${current.count}`, { key: "count" });
    ui.button("Increment", increment.call(null), { key: "increment" });
  });
  return { app };
}

test("publishes a discoverable socket and manifest, then removes both on close", async (t) => {
  const root = await runtimeDir(t);
  const transport = new UnixSocketServerTransport({ serviceId: "demo", name: "Demo", icon: "🎤", runtimeDir: root });
  const { app } = counterApp();
  const running = app.start(transport);
  await transport.ready;

  const directory = path.join(root, "demo");
  assert.equal(transport.directory, directory);
  assert.equal(transport.socketPath, path.join(directory, "a2ui.sock"));
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")), {
    name: "Demo",
    socket: "a2ui.sock",
    icon: "🎤",
  });

  const client = connectClient(transport.socketPath!);
  t.after(() => client.socket.destroy());
  const first = await client.next();
  assert.deepEqual(first, {
    version: "v0.9",
    createSurface: { surfaceId: "main", catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json", sendDataModel: true },
  });
  await client.next();
  await client.next();

  await transport.close();
  await running;
  await assert.rejects(access(path.join(directory, "manifest.json")));
  await assert.rejects(access(directory));
});

test("fans one application out to every client and snapshots for late joiners", async (t) => {
  const root = await runtimeDir(t);
  const transport = new UnixSocketServerTransport({ serviceId: "demo", runtimeDir: root });
  const { app } = counterApp();
  const running = app.start(transport);
  await transport.ready;
  t.after(async () => {
    await transport.close();
    await running;
  });

  const first = connectClient(transport.socketPath!);
  t.after(() => first.socket.destroy());
  await first.next();
  await first.next();
  await first.next();

  first.socket.write(`${JSON.stringify({
    version: "v0.9",
    action: { name: "increment", surfaceId: "main", sourceComponentId: "increment", timestamp: "2026-08-12T00:00:00.000Z", context: {} },
  })}\n`);
  await first.next();

  const late = connectClient(transport.socketPath!);
  t.after(() => late.socket.destroy());
  const replay = [await late.next(), await late.next(), await late.next()];
  const components = replay.find((message) => "updateComponents" in message) as
    | { updateComponents: { components: Array<{ id: string; text?: string }> } }
    | undefined;
  assert.ok(components);
  assert.equal(components.updateComponents.components.find((component) => component.id === "count")?.text, "Count: 1");
});

test("refuses a service id that would escape the runtime directory", async (t) => {
  const root = await runtimeDir(t);
  for (const serviceId of [".", "..", "a/b", "", "x".repeat(65)]) {
    assert.throws(() => new UnixSocketServerTransport({ serviceId, runtimeDir: root }), TypeError);
  }
});

test("recovers a socket left behind by a crash and refuses a live duplicate", async (t) => {
  const root = await runtimeDir(t);
  const first = new UnixSocketServerTransport({ serviceId: "demo", runtimeDir: root });
  const { app } = counterApp();
  const running = app.start(first);
  await first.ready;

  const duplicate = new UnixSocketServerTransport({ serviceId: "demo", runtimeDir: root });
  await assert.rejects(duplicate.ready, /already owns/);
  await duplicate.close();
  assert.equal(cleanupState(duplicate).server.listening, false);
  assert.equal(cleanupState(duplicate).clients.size, 0);
  await access(first.socketPath!);
  await access(path.join(first.directory!, "manifest.json"));
  const surviving = connectClient(first.socketPath!);
  await surviving.next();
  surviving.socket.destroy();

  await first.close();
  await running;

  // A stale socket file must not block the next start.
  const restarted = new UnixSocketServerTransport({ serviceId: "demo", runtimeDir: root });
  const second = counterApp();
  const secondRunning = second.app.start(restarted);
  await restarted.ready;
  t.after(async () => {
    await restarted.close();
    await secondRunning;
  });
  assert.ok(restarted.socketPath);
});


function cleanupState(transport: UnixSocketServerTransport) {
  return transport as unknown as { server: Server; clients: Set<Socket>; exitCleanup: () => void; accept(socket: Socket): void };
}

test("close during startup is idempotent and leaves no owned resources", async (t) => {
  const root = await runtimeDir(t);
  for (let i = 0; i < 5; i++) {
    const transport = new UnixSocketServerTransport({ serviceId: "early", runtimeDir: root });
    const state = cleanupState(transport);
    const first = transport.close();
    assert.equal(transport.close(), first);
    assert.ok(process.listeners("exit").includes(state.exitCleanup), "exit cleanup survives pending startup");
    const late = new Socket();
    state.accept(late);
    assert.ok(late.destroyed, "shutdown rejects new connections");
    await Promise.all([first, transport.close()]);
    await transport.ready;
    assert.equal(state.server.listening, false);
    assert.equal(state.clients.size, 0);
    assert.ok(!process.listeners("exit").includes(state.exitCleanup));
    await assert.rejects(access(path.join(root, "early")));
    assert.equal((await transport[Symbol.asyncIterator]().next()).done, true);
    await transport.close();
  }
});

test("close after a manifest-write failure cleans up the successfully bound socket", async (t) => {
  const root = await runtimeDir(t);
  await mkdir(path.join(root, "failed/manifest.json"), { recursive: true });
  const transport = new UnixSocketServerTransport({ serviceId: "failed", runtimeDir: root });
  await assert.rejects(transport.ready);
  assert.equal(transport.directory, path.join(root, "failed"));
  assert.ok(cleanupState(transport).server.listening);
  await transport.close();
  assert.equal(cleanupState(transport).server.listening, false);
  assert.equal(cleanupState(transport).clients.size, 0);
  assert.ok(!process.listeners("exit").includes(cleanupState(transport).exitCleanup));
  await assert.rejects(access(path.join(root, "failed")));
  await transport.close();
});
