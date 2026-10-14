import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { UI } from "@omochi-ui/sdk";
import { OutputBuffer, fenced } from "./output.js";
import { Publisher } from "./publisher.js";
import { UtilitySurface } from "./surface.js";

const READ_LIMIT = 64 * 1024;
const POLL_INTERVAL = 500;

export interface TailOptions {
  path: string;
  lines: number;
  name: string;
}

export class FileTail extends UtilitySurface {
  private readonly output = new OutputBuffer();
  private decoder = new StringDecoder("utf8");
  private identity?: string;
  private position = 0;
  private seenFile = false;
  private status = "Waiting for file…";
  private pollTimer?: NodeJS.Timeout;

  constructor(publisher: Publisher, private readonly options: TailOptions) {
    super(publisher, options.name);
  }

  override async start(): Promise<void> {
    await super.start();
    void this.poll();
  }

  protected build(ui: UI): void {
    ui.text(this.name, { key: "title", variant: "h3" });
    ui.text(this.status, { key: "status" });
    ui.text(fenced(this.output.text, this.output.truncated), { key: "output" });
  }

  close(): Promise<void> {
    this.closeSurface();
    clearTimeout(this.pollTimer);
    return Promise.resolve();
  }

  private async poll(): Promise<void> {
    if (this.closing) return;
    try {
      const info = await stat(this.options.path);
      if (!info.isFile()) throw new Error("path is not a regular file");
      const identity = `${info.dev}:${info.ino}`;
      if (identity !== this.identity) {
        if (this.seenFile) this.output.append(`\n--- File replaced at ${new Date().toISOString()} ---\n`);
        await this.readInitial(info.size);
        this.identity = identity;
        this.seenFile = true;
      } else if (info.size < this.position) {
        this.output.append(`\n--- File truncated at ${new Date().toISOString()} ---\n`);
        await this.readInitial(info.size);
      } else if (info.size > this.position) {
        await this.readRange(this.position, info.size);
      }
      this.status = `Following ${this.options.path} · ${new Date().toISOString()}`;
      this.scheduleRender();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        if (this.identity !== undefined) this.output.append(`\n--- File missing; waiting for replacement ---\n`);
        this.identity = undefined;
        this.position = 0;
        this.decoder = new StringDecoder("utf8");
        this.status = `Waiting for ${this.options.path}…`;
      } else {
        this.status = `Tail error: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.scheduleRender();
    } finally {
      if (!this.closing) this.pollTimer = setTimeout(() => void this.poll(), POLL_INTERVAL);
    }
  }

  private async readInitial(size: number): Promise<void> {
    this.decoder = new StringDecoder("utf8");
    const start = Math.max(0, size - READ_LIMIT);
    const bytes = await readBytes(this.options.path, start, size - start);
    let offset = 0;
    if (start > 0) while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++;
    const decoded = this.decoder.write(bytes.subarray(offset));
    const lines = decoded.split("\n");
    const selected = lines.slice(Math.max(0, lines.length - this.options.lines - (decoded.endsWith("\n") ? 1 : 0))).join("\n");
    if (!this.seenFile) this.output.reset(selected);
    else this.output.append(selected);
    this.position = size;
  }

  private async readRange(start: number, end: number): Promise<void> {
    let effectiveStart = start;
    if (end - start > READ_LIMIT) {
      effectiveStart = end - READ_LIMIT;
      this.output.append("\n--- Earlier appended data skipped ---\n");
      this.decoder = new StringDecoder("utf8");
    }
    const bytes = await readBytes(this.options.path, effectiveStart, end - effectiveStart);
    let offset = 0;
    if (effectiveStart !== start) while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++;
    this.output.append(this.decoder.write(bytes.subarray(offset)));
    this.position = end;
  }
}

async function readBytes(filePath: string, position: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
