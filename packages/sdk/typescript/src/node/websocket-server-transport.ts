import { createServer, type Server } from "node:http";

import { A2uiClientMessageSchema } from "@a2ui/web_core/v0_9";
import { WebSocket, WebSocketServer } from "ws";

import type { Transport } from "../transport.js";
import type { A2UIMessage, JsonObject } from "../types.js";
import { A2uiSnapshot } from "./snapshot.js";

export interface WebSocketServerTransportOptions {
  port: number;
  host?: string;
  path?: string;
  capabilities?: Iterable<string>;
}

interface PendingReceive {
  resolve(result: IteratorResult<JsonObject>): void;
  reject(error: unknown): void;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return;
  let safeReason = "";
  for (const character of reason) {
    if (Buffer.byteLength(safeReason + character) > 123) break;
    safeReason += character;
  }
  socket.close(code, safeReason);
}

function displayHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export class WebSocketServerTransport implements Transport {
  readonly capabilities: ReadonlySet<string>;
  readonly ready: Promise<void>;

  private readonly host: string;
  private readonly path: string;
  private readonly httpServer: Server;
  private readonly webSocketServer = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<WebSocket>();
  private readonly snapshot = new A2uiSnapshot();
  private readonly received: JsonObject[] = [];
  private readonly waiting: PendingReceive[] = [];
  private closed = false;
  private receiveError: unknown = null;
  private closePromise: Promise<void> | null = null;
  private resolvedUrl: string | null = null;

  constructor(options: WebSocketServerTransportOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new RangeError("port must be an integer between 0 and 65535");
    }
    this.host = options.host ?? "127.0.0.1";
    this.path = options.path ?? "/ws";
    if (!this.path.startsWith("/")) throw new TypeError("path must start with /");
    this.capabilities = new Set(options.capabilities ?? []);
    this.httpServer = createServer((_request, response) => response.writeHead(404).end("Not found"));

    this.httpServer.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname !== this.path) {
        socket.destroy();
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit("connection", webSocket, request);
      });
    });
    this.webSocketServer.on("connection", (socket) => this.accept(socket));

    this.ready = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.receiveError = error;
        this.flushReceivers();
        reject(error);
      };
      this.httpServer.once("error", onError);
      this.httpServer.listen(options.port, this.host, () => {
        this.httpServer.off("error", onError);
        const address = this.httpServer.address();
        if (!address || typeof address === "string") {
          const error = new Error("failed to resolve WebSocket server address");
          this.receiveError = error;
          this.flushReceivers();
          reject(error);
          return;
        }
        this.resolvedUrl = `ws://${displayHost(this.host)}:${address.port}${this.path}`;
        resolve();
      });
    });
  }

  get url(): string | null {
    return this.resolvedUrl;
  }

  async send(message: A2UIMessage): Promise<void> {
    this.snapshot.apply(message);
    const encoded = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(encoded);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JsonObject> {
    await this.ready;
    while (true) {
      const result = await this.nextMessage();
      if (result.done) return;
      yield result.value;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.flushReceivers();
    for (const client of this.clients) closeSocket(client, 1001, "server shutting down");
    this.closePromise = Promise.all([
      new Promise<void>((resolve) => this.webSocketServer.close(() => resolve())),
      new Promise<void>((resolve) => {
        if (!this.httpServer.listening) {
          resolve();
          return;
        }
        this.httpServer.close(() => resolve());
      }),
    ]).then(() => undefined);
    return this.closePromise;
  }

  private accept(socket: WebSocket): void {
    this.clients.add(socket);
    for (const message of this.snapshot.messages()) socket.send(JSON.stringify(message));
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        closeSocket(socket, 1003, "expected a text JSON message");
        return;
      }
      try {
        const value: unknown = JSON.parse(data.toString());
        const parsed = A2uiClientMessageSchema.safeParse(value);
        if (!parsed.success || parsed.data.version !== "v0.9" || !("action" in parsed.data)) {
          throw new Error(parsed.success ? `unsupported version: ${parsed.data.version}` : "expected an A2UI v0.9 client message");
        }
        this.enqueue(value as JsonObject);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        closeSocket(socket, 1007, `invalid JSON: ${detail}`);
      }
    });
    socket.on("close", () => this.clients.delete(socket));
  }

  private enqueue(message: JsonObject): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve({ value: message, done: false });
    else this.received.push(message);
  }

  private nextMessage(): Promise<IteratorResult<JsonObject>> {
    const message = this.received.shift();
    if (message) return Promise.resolve({ value: message, done: false });
    if (this.receiveError) return Promise.reject(this.receiveError);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  private flushReceivers(): void {
    for (const waiter of this.waiting.splice(0)) {
      if (this.receiveError) waiter.reject(this.receiveError);
      else waiter.resolve({ value: undefined, done: true });
    }
  }
}
