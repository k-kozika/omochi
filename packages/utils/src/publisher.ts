import { randomUUID } from "node:crypto";
import { A2uiSnapshot } from "@omochi-ui/core";
import type { A2UIMessage, JsonObject } from "@omochi-ui/sdk";
import { UnixSocketServerTransport, type UnixSocketServerTransportOptions } from "@omochi-ui/sdk/node";
import { EventBuffer } from "./events.js";

export type PublisherOptions = Omit<UnixSocketServerTransportOptions, "serviceId"> & { serviceId?: string };

export class Publisher {
  readonly serviceId: string;
  readonly transport: UnixSocketServerTransport;
  readonly events = new EventBuffer();
  private snapshot = new A2uiSnapshot();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly receiver: Promise<void>;
  private readonly listeners = new Set<(message: JsonObject) => void>();

  private constructor(options: PublisherOptions) {
    this.serviceId = options.serviceId ?? `utils-${randomUUID()}`;
    this.transport = new UnixSocketServerTransport({ ...options, serviceId: this.serviceId });
    this.receiver = this.receive();
    // Startup failure is reported by open(); don't leave a second rejected promise.
    void this.receiver.catch(() => undefined);
  }

  static async open(options: PublisherOptions = {}): Promise<Publisher> {
    const publisher = new Publisher(options);
    try {
      await publisher.transport.ready;
      return publisher;
    } catch (error) {
      await publisher.close();
      throw error;
    }
  }

  onAction(listener: (message: JsonObject) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  list() {
    const surfaceIds = this.snapshot.messages().flatMap((message) => "createSurface" in message ? [message.createSurface.surfaceId] : []);
    return { serviceId: this.serviceId, surfaceIds };
  }

  publish(messages: unknown[]): Promise<{ accepted: number; serviceId: string; surfaceIds: string[] }> {
    const batch = structuredClone(messages);
    const work = this.queue.then(async () => {
      if (this.closing) throw new Error("publisher is closed");
      if (!batch.length) throw new Error("messages must not be empty");
      // Validate against a disposable snapshot so a bad batch cannot partly publish.
      const candidate = new A2uiSnapshot();
      for (const message of this.snapshot.messages()) candidate.apply(message);
      for (const [index, message] of batch.entries()) {
        try {
          assertSafeDataPath(message);
          candidate.apply(message);
        } catch (error) {
          throw new Error(`messages[${index}]: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const message of batch) await this.transport.send(message as A2UIMessage);
      this.snapshot = candidate;
      return { accepted: batch.length, ...this.list() };
    });
    this.queue = work.catch(() => undefined);
    return work;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.events.close();
    this.closePromise = (async () => {
      await this.queue;
      await this.transport.close();
      await this.receiver.catch(() => undefined);
    })();
    return this.closePromise;
  }

  private async receive(): Promise<void> {
    for await (const message of this.transport) {
      if (this.closing) break;
      this.events.push(message);
      for (const listener of this.listeners) listener(message);
    }
  }
}

// Snapshot traversal must not follow JavaScript prototype properties from raw input.
function assertSafeDataPath(message: unknown): void {
  if (!message || typeof message !== "object" || !("updateDataModel" in message)) return;
  const update = message.updateDataModel;
  if (!update || typeof update !== "object" || !("path" in update) || typeof update.path !== "string") return;
  const parts = update.path.split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.some((part) => ["__proto__", "constructor", "prototype"].includes(part))) throw new Error("unsafe data model path");
}
