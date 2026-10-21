import assert from "node:assert/strict";
import { test } from "@omochi-ui/core/testing";
import { BodyMatcher, readText } from "../src/http-body.js";

const encode = (text: string) => new TextEncoder().encode(text);
const overlap = (matcher: BodyMatcher) => (matcher as unknown as { matchTail: string }).matchTail;

for (const expected of ["!", "needle", "日本語"]) {
  test(`body matcher keeps bounded overlap for ${JSON.stringify(expected)}`, () => {
    const matcher = new BodyMatcher(expected);
    for (let i = 0; i < 200; i++) {
      matcher.write(encode("x".repeat(8192)));
      assert.ok(overlap(matcher).length <= expected.length - 1);
    }
    assert.equal(matcher.matched, false);
    // Splitting each byte also splits UTF-8 characters across chunks.
    for (const byte of encode(expected)) matcher.write(Uint8Array.of(byte));
    matcher.finish();
    assert.equal(matcher.matched, true);
    assert.equal(overlap(matcher), "");
  });
}

for (const [expected, suffix, matched] of [
  ["!", "", false], ["!", "!", true], ["needle", "needle", true], ["日本語", "日本語", true],
] as const) {
  test(`large streamed body with ${JSON.stringify(expected)} ${matched ? "late" : "absent"} match`, async () => {
    let chunk = 0;
    const ending = [...encode(suffix)].map(byte => Uint8Array.of(byte));
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunk++ < 200) controller.enqueue(encode("x".repeat(8192)));
        else if (ending.length) controller.enqueue(ending.shift()!);
        else controller.close();
      },
    }));
    const result = await readText(response, 1024, expected);
    assert.equal(result.text, "x".repeat(1024));
    assert.equal(result.truncated, true);
    assert.equal(result.expectedMatched, matched);
  });
}

test("body matching handles empty expectations, missing bodies and decoder flush", async () => {
  assert.equal((await readText(new Response(null), 32, "")).expectedMatched, true);
  assert.equal((await readText(new Response(null), 32, "x")).expectedMatched, false);
  assert.equal((await readText(new Response(Uint8Array.of(0xe3)), 32, "�")).expectedMatched, true);
  assert.equal((await readText(new Response("test"), 32)).text, "test");
});
