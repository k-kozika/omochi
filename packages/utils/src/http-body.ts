import { StringDecoder } from "node:string_decoder";

/** Internal streaming matcher; retains only the overlap needed by the next chunk. */
export class BodyMatcher {
  private readonly decoder = new TextDecoder();
  private matchTail = "";
  matched: boolean;

  constructor(private readonly expected?: string) {
    this.matched = expected === undefined || expected === "";
  }

  write(value: Uint8Array): void {
    if (!this.matched) this.match(this.decoder.decode(value, { stream: true }));
  }

  finish(): void {
    if (!this.matched) this.match(this.decoder.decode());
  }

  private match(decoded: string): void {
    const expected = this.expected!;
    const searchable = this.matchTail + decoded;
    this.matched = searchable.includes(expected);
    this.matchTail = !this.matched && expected.length > 1 ? searchable.slice(-(expected.length - 1)) : "";
  }
}

export async function readText(response: Response, limit: number, expected?: string): Promise<{ text: string; truncated: boolean; expectedMatched: boolean }> {
  if (!response.body) return { text: "", truncated: false, expectedMatched: expected === undefined || expected === "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const matcher = new BodyMatcher(expected);
  let visibleLength = 0;
  let totalLength = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      matcher.finish();
      break;
    }
    totalLength += value.length;
    if (visibleLength < limit) {
      const visible = value.subarray(0, Math.min(value.length, limit - visibleLength));
      chunks.push(visible);
      visibleLength += visible.length;
    }
    matcher.write(value);
    if (totalLength > limit) {
      truncated = true;
      if (expected === undefined || matcher.matched) {
        await reader.cancel();
        break;
      }
    }
  }
  const visible = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), visibleLength);
  return { text: new StringDecoder("utf8").write(visible), truncated, expectedMatched: matcher.matched };
}
