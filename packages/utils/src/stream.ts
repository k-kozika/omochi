import type { Readable } from "node:stream";
import type { UI } from "@omochi-ui/sdk";
import { OutputBuffer, fenced } from "./output.js";
import { Publisher } from "./publisher.js";
import { UtilitySurface } from "./surface.js";

export interface StreamOptions {
  name: string;
  input?: Readable;
}

export class InputStream extends UtilitySurface {
  private readonly output = new OutputBuffer();
  private readonly input: Readable;
  private status = "Reading input…";

  constructor(publisher: Publisher, options: StreamOptions) {
    super(publisher, options.name);
    this.input = options.input ?? process.stdin;
  }

  override async start(): Promise<void> {
    await super.start();
    void this.consume();
  }

  protected build(ui: UI): void {
    ui.text(this.name, { key: "title", variant: "h3" });
    ui.text(this.status, { key: "status" });
    ui.text(fenced(this.output.text, this.output.truncated), { key: "output" });
  }

  close(): Promise<void> {
    this.closeSurface();
    this.input.pause();
    return Promise.resolve();
  }

  private async consume(): Promise<void> {
    this.input.setEncoding("utf8");
    try {
      for await (const chunk of this.input) {
        if (this.closing) break;
        this.output.append(String(chunk));
        this.scheduleRender();
      }
      if (!this.closing) {
        this.status = "Input closed";
        this.scheduleRender();
      }
    } catch (error) {
      if (!this.closing) {
        this.status = `Input error: ${error instanceof Error ? error.message : String(error)}`;
        this.scheduleRender();
      }
    }
  }
}
