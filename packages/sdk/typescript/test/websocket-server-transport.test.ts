import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "@omochi-ui/core/testing";

import { WebSocket } from "ws";

import { App } from "../src/index.js";
import { WebSocketServerTransport } from "../src/node/index.js";
import type { JsonObject } from "../src/index.js";

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function messages(socket: WebSocket): () => Promise<JsonObject> {
  const pending: JsonObject[] = [];
  const waiters: Array<(message: JsonObject) => void> = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as JsonObject;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else pending.push(message);
  });
  return () => {
    const message = pending.shift();
    return message ? Promise.resolve(message) : new Promise((resolve) => waiters.push(resolve));
  };
}

async function initialSnapshot(next: () => Promise<JsonObject>): Promise<JsonObject[]> {
  return Promise.all([next(), next(), next()]);
}

test("hosts one shared app and snapshots its latest state for late clients", async (t) => {
  const transport = new WebSocketServerTransport({
    host: "127.0.0.1",
    port: 0,
    path: "/a2ui",
    capabilities: ["test-capability"],
  });
  assert.equal(transport.url, null);
  assert.deepEqual([...transport.capabilities], ["test-capability"]);

  const state = { count: 0 };
  const app = new App(state);
  const increment = app.action<null>("increment", async (_input, context) => {
    await context.update((current) => { current.count += 1; });
  });
  app.surface("main", (ui, current) => {
    ui.text(`Count: ${current.count}`, { key: "count" });
    ui.button("Increment", increment.call(null), { key: "increment" });
  });
  const running = app.start(transport);
  await transport.ready;
  assert.match(transport.url!, /^ws:\/\/127\.0\.0\.1:\d+\/a2ui$/);
  t.after(async () => {
    await transport.close();
    await running;
  });

  const first = new WebSocket(transport.url!);
  const nextFirst = messages(first);
  await opened(first);
  t.after(() => first.close());
  const firstInitial = await initialSnapshot(nextFirst);
  assert.ok("createSurface" in firstInitial[0]!);
  assert.ok("updateComponents" in firstInitial[1]!);
  assert.ok("updateDataModel" in firstInitial[2]!);

  const second = new WebSocket(transport.url!);
  const nextSecond = messages(second);
  await opened(second);
  t.after(() => second.close());
  await initialSnapshot(nextSecond);

  first.send(JSON.stringify({
    version: "v0.9",
    action: {
      name: "increment",
      surfaceId: "main",
      sourceComponentId: "increment",
      timestamp: "2026-08-12T00:00:00.000Z",
      context: {},
    },
    metadata: {
      a2uiClientDataModel: { version: "v0.9", surfaces: { main: { inputs: {} } } },
    },
  }));
  const firstUpdate = await nextFirst();
  const secondUpdate = await nextSecond();
  assert.deepEqual(firstUpdate, secondUpdate);
  assert.equal(state.count, 1);
  const components = (firstUpdate.updateComponents as JsonObject).components as JsonObject[];
  assert.equal(components.find((component) => component.id === "count")?.text, "Count: 1");

  const late = new WebSocket(transport.url!);
  const nextLate = messages(late);
  await opened(late);
  t.after(() => late.close());
  const lateSnapshot = await initialSnapshot(nextLate);
  const lateComponents = (lateSnapshot[1]!.updateComponents as JsonObject).components as JsonObject[];
  assert.equal(lateComponents.find((component) => component.id === "count")?.text, "Count: 1");

  await transport.close();
  await transport.close();
  await running;
});

test("rejects invalid input without disconnecting other clients", async (t) => {
  const transport = new WebSocketServerTransport({ port: 0 });
  const app = new App({});
  app.surface("main", (ui) => ui.text("Ready"));
  const running = app.start(transport);
  await transport.ready;
  t.after(async () => {
    await transport.close();
    await running;
  });

  const healthy = new WebSocket(transport.url!);
  await opened(healthy);
  const invalidJson = new WebSocket(transport.url!);
  await opened(invalidJson);
  invalidJson.send("not json");
  assert.equal(await new Promise<number>((resolve) => invalidJson.once("close", resolve)), 1007);
  assert.equal(healthy.readyState, WebSocket.OPEN);

  const invalidMessage = new WebSocket(transport.url!);
  await opened(invalidMessage);
  invalidMessage.send(JSON.stringify({ version: "v0.9", error: { message: "not an action" } }));
  assert.equal(await new Promise<number>((resolve) => invalidMessage.once("close", resolve)), 1007);
  assert.equal(healthy.readyState, WebSocket.OPEN);

  const binary = new WebSocket(transport.url!);
  await opened(binary);
  binary.send(Buffer.from("{}"));
  assert.equal(await new Promise<number>((resolve) => binary.once("close", resolve)), 1003);
  assert.equal(healthy.readyState, WebSocket.OPEN);
  healthy.close();
});

test("reports bind errors through ready and app.start", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  const transport = new WebSocketServerTransport({ host: "127.0.0.1", port: address.port });
  const app = new App({});
  app.surface("main", (ui) => ui.text("Ready"));
  await assert.rejects(transport.ready, { code: "EADDRINUSE" });
  await assert.rejects(app.start(transport), { code: "EADDRINUSE" });
  await transport.close();
  await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
});
