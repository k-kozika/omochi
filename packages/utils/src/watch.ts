import { Action, type UI } from "@omochi-ui/sdk";
import { createTwoFilesPatch } from "diff";
import { ManagedCommand, describeResult, type CommandResult } from "./command.js";
import { OutputBuffer, fenced, formatDuration } from "./output.js";
import { Publisher } from "./publisher.js";
import { UtilitySurface } from "./surface.js";

export interface WatchOptions {
  command: string[];
  cwd?: string;
  name: string;
  intervalMs: number;
  timeoutMs?: number;
  diff: boolean;
  onChange: boolean;
  history?: number;
}

interface HistoryEntry {
  at: string;
  durationMs: number;
  result: string;
  changed: boolean;
}

export class CommandWatch extends UtilitySurface {
  private readonly current = new OutputBuffer();
  private readonly runner: ManagedCommand;
  private readonly entries: HistoryEntry[] = [];
  private interval?: NodeJS.Timeout;
  private running = false;
  private paused = false;
  private status = "Starting…";
  private displayedOutput = "";
  private displayedTruncated = false;
  private difference = "";
  private differencePlaceholder = "No previous run.";
  private differenceTruncated = false;
  private previousOutput?: string;
  private previousKey?: string;
  private closePromise?: Promise<void>;

  constructor(publisher: Publisher, private readonly options: WatchOptions) {
    super(publisher, options.name);
    this.runner = new ManagedCommand({
      command: options.command,
      cwd: options.cwd,
      onData: (chunk) => {
        this.current.append(chunk);
        if (!options.onChange) {
          this.displayedOutput = this.current.text;
          this.displayedTruncated = this.current.truncated;
          this.scheduleRender();
        }
      },
    });
  }

  override async start(): Promise<void> {
    await super.start();
    void this.run();
  }

  protected build(ui: UI): void {
    ui.text(this.name, { key: "title", variant: "h3" });
    ui.row({ key: "controls" }, () => {
      if (this.paused) ui.button("Resume", new Action("resume").call(null), { key: "resume", variant: "primary" });
      else ui.button("Pause", new Action("pause").call(null), { key: "pause" });
      if (!this.running) ui.button("Run now", new Action("run").call(null), { key: "run" });
    });
    ui.text(`${this.status}${this.paused ? " · Paused" : ""}`, { key: "status" });
    ui.text(fenced(this.displayedOutput, this.displayedTruncated), { key: "output" });
    if (this.options.diff) {
      ui.text("Changes since previous run", { key: "diff-title", variant: "h4" });
      ui.text(fenced(this.difference || this.differencePlaceholder, this.differenceTruncated), { key: "diff" });
    }
    if (this.options.history && this.entries.length) {
      ui.text("History", { key: "history-title", variant: "h4" });
      ui.text(this.entries.map((entry) =>
        `- ${entry.at} · ${entry.result} · ${formatDuration(entry.durationMs)} · ${entry.changed ? "changed" : "unchanged"}`,
      ).join("\n"), { key: "history" });
    }
  }

  protected onAction(name: string): void {
    if (name === "pause" && !this.paused) {
      this.paused = true;
      clearTimeout(this.interval);
      this.scheduleRender();
    } else if (name === "resume" && this.paused) {
      this.paused = false;
      this.scheduleRender();
      if (!this.running) void this.run();
    } else if (name === "run" && !this.running) {
      clearTimeout(this.interval);
      void this.run();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeSurface();
    clearTimeout(this.interval);
    this.closePromise = this.runner.close();
    return this.closePromise;
  }

  private async run(): Promise<void> {
    if (this.running || this.closing) return;
    this.running = true;
    this.current.reset();
    if (!this.options.onChange) {
      this.status = "Running…";
      this.displayedOutput = "";
      this.displayedTruncated = false;
      this.scheduleRender();
    }
    const result = await this.runner.start(this.options.timeoutMs);
    const output = this.current.text;
    const key = `${resultKey(result)}\0${output}`;
    const changed = this.previousKey === undefined || key !== this.previousKey;
    const difference = new OutputBuffer();
    const hadPrevious = this.previousOutput !== undefined;
    difference.reset(hadPrevious ? createTwoFilesPatch("previous", "current", this.previousOutput!, output, "", "", { context: 3 }) : "");
    this.difference = difference.text;
    this.differenceTruncated = difference.truncated;
    this.differencePlaceholder = hadPrevious ? "No changes." : "No previous run.";
    this.previousOutput = output;
    this.previousKey = key;
    this.running = false;
    this.status = `${describeResult(result)} · ${formatDuration(result.durationMs)} · ${new Date().toISOString()}`;
    this.entries.push({ at: new Date().toISOString(), durationMs: result.durationMs, result: describeResult(result), changed });
    if (this.options.history && this.entries.length > this.options.history) this.entries.splice(0, this.entries.length - this.options.history);
    if (!this.options.onChange || changed) {
      this.displayedOutput = output;
      this.displayedTruncated = this.current.truncated;
      this.scheduleRender();
    }
    if (!this.paused && !this.closing) this.interval = setTimeout(() => void this.run(), this.options.intervalMs);
  }
}

function resultKey(result: CommandResult): string {
  return result.error ? `error:${result.error.message}` : result.timedOut ? "timeout" : result.signal ? `signal:${result.signal}` : `code:${result.code}`;
}
