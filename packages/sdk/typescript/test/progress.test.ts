import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "@omochi-ui/core/testing";
import { App, type JsonObject } from "../src/index.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("tabs preserve titles and sibling children across renders", async () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../spec/fixtures/tabs.json", import.meta.url), "utf8"));
  const app = new App({ title: "Second" });
  app.surface("main", (ui, state) => ui.tabs({ key: "tabs", tabs: [
    { title: "First", content: (ui) => ui.text("A", { key: "first" }) },
    { title: state.title, content: (ui) => ui.text("B", { key: "second" }) },
  ] }));
  const runtime = app.build();
  assert.deepEqual(runtime.render()[1]!.updateComponents, { surfaceId: "main", components: fixture.initialComponents });
  assert.deepEqual(await runtime.update((state) => { state.title = "Renamed"; }), [
    { version: "v0.9", updateComponents: { surfaceId: "main", components: fixture.afterUpdateComponents } },
  ]);
});

test("action updates send progress before completion without duplicates", { timeout: 3000 }, async () => {
  const entered = gate(), release = gate(), stopped = gate();
  const sent: JsonObject[] = [];
  const app = new App({ status: "idle" });
  for (const id of ["one", "two"]) app.surface(id, (ui, state) => ui.text(state.status, { key: "status" }));
  app.action("work", async (_, ctx) => {
    await ctx.update((state) => { state.status = "working"; });
    entered.resolve();
    await release.promise;
    await ctx.update((state) => { state.status = "done"; });
    await ctx.update(() => {});
  });
  const runtime = app.build();
  const running = runtime.start({ capabilities: new Set(), async send(message) { sent.push(message); }, async *[Symbol.asyncIterator]() { await stopped.promise; } });
  await runtime.ready();
  sent.length = 0;
  const action = runtime.invoke("work", null);
  try {
    await entered.promise;
    assert.equal(sent.length, 2);
    assert.equal(((sent[0]!.updateComponents as JsonObject).components as JsonObject[])[0]!.text, "working");
  } finally { release.resolve(); }
  const messages = await action;
  assert.deepEqual(messages, sent);
  assert.equal(sent.length, 4);
  stopped.resolve();
  await running;
});

test("concurrent context updates stay ordered and offline invocation returns all changes", async () => {
  const app = new App({ value: 0 });
  app.surface("main", (ui, state) => ui.text(String(state.value), { key: "value" }));
  app.action("work", async (_, ctx) => {
    await Promise.all([
      ctx.update(async (state) => { await Promise.resolve(); state.value = 1; }),
      ctx.update((state) => { state.value = 2; }),
    ]);
  });
  const runtime = app.build(); runtime.render();
  const messages = await runtime.invoke("work", null);
  assert.deepEqual(messages.map((m) => ((m.updateComponents as JsonObject).components as JsonObject[])[0]!.text), ["1", "2"]);
});

test("action and send failures propagate without rolling back prior updates or wedging the queue", async () => {
  const state = { value: 0 };
  const app = new App(state);
  app.surface("main", (ui, state) => ui.text(String(state.value), { key: "value" }));
  app.action("fail", async (_, ctx) => {
    await ctx.update((state) => { state.value = 1; });
    throw new Error("action failed");
  });
  app.action("set", async (_, ctx) => ctx.update((state) => { state.value++; }));
  const runtime = app.build();
  // An empty receiver attaches a transport without starting a background reader.
  let failSend = false;
  const sent: JsonObject[] = [];
  await runtime.start({ capabilities: new Set(), async send(m) { if (failSend) throw new Error("send failed"); sent.push(m); }, async *[Symbol.asyncIterator]() {} });
  sent.length = 0;
  await assert.rejects(runtime.invoke("fail", null), /action failed/);
  assert.equal(state.value, 1);
  assert.equal(sent.length, 1);
  failSend = true;
  await assert.rejects(runtime.invoke("set", null), /send failed/);
  failSend = false;
  assert.equal((await runtime.invoke("set", null)).length, 1);
});
