import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@omochi-ui/core/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createXdgManifestProvider, startGateway } from "@omochi-ui/discovery";
import { actionMessage, createSurface, messageQueue, opened, waitFor } from "@omochi-ui/core/testing";
import { WebSocket } from "ws";
import { temporary } from "./helpers.js";

test("stdio MCP publishes through gateway, replays state, receives actions and retracts on disconnect", { timeout: 15_000 }, async (t) => {
  const directory = await temporary(t);
  const root = path.join(directory, "omochi");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "mcp", "--service-id", "agent"],
    env: { ...process.env as Record<string, string>, XDG_RUNTIME_DIR: directory },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "test", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map((item) => item.name), ["publish_messages", "list_surfaces", "read_events"]);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const published = await call("publish_messages", { messages: [createSurface("main"), { version: "v0.9", updateDataModel: { surfaceId: "main", value: { title: "first" } } }] });
  assert.equal(published.isError, undefined);
  assert.deepEqual((await call("list_surfaces")).structuredContent, { serviceId: "agent", surfaceIds: ["main"] });
  const bad = await call("publish_messages", { messages: [createSurface("other"), { version: "v0.9", updateDataModel: { surfaceId: "absent", value: {} } }] });
  assert.equal(bad.isError, true);
  assert.deepEqual((await call("list_surfaces")).structuredContent, { serviceId: "agent", surfaceIds: ["main"] });

  const gateway = await startGateway({ root, nodeId: "aaaaaaaaaaaaaaaa", name: "test", discovery: createXdgManifestProvider({ root, debounceMs: 10, rescanMs: 50 }) });
  t.after(() => gateway.close());
  const socket = new WebSocket(gateway.urlFor("/v1/a2ui"));
  t.after(() => socket.terminate());
  const next = messageQueue(socket);
  await opened(socket);
  assert.deepEqual(await next(), createSurface("agent/main"));
  assert.deepEqual(await next(), { version: "v0.9", updateDataModel: { surfaceId: "agent/main", path: "/", value: { title: "first" } } });
  await call("publish_messages", { messages: [{ version: "v0.9", updateDataModel: { surfaceId: "main", path: "/title", value: "second" } }] });
  assert.deepEqual(await next(), { version: "v0.9", updateDataModel: { surfaceId: "agent/main", path: "/title", value: "second" } });

  const waiting = call("read_events", { after: 0, timeoutMs: 2000 });
  socket.send(JSON.stringify(actionMessage("agent/main", { "agent/main": { answer: "yes" } })));
  const received = (await waiting).structuredContent as { events: Array<{ message: unknown }>; nextCursor: number };
  assert.equal(received.nextCursor, 1);
  assert.deepEqual(received.events[0]!.message, actionMessage("main", { main: { answer: "yes" } }));
  assert.deepEqual((await call("read_events")).structuredContent, received);
  const abort = new AbortController();
  const cancelled = client.callTool({ name: "read_events", arguments: { after: 1, timeoutMs: 30_000 } }, undefined, { signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelled);
  await call("publish_messages", { messages: [{ version: "v0.9", deleteSurface: { surfaceId: "main" } }] });
  assert.deepEqual(await next(), { version: "v0.9", deleteSurface: { surfaceId: "agent/main" } });
  await call("publish_messages", { messages: [createSurface("last")] });
  assert.deepEqual(await next(), createSurface("agent/last"));
  await client.close();
  assert.deepEqual(await next(), { version: "v0.9", deleteSurface: { surfaceId: "agent/last" } });
  await waitFor(async () => { try { await access(path.join(root, "agent", "manifest.json")); return false; } catch { return true; } });
});
