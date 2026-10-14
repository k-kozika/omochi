import assert from "node:assert/strict";
import { test } from "@omochi-ui/core/testing";
import { EventBuffer } from "../src/events.js";

test("event cursors replay without consuming and report retention gaps", async () => {
  const events = new EventBuffer(2);
  events.push({ action: { name: "one" } });
  events.push({ action: { name: "two" } });
  events.push({ action: { name: "three" } });
  const first = await events.read();
  assert.equal(first.dropped, 1);
  assert.equal(first.nextCursor, 3);
  assert.deepEqual(first.events.map((event) => event.sequence), [2, 3]);
  assert.deepEqual(await events.read(), first);
  first.events[0]!.message.action = null;
  assert.notEqual((await events.read()).events[0]!.message.action, null);
  assert.deepEqual((await events.read(3)).events, []);
  await assert.rejects(events.read(4), /cursor/);
});

test("waiting reads wake on events, timeout, cancellation and shutdown", async () => {
  const events = new EventBuffer();
  const pending = events.read(0, 30_000);
  events.push({ action: { name: "submit" } });
  assert.equal((await pending).events.length, 1);
  assert.deepEqual((await events.read(1, 1)).events, []);
  const controller = new AbortController();
  const cancelled = events.read(1, 30_000, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /abort/i);
  const closed = events.read(1, 30_000);
  events.close();
  assert.equal((await closed).closed, true);
});
