import { Action, type UI } from "@omochi-ui/sdk";
import { ManagedCommand, describeResult } from "./command.js";
import { OutputBuffer, fenced } from "./output.js";
import { Publisher } from "./publisher.js";
import { UtilitySurface } from "./surface.js";

export interface ButtonOptions {
  command: string[];
  cwd?: string;
  name: string;
}

export class CommandButton extends UtilitySurface {
  private readonly output = new OutputBuffer();
  private readonly runner: ManagedCommand;
  private running = false;
  private status = "Ready";
  private closePromise?: Promise<void>;

  constructor(publisher: Publisher, options: ButtonOptions) {
    super(publisher, options.name);
    this.runner = new ManagedCommand({
      command: options.command,
      cwd: options.cwd,
      onData: (chunk) => {
        this.output.append(chunk);
        this.scheduleRender();
      },
    });
  }

  protected build(ui: UI): void {
    ui.text(this.name, { key: "title", variant: "h3" });
    if (!this.running) ui.button("Run", new Action("run").call(null), { key: "run", variant: "primary" });
    ui.text(this.status, { key: "status" });
    ui.text(fenced(this.output.text, this.output.truncated), { key: "output" });
  }

  protected onAction(name: string): void {
    if (name !== "run" || this.running || this.closing) return;
    void this.run();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeSurface();
    this.closePromise = this.runner.close();
    return this.closePromise;
  }

  private async run(): Promise<void> {
    this.running = true;
    this.output.reset();
    this.status = "Running…";
    this.scheduleRender();
    const result = await this.runner.start();
    this.running = false;
    this.status = describeResult(result);
    this.scheduleRender();
  }
}
