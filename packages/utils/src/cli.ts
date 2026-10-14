import path from "node:path";
import { CommandButton } from "./button.js";
import { HttpWatch } from "./http.js";
import { CommandProcess, type RestartPolicy } from "./process.js";
import { Publisher } from "./publisher.js";
import { InputStream } from "./stream.js";
import { FileTail } from "./tail.js";
import { CommandWatch } from "./watch.js";

const HELP = `Usage:
  omochi-utils button [--service-id ID] [--name NAME] [--cwd DIR] -- COMMAND [ARGS...]
  omochi-utils watch [--interval 2s] [--timeout DURATION] [--diff] [--on-change] [--history N] [--cwd DIR] -- COMMAND [ARGS...]
  omochi-utils process [--restart never|on-failure|always] [--restart-delay 1s] [--cwd DIR] -- COMMAND [ARGS...]
  omochi-utils tail [--lines 100] [--service-id ID] [--name NAME] FILE
  omochi-utils stream [--service-id ID] [--name NAME]
  omochi-utils http [--interval 10s] [--timeout 10s] [--expect-status 200-299] [--expect-body TEXT] URL
  omochi-utils mcp [--service-id ID] [--name NAME]

Publish one development utility surface through the local Omochi gateway.
Commands inherit the environment and run without an implicit shell.
Durations accept ms, s, or m suffixes. Start omochi-ui hub separately.
`;

interface CommonOptions { serviceId?: string; name: string }
interface ButtonCli extends CommonOptions { mode: "button"; cwd?: string; command: string[] }
interface WatchCli extends CommonOptions { mode: "watch"; cwd?: string; command: string[]; intervalMs: number; timeoutMs?: number; diff: boolean; onChange: boolean; history?: number }
interface ProcessCli extends CommonOptions { mode: "process"; cwd?: string; command: string[]; restart: RestartPolicy; restartDelayMs: number }
interface TailCli extends CommonOptions { mode: "tail"; path: string; lines: number }
interface StreamCli extends CommonOptions { mode: "stream" }
interface HttpCli extends CommonOptions { mode: "http"; url: string; intervalMs: number; timeoutMs: number; expectStatus: readonly [number, number]; expectBody?: string }
interface McpCli extends CommonOptions { mode: "mcp" }
type Options = ButtonCli | WatchCli | ProcessCli | TailCli | StreamCli | HttpCli | McpCli;

function parse(args: string[]): Options | null {
  if (!args.length || ["--help", "-h", "help"].includes(args[0]!)) return null;
  const mode = args[0]!;
  const rest = args.slice(1);
  if (!["button", "watch", "process", "tail", "stream", "http", "mcp"].includes(mode)) throw new Error(`unknown command: ${mode}`);
  if (rest.includes("--help") || rest.includes("-h")) return null;

  const common: CommonOptions = { name: defaultName(mode) };
  let cwd: string | undefined;
  let intervalMs = mode === "http" ? 10_000 : 2_000;
  let timeoutMs: number | undefined = mode === "http" ? 10_000 : undefined;
  let diff = false;
  let onChange = false;
  let history: number | undefined;
  let restart: RestartPolicy = "never";
  let restartDelayMs = 1000;
  let lines = 100;
  let expectStatus: readonly [number, number] = [200, 299];
  let expectBody: string | undefined;
  const positional: string[] = [];
  let command: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--") {
      command = rest.slice(i + 1);
      break;
    }
    const value = () => {
      const found = rest[++i];
      if (found === undefined) throw new Error(`missing value for ${arg}`);
      return found;
    };
    if (arg === "--service-id") common.serviceId = value();
    else if (arg === "--name") common.name = value();
    else if (arg === "--cwd" && ["button", "watch", "process"].includes(mode)) cwd = path.resolve(value());
    else if (arg === "--interval" && ["watch", "http"].includes(mode)) intervalMs = parseDuration(value(), arg);
    else if (arg === "--timeout" && ["watch", "http"].includes(mode)) timeoutMs = parseDuration(value(), arg);
    else if (arg === "--diff" && mode === "watch") diff = true;
    else if (arg === "--on-change" && mode === "watch") onChange = true;
    else if (arg === "--history" && mode === "watch") history = parseInteger(value(), arg, 1, 100);
    else if (arg === "--restart" && mode === "process") {
      const policy = value();
      if (!["never", "on-failure", "always"].includes(policy)) throw new Error("--restart must be never, on-failure, or always");
      restart = policy as RestartPolicy;
    } else if (arg === "--restart-delay" && mode === "process") restartDelayMs = parseDuration(value(), arg);
    else if (arg === "--lines" && mode === "tail") lines = parseInteger(value(), arg, 1, Number.MAX_SAFE_INTEGER);
    else if (arg === "--expect-status" && mode === "http") expectStatus = parseStatus(value());
    else if (arg === "--expect-body" && mode === "http") expectBody = value();
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }

  if (["button", "watch", "process"].includes(mode)) {
    if (!command.length) throw new Error(`${mode} requires -- followed by a command`);
    if (positional.length) throw new Error(`unexpected argument: ${positional[0]}`);
  } else if (command.length || rest.includes("--")) throw new Error(`${mode} does not accept a command after --`);

  if (mode === "button") return { ...common, mode, cwd, command };
  if (mode === "watch") return { ...common, mode, cwd, command, intervalMs, timeoutMs, diff, onChange, history };
  if (mode === "process") return { ...common, mode, cwd, command, restart, restartDelayMs };
  if (mode === "tail") {
    if (positional.length !== 1) throw new Error("tail requires exactly one file path");
    const filePath = path.resolve(positional[0]!);
    if (common.name === "Tail") common.name = path.basename(filePath);
    return { ...common, mode, path: filePath, lines };
  }
  if (mode === "stream") {
    if (positional.length) throw new Error(`unexpected argument: ${positional[0]}`);
    return { ...common, mode };
  }
  if (mode === "http") {
    if (positional.length !== 1) throw new Error("http requires exactly one URL");
    const url = new URL(positional[0]!);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("http URL must use http or https");
    if (common.name === "HTTP") common.name = url.host;
    return { ...common, mode, url: url.toString(), intervalMs, timeoutMs: timeoutMs!, expectStatus, expectBody };
  }
  if (positional.length) throw new Error(`unexpected argument: ${positional[0]}`);
  return { ...common, mode: "mcp" };
}

function defaultName(mode: string): string {
  return ({ button: "Command", watch: "Watch", process: "Process", tail: "Tail", stream: "Stream", http: "HTTP", mcp: "Agent" } as Record<string, string>)[mode]!;
}

function parseDuration(value: string, option: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(value);
  if (!match) throw new Error(`${option} must be a positive duration such as 250ms, 2s, or 1m`);
  const multiplier = match[2] === "ms" ? 1 : match[2] === "s" ? 1000 : 60_000;
  const milliseconds = Number(match[1]) * multiplier;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647) throw new Error(`${option} is out of range`);
  const rounded = Math.round(milliseconds);
  if (rounded <= 0) throw new Error(`${option} is out of range`);
  return rounded;
}

function parseInteger(value: string, option: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`${option} must be an integer between ${minimum} and ${maximum}`);
  return number;
}

function parseStatus(value: string): readonly [number, number] {
  const match = /^(\d{3})(?:-(\d{3}))?$/.exec(value);
  if (!match) throw new Error("--expect-status must be a status code or range such as 200-299");
  const minimum = Number(match[1]);
  const maximum = Number(match[2] ?? match[1]);
  if (minimum < 100 || maximum > 599 || minimum > maximum) throw new Error("--expect-status must be an ordered range between 100 and 599");
  return [minimum, maximum];
}

async function main(): Promise<void> {
  let options: Options | null;
  try { options = parse(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (!options) { process.stdout.write(HELP); return; }

  let publisher: Publisher | undefined;
  let utility: { start(): Promise<void>; close(): Promise<void> } | undefined;
  let mcp: { close(): Promise<void> } | undefined;
  let shutdown: Promise<void> | undefined;
  let stopped = false;
  const close = (): Promise<void> => {
    stopped = true;
    if (shutdown) return shutdown;
    shutdown = (async () => {
      publisher?.events.close();
      await utility?.close();
      await publisher?.close();
      await mcp?.close();
    })();
    return shutdown;
  };
  const stop = () => { void close().catch(reportError); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    publisher = await Publisher.open({ serviceId: options.serviceId, name: options.name });
    if (stopped) { await publisher.close(); return; }
    if (options.mode === "mcp") {
      const { startMcp } = await import("./mcp.js");
      process.stdin.once("end", stop);
      mcp = await startMcp(publisher, stop);
      if (stopped) await mcp.close();
    } else {
      if (options.mode === "button") utility = new CommandButton(publisher, options);
      if (options.mode === "watch") utility = new CommandWatch(publisher, options);
      if (options.mode === "process") utility = new CommandProcess(publisher, options);
      if (options.mode === "tail") utility = new FileTail(publisher, options);
      if (options.mode === "stream") utility = new InputStream(publisher, options);
      if (options.mode === "http") utility = new HttpWatch(publisher, options);
      await utility!.start();
    }
    if (!stopped) process.stderr.write(`Published service ${publisher.serviceId} (${options.name})\n`);
  } catch (error) {
    reportError(error);
    await close();
  }
}

function reportError(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

void main().catch(reportError);
