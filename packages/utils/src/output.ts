const OUTPUT_LIMIT = 64 * 1024;

export class OutputBuffer {
  private value = "";
  private wasTruncated = false;

  get text(): string { return this.value; }
  get truncated(): boolean { return this.wasTruncated; }

  reset(value = ""): void {
    this.value = "";
    this.wasTruncated = false;
    this.append(value);
  }

  append(chunk: string): void {
    const bytes = Buffer.from(this.value + chunk);
    if (bytes.length <= OUTPUT_LIMIT) {
      this.value += chunk;
      return;
    }
    let start = bytes.length - OUTPUT_LIMIT;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    this.value = bytes.subarray(start).toString("utf8");
    this.wasTruncated = true;
  }
}

export function fenced(text: string, truncated = false): string {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return `${truncated ? "Earlier output truncated.\n\n" : ""}${fence}\n${text}\n${fence}`;
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}
