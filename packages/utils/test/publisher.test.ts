import assert from "node:assert/strict";
import { test } from "@omochi-ui/core/testing";
import { actionMessage, createSurface, waitFor } from "@omochi-ui/core/testing";
import { Publisher } from "../src/publisher.js";
import { observe, publisherFor } from "./helpers.js";

test("batches prevalidate without leaking partial state; late connections see current state", async (t) => {
  const publisher = await publisherFor(t);
  const observer = observe(t, publisher.transport.socketPath!);
  await assert.rejects(publisher.publish([
    createSurface("main"),
    { version: "v0.9", updateDataModel: { surfaceId: "missing", value: {} } },
  ]), /messages\[1\].*unknown surface/);
  assert.deepEqual(publisher.list().surfaceIds, []);
  assert.equal(observer.messages.length, 0);

  await publisher.publish([createSurface("main"), { version: "v0.9", updateDataModel: { surfaceId: "main", value: { count: 1 } } }]);
  await publisher.publish([{ version: "v0.9", updateDataModel: { surfaceId: "main", path: "/count", value: 2 } }]);
  const late = observe(t, publisher.transport.socketPath!);
  await waitFor(() => late.messages.length === 2);
  assert.match(late.text(), /"count":2/);
  await assert.rejects(publisher.publish([createSurface("main")]), /already exists/);
  await assert.rejects(publisher.publish([{ version: "v0.9", updateDataModel: { surfaceId: "main", path: "/__proto__/polluted", value: true } }]), /unsafe/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);

  observer.socket.write(JSON.stringify(actionMessage("main", {})) + "\n");
  assert.equal((await publisher.events.read(0, 1000)).events.length, 1);
  await publisher.publish([{ version: "v0.9", deleteSurface: { surfaceId: "main" } }]);
  await waitFor(() => late.snapshot.messages().length === 0);
  assert.deepEqual(publisher.list().surfaceIds, []);
});

test("duplicate service IDs fail without disturbing the owner", async (t) => {
  const publisher = await publisherFor(t);
  await assert.rejects(Publisher.open({ serviceId: publisher.serviceId, runtimeDir: publisher.transport.directory!.replace(/\/test$/, "") }), /in use|already|active/i);
  await publisher.publish([createSurface("main")]);
  const observer = observe(t, publisher.transport.socketPath!);
  await waitFor(() => observer.messages.length === 1);
});
