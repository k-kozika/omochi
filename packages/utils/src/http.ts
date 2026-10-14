import { Action, type UI } from "@omochi-ui/sdk";
import { StringDecoder } from "node:string_decoder";
import { OutputBuffer, fenced, formatDuration } from "./output.js";
import { Publisher } from "./publisher.js";
import { UtilitySurface } from "./surface.js";

const BODY_LIMIT = 64 * 1024;

export interface HttpOptions {
  url: string;
  name: string;
  intervalMs: number;
  timeoutMs: number;
  expectStatus: readonly [number, number];
  expectBody?: string;
  fetch?: typeof fetch;
}

export class HttpWatch extends UtilitySurface {
  private readonly fetcher: typeof fetch;
  private readonly body = new OutputBuffer();
  private interval?: NodeJS.Timeout;
  private controller?: AbortController;
  private running = false;
  private paused = false;
  private status = "Starting…";
  private metadata = "";
  private consecutiveFailures = 0;
  private lastHealthy?: boolean;
  private transition = "No previous result";

  constructor(publisher: Publisher, private readonly options: HttpOptions) {
    super(publisher, options.name);
    this.fetcher = options.fetch ?? fetch;
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
    if (this.metadata) ui.text(this.metadata, { key: "metadata" });
    if (this.body.text) ui.text(fenced(this.body.text, this.body.truncated), { key: "body" });
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
    this.closeSurface();
    clearTimeout(this.interval);
    this.controller?.abort();
    return Promise.resolve();
  }

  private async run(): Promise<void> {
    if (this.running || this.closing) return;
    this.running = true;
    this.status = "Requesting…";
    this.scheduleRender();
    const startedAt = performance.now();
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(new Error("request timed out")), this.options.timeoutMs);
    let healthy = false;
    try {
      const response = await this.fetcher(this.options.url, { signal: controller.signal, redirect: "follow" });
      const durationMs = performance.now() - startedAt;
      const contentType = response.headers.get("content-type") ?? "unknown";
      const contentLength = response.headers.get("content-length");
      const textual = isText(contentType);
      let rawBody = "";
      let bodyTruncated = false;
      let expectedBodyMatched = this.options.expectBody === undefined;
      if (textual) {
        const read = await readText(response, BODY_LIMIT, this.options.expectBody);
        rawBody = read.text;
        bodyTruncated = read.truncated;
        expectedBodyMatched = read.expectedMatched;
        let display = rawBody;
        if (isJson(contentType) && !bodyTruncated) {
          try { display = JSON.stringify(JSON.parse(rawBody), null, 2); }
          catch { display = `Invalid JSON response\n\n${rawBody}`; }
        }
        this.body.reset(display);
        if (bodyTruncated) this.body.append("\n\n[Response body truncated]");
      } else {
        await response.body?.cancel();
        this.body.reset();
      }
      const statusMatches = response.status >= this.options.expectStatus[0] && response.status <= this.options.expectStatus[1];
      const bodyMatches = textual && expectedBodyMatched || this.options.expectBody === undefined;
      healthy = statusMatches && bodyMatches;
      this.status = `${healthy ? "Healthy" : "Unhealthy"} · HTTP ${response.status} · ${formatDuration(durationMs)} · ${new Date().toISOString()}`;
      this.metadata = [
        `URL: ${response.url}`,
        `Content-Type: ${contentType}`,
        `Size: ${contentLength ? `${contentLength} bytes` : textual && !bodyTruncated ? `${Buffer.byteLength(rawBody)} bytes` : "unknown"}`,
        `Expectation: status ${this.options.expectStatus[0]}${this.options.expectStatus[0] === this.options.expectStatus[1] ? "" : `–${this.options.expectStatus[1]}`}${this.options.expectBody === undefined ? "" : ` and body contains ${JSON.stringify(this.options.expectBody)}`}`,
      ].join("  \n");
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      const message = controller.signal.aborted && controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : error instanceof Error ? error.message : String(error);
      this.status = `Unhealthy · ${message} · ${formatDuration(durationMs)} · ${new Date().toISOString()}`;
      this.metadata = `URL: ${this.options.url}`;
      this.body.reset();
    } finally {
      clearTimeout(timeout);
      this.controller = undefined;
      this.running = false;
    }
    if (healthy) this.consecutiveFailures = 0;
    else this.consecutiveFailures++;
    if (this.lastHealthy === undefined) this.transition = healthy ? "Initial result: healthy" : "Initial result: unhealthy";
    else if (this.lastHealthy !== healthy) this.transition = healthy ? "Recovered" : "Became unhealthy";
    this.lastHealthy = healthy;
    this.metadata += `  \nConsecutive failures: ${this.consecutiveFailures}  \nState: ${this.transition}`;
    this.scheduleRender();
    if (!this.paused && !this.closing) this.interval = setTimeout(() => void this.run(), this.options.intervalMs);
  }
}

function isJson(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function isText(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType.startsWith("text/") || isJson(contentType) || ["application/javascript", "application/xml", "application/x-www-form-urlencoded"].includes(mediaType) || mediaType.endsWith("+xml");
}

async function readText(response: Response, limit: number, expected?: string): Promise<{ text: string; truncated: boolean; expectedMatched: boolean }> {
  if (!response.body) return { text: "", truncated: false, expectedMatched: expected === undefined || expected === "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const matcher = new TextDecoder();
  let visibleLength = 0;
  let totalLength = 0;
  let truncated = false;
  let expectedMatched = expected === undefined || expected === "";
  let matchTail = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (expected !== undefined && !expectedMatched) expectedMatched = (matchTail + matcher.decode()).includes(expected);
      break;
    }
    totalLength += value.length;
    if (visibleLength < limit) {
      const visible = value.subarray(0, Math.min(value.length, limit - visibleLength));
      chunks.push(visible);
      visibleLength += visible.length;
    }
    if (expected !== undefined && !expectedMatched) {
      const searchable = matchTail + matcher.decode(value, { stream: true });
      expectedMatched = searchable.includes(expected);
      matchTail = searchable.slice(-Math.max(0, expected.length - 1));
    }
    if (totalLength > limit) {
      truncated = true;
      if (expected === undefined || expectedMatched) {
        await reader.cancel();
        break;
      }
    }
  }
  const visible = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), visibleLength);
  return { text: new StringDecoder("utf8").write(visible), truncated, expectedMatched };
}
