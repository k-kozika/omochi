import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface CommandOptions {
  command: string[];
  cwd?: string;
  onData?: (chunk: string) => void;
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  timedOut: boolean;
  durationMs: number;
}

export class ManagedCommand {
  private child?: ChildProcess;
  private readonly processGroups = new Set<number>();
  private running?: Promise<CommandResult>;
  private termination?: Promise<void>;
  private timedOut = false;
  private timeout?: NodeJS.Timeout;

  constructor(private readonly options: CommandOptions) {
    if (!options.command.length) throw new Error("a command is required after --");
  }

  get active(): boolean { return this.running !== undefined; }

  start(timeoutMs?: number): Promise<CommandResult> {
    if (this.running) throw new Error("command is already running");
    this.timedOut = false;
    this.termination = undefined;
    const [command, ...args] = this.options.command;
    const startedAt = performance.now();
    const child = spawn(command!, args, {
      cwd: this.options.cwd,
      env: process.env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    if (child.pid !== undefined) this.processGroups.add(child.pid);
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => this.options.onData?.(chunk));
    }
    this.running = new Promise<CommandResult>((resolve) => {
      child.once("close", (code, signal) => {
        clearTimeout(this.timeout);
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") this.processGroups.delete(child.pid);
          }
        }
        const result = { code, signal, error: spawnError, timedOut: this.timedOut, durationMs: performance.now() - startedAt };
        this.child = undefined;
        this.running = undefined;
        resolve(result);
      });
    });
    if (timeoutMs !== undefined) {
      this.timeout = setTimeout(() => {
        this.timedOut = true;
        void this.stop();
      }, timeoutMs);
    }
    return this.running;
  }

  stop(): Promise<void> {
    if (!this.running && !this.processGroups.size) return Promise.resolve();
    if (this.termination) return this.termination;
    const running = this.running;
    this.termination = (async () => {
      this.signalGroups("SIGTERM");
      if (running) await Promise.race([running, delay(1000)]);
      else await delay(1000);
      this.signalGroups("SIGKILL");
      if (running) await running;
    })();
    return this.termination;
  }

  close(): Promise<void> {
    clearTimeout(this.timeout);
    return this.stop();
  }

  private signalGroups(signal: NodeJS.Signals): void {
    for (const group of this.processGroups) {
      try { process.kill(-group, signal); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") this.processGroups.delete(group);
        else this.child?.kill(signal);
      }
    }
  }
}

export function describeResult(result: CommandResult): string {
  if (result.error) return `Failed to start: ${result.error.message}`;
  if (result.timedOut) return "Timed out";
  if (result.signal) return `Stopped by ${result.signal}`;
  return `Exited with code ${result.code}`;
}
