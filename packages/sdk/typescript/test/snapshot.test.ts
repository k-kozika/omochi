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
