import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
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
