import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "@omochi-ui/core/testing";

import { A2uiSnapshot } from "../src/node/snapshot.js";
import type { A2UIMessage, JsonObject } from "../src/index.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../spec/fixtures/snapshot.json", import.meta.url), "utf8"),
) as { messages: A2UIMessage[]; snapshot: JsonObject[] };

test("materializes the shared snapshot fixture", () => {
  const snapshot = new A2uiSnapshot();
  for (const message of fixture.messages) snapshot.apply(message);
  assert.deepEqual(snapshot.messages(), fixture.snapshot);
});

test("prototype-sensitive updates are literal and surface-local", () => {
  const snapshot = new A2uiSnapshot();
  for (const surfaceId of ["one", "two"]) {
    snapshot.apply({ version: "v0.9", createSurface: { surfaceId, catalogId: "test" } });
    snapshot.apply({ version: "v0.9", updateDataModel: { surfaceId, value: {} } });
  }
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  for (const path of ["/__proto__/snapshotPolluted", "/constructor/prototype/snapshotPolluted", "/prototype/snapshotPolluted"]) {
    snapshot.apply({ version: "v0.9", updateDataModel: { surfaceId: "one", path, value: true } });
  }
  snapshot.apply({ version: "v0.9", updateDataModel: { surfaceId: "one", path: "/__proto__/snapshotPolluted" } });
  const data = snapshot.messages().filter(m => "updateDataModel" in m).map(m => (m.updateDataModel as { value: Record<string, unknown> }).value);
  assert.deepEqual(data, [JSON.parse('{"__proto__":{},"constructor":{"prototype":{"snapshotPolluted":true}},"prototype":{"snapshotPolluted":true}}'), {}]);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
  assert.equal(Object.getPrototypeOf(data[0]), Object.prototype);
  const replay = new A2uiSnapshot();
  for (const message of snapshot.messages()) replay.apply(message);
  assert.deepEqual(replay.messages(), snapshot.messages());
});

test("array traversal ignores inherited numeric properties", () => {
  const snapshot = new A2uiSnapshot();
  snapshot.apply({ version: "v0.9", createSurface: { surfaceId: "one", catalogId: "test" } });
  // A hole survives structuredClone; a property on Array.prototype must not fill it.
  const rows = new Array(4);
  snapshot.apply({ version: "v0.9", updateDataModel: { surfaceId: "one", value: { rows } } });
  const inherited = { kept: true };
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, "3");
  Object.defineProperty(Array.prototype, "3", { value: inherited, writable: true, configurable: true });
  try {
    snapshot.apply({ version: "v0.9", updateDataModel: { surfaceId: "one", path: "/rows/3/changed", value: true } });
    assert.deepEqual(inherited, { kept: true });
    const message = snapshot.messages().find(m => "updateDataModel" in m)!;
    const value = (message.updateDataModel as { value: { rows: unknown[] } }).value;
    assert.deepEqual(value.rows[3], { changed: true });
    assert.equal(Object.getPrototypeOf(value.rows), Array.prototype);
    snapshot.apply({ version: "v0.9", updateDataModel: { surfaceId: "one", path: "/rows", value: rows } });
    snapshot.apply({ version: "v0.9", updateDataModel: { surfaceId: "one", path: "/rows/0" } });
    const deletion = snapshot.messages().find(m => "updateDataModel" in m)!;
    const shifted = (deletion.updateDataModel as { value: { rows: unknown[] } }).value.rows;
    assert.equal(shifted.length, 3);
    assert.equal(Object.hasOwn(shifted, 2), false, "deletion must not copy an inherited index");
    assert.deepEqual(inherited, { kept: true });
  } finally {
    if (previous) Object.defineProperty(Array.prototype, "3", previous);
    else Reflect.deleteProperty(Array.prototype, "3");
  }
});

test("prototype-sensitive leaf keys are ordinary data properties", () => {
  const snapshot = new A2uiSnapshot();
  snapshot.apply({ version: "v0.9", createSurface: { surfaceId: "one", catalogId: "test" } });
  for (const key of ["__proto__", "constructor", "prototype"]) {
    snapshot.apply({ version: "v0.9", updateDataModel: { surfaceId: "one", path: `/${key}`, value: { literal: true } } });
    const message = snapshot.messages().find(m => "updateDataModel" in m)!;
    const value = (message.updateDataModel as { value: Record<string, unknown> }).value;
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(value, key), {
      value: { literal: true }, enumerable: true, writable: true, configurable: true,
    });
    snapshot.apply({ version: "v0.9", updateDataModel: { surfaceId: "one", path: `/${key}` } });
    const deleted = snapshot.messages().find(m => "updateDataModel" in m)!;
    assert.deepEqual((deleted.updateDataModel as { value: unknown }).value, {});
  }
});
