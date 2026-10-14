import { Action, type UI } from "@omochi-ui/sdk";
import { ManagedCommand, describeResult, type CommandResult } from "./command.js";
import { OutputBuffer, fenced } from "./output.js";
import { Publisher } from "./publisher.js";
import { UtilitySurface } from "./surface.js";

export type RestartPolicy = "never" | "on-failure" | "always";

export interface ProcessOptions {
  command: string[];
  cwd?: string;
  name: string;
  restart: RestartPolicy;
  restartDelayMs: number;
}

export class CommandProcess extends UtilitySurface {
  private readonly output = new OutputBuffer();
  private readonly runner: ManagedCommand;
  private running = false;
  private status = "Stopped";
  private restartCount = 0;
  private suppressRestart = false;
  private restartTimer?: NodeJS.Timeout;
  private control: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;

  constructor(publisher: Publisher, private readonly options: ProcessOptions) {
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
    ui.row({ key: "controls" }, () => {
      if (this.running) {
        ui.button("Stop", new Action("stop").call(null), { key: "stop" });
        ui.button("Restart", new Action("restart").call(null), { key: "restart", variant: "primary" });
      } else {
        ui.button("Start", new Action("start").call(null), { key: "start", variant: "primary" });
      }
    });
    ui.text(`${this.status} · automatic restarts: ${this.restartCount}`, { key: "status" });
    ui.text(fenced(this.output.text, this.output.truncated), { key: "output" });
  }

  protected onAction(name: string): void {
    if (name === "start") this.enqueue(async () => this.launch(false));
    if (name === "stop") this.enqueue(() => this.stop());
    if (name === "restart") this.enqueue(() => this.restart());
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeSurface();
    this.suppressRestart = true;
    clearTimeout(this.restartTimer);
    this.closePromise = (async () => {
      await this.control;
      await this.runner.close();
    })();
    return this.closePromise;
  }

  private enqueue(operation: () => Promise<void> | void): void {
    this.control = this.control.then(operation).catch((error: unknown) => {
      this.status = `Control failed: ${error instanceof Error ? error.message : String(error)}`;
      this.scheduleRender();
    });
  }

  private launch(automatic: boolean): void {
    if (this.running || this.closing) return;
    clearTimeout(this.restartTimer);
    this.suppressRestart = false;
    this.running = true;
    if (automatic) this.restartCount++;
    this.output.append(`\n--- ${automatic ? "Automatically restarted" : "Started"} at ${new Date().toISOString()} ---\n`);
    this.status = "Running…";
    this.scheduleRender();
    void this.runner.start().then((result) => this.exited(result));
  }

  private async stop(): Promise<void> {
    this.suppressRestart = true;
    clearTimeout(this.restartTimer);
    if (this.running) await this.runner.stop();
    this.status = "Stopped";
    this.scheduleRender();
  }

  private async restart(): Promise<void> {
    this.suppressRestart = true;
    clearTimeout(this.restartTimer);
    if (this.running) await this.runner.stop();
    this.suppressRestart = false;
    this.launch(false);
  }

  private exited(result: CommandResult): void {
    this.running = false;
    const description = describeResult(result);
    this.output.append(`\n--- ${description} at ${new Date().toISOString()} ---\n`);
    this.status = description;
    this.scheduleRender();
    if (this.closing || this.suppressRestart || !shouldRestart(this.options.restart, result)) return;
    this.status = `${description} · restarting soon…`;
    this.restartTimer = setTimeout(() => this.launch(true), this.options.restartDelayMs);
  }
}

function shouldRestart(policy: RestartPolicy, result: CommandResult): boolean {
  if (policy === "never") return false;
  if (policy === "always") return true;
  return Boolean(result.error || result.signal || result.code !== 0);
}
