import { createInterface } from "node:readline";
import type { A2UIMessage, JsonObject } from "./types.js";

export interface Transport extends AsyncIterable<JsonObject> {
  readonly capabilities: ReadonlySet<string>;
  send(message: A2UIMessage): Promise<void>;
}

export class StdioTransport implements Transport {
  readonly capabilities: ReadonlySet<string>;

  constructor(capabilities: Iterable<string> = []) {
    this.capabilities = new Set(capabilities);
  }

  async send(message: A2UIMessage): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JsonObject> {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim()) yield JSON.parse(line) as JsonObject;
    }
  }
}

export interface WebSocketLike extends AsyncIterable<string | Uint8Array> {
  send(data: string): unknown | Promise<unknown>;
}

export class WebSocketTransport implements Transport {
  readonly capabilities: ReadonlySet<string>;

  constructor(private readonly socket: WebSocketLike, capabilities: Iterable<string> = []) {
    this.capabilities = new Set(capabilities);
  }

  async send(message: A2UIMessage): Promise<void> {
    await this.socket.send(JSON.stringify(message));
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JsonObject> {
    for await (const message of this.socket) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      yield JSON.parse(text) as JsonObject;
    }
  }
}

export class CallbackTransport implements Transport {
  readonly capabilities: ReadonlySet<string>;

  constructor(
    private readonly sender: (message: A2UIMessage) => Promise<void>,
    private readonly receiver: () => AsyncIterable<JsonObject>,
    capabilities: Iterable<string> = [],
  ) {
    this.capabilities = new Set(capabilities);
  }

  send(message: A2UIMessage): Promise<void> {
    return this.sender(message);
  }

  [Symbol.asyncIterator](): AsyncIterator<JsonObject> {
    return this.receiver()[Symbol.asyncIterator]();
  }
}
