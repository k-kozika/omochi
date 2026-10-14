import { chmod, rmdir } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

import { A2uiClientMessageSchema } from "@a2ui/web_core/v0_9";

import type { Transport } from "../transport.js";
import type { A2UIMessage, JsonObject } from "../types.js";
import {
  assertSocketPathFits,
  claimSocketPath,
  ensureServiceDirectory,
  omochiRuntimeRoot,
  removeServiceDirectory,
  removeServiceDirectorySync,
  validateServiceId,
  writeServiceManifest,
} from "./service-directory.js";
import { A2uiSnapshot } from "./snapshot.js";

export interface UnixSocketServerTransportOptions {
  /** Discovery id and directory name; must match `[A-Za-z0-9._-]{1,64}`. */
  serviceId: string;
  /** Human-readable label shown by a hub. Defaults to `serviceId`. */
  name?: string;
  /** An emoji, or a `data:image/...;base64,` URL a browser can render directly. */
  icon?: string;
  /** Defaults to `$XDG_RUNTIME_DIR/omochi`. */
  runtimeDir?: string;
  capabilities?: Iterable<string>;
}

interface PendingReceive {
  resolve(result: IteratorResult<JsonObject>): void;
  reject(error: unknown): void;
}

const SOCKET_FILE_NAME = "a2ui.sock";

/**
 * Publishes one application on a unix domain socket and advertises it for discovery.
 *
 * The transport writes `<runtimeDir>/<serviceId>/manifest.json` next to the socket so a
 * hub can find it without configuration. Reaching the socket is the authentication: the
 * runtime directory is mode 0700, so only the owning user can connect.
 *
 * Like `WebSocketServerTransport`, it fans one application out to every connected
 * renderer and merges their inbound messages into a single stream for the Runtime.
 */
export class UnixSocketServerTransport implements Transport {
  readonly capabilities: ReadonlySet<string>;
  readonly ready: Promise<void>;

  private readonly serviceId: string;
  private readonly manifestName: string;
  private readonly icon: string | undefined;
  private readonly root: string;
  private readonly server: Server = createServer();
  private readonly clients = new Set<Socket>();
  private readonly snapshot = new A2uiSnapshot();
  private readonly received: JsonObject[] = [];
  private readonly waiting: PendingReceive[] = [];
  private readonly exitCleanup: () => void;
  private resolvedDirectory: string | null = null;
  private closed = false;
  private receiveError: unknown = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: UnixSocketServerTransportOptions) {
    this.serviceId = validateServiceId(options.serviceId);
    this.manifestName = options.name ?? this.serviceId;
    this.icon = options.icon;
    this.root = options.runtimeDir ?? omochiRuntimeRoot();
    this.capabilities = new Set(options.capabilities ?? []);
    this.server.on("connection", (socket) => this.accept(socket));
    this.exitCleanup = () => {
      if (this.resolvedDirectory) removeServiceDirectorySync(this.resolvedDirectory);
    };
    process.once("exit", this.exitCleanup);
    this.ready = this.publish().catch((error: unknown) => {
      this.receiveError = error;
      this.flushReceivers();
      throw error;
    });
  }

  /** The socket path, available once `ready` resolves. */
  get socketPath(): string | null {
    return this.resolvedDirectory ? path.join(this.resolvedDirectory, SOCKET_FILE_NAME) : null;
  }

  get directory(): string | null {
    return this.resolvedDirectory;
  }

  async send(message: A2UIMessage): Promise<void> {
    this.snapshot.apply(message);
    const encoded = `${JSON.stringify(message)}\n`;
    for (const client of this.clients) {
      if (client.writable) client.write(encoded);
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
    process.off("exit", this.exitCleanup);
    const directory = this.resolvedDirectory;
    this.closePromise = (async () => {
      // Retract the advertisement before tearing the socket down.
      if (directory) await removeServiceDirectory(directory);
      for (const client of this.clients) client.destroy();
      this.clients.clear();
      if (this.server.listening) {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
      }
    })();
    return this.closePromise;
  }

  private async publish(): Promise<void> {
    const directory = await ensureServiceDirectory(this.root, this.serviceId);
    try {
      await this.listen(directory);
    } catch (error) {
      // Leave no empty directory behind for a discovery pass to walk into. `rmdir`
      // refuses a non-empty directory, so a live service's files are never touched.
      await rmdir(directory).catch(() => undefined);
      throw error;
    }
  }

  private async listen(directory: string): Promise<void> {
    const socketPath = path.join(directory, SOCKET_FILE_NAME);
    assertSocketPathFits(socketPath);
    await claimSocketPath(socketPath);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(socketPath, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    // Linux enforces unix socket permissions on connect, and listen() applies the umask.
    await chmod(socketPath, 0o600);
    this.resolvedDirectory = directory;
    const manifest = { name: this.manifestName, socket: SOCKET_FILE_NAME } as {
      name: string;
      icon?: string;
      socket: string;
    };
    if (this.icon !== undefined) manifest.icon = this.icon;
    // Advertise only once the socket accepts connections, so a readable manifest is connectable.
    await writeServiceManifest(directory, manifest);
  }

  private accept(socket: Socket): void {
    this.clients.add(socket);
    socket.setNoDelay(true);
    socket.on("error", () => this.clients.delete(socket));
    socket.on("close", () => this.clients.delete(socket));
    for (const message of this.snapshot.messages()) socket.write(`${JSON.stringify(message)}\n`);
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        const value: unknown = JSON.parse(line);
        const parsed = A2uiClientMessageSchema.safeParse(value);
        if (!parsed.success || parsed.data.version !== "v0.9") {
          throw new Error(parsed.success ? `unsupported version: ${parsed.data.version}` : "expected an A2UI v0.9 client message");
        }
        // `{error}` is a valid client message but carries no action for the Runtime to
        // invoke; dropping it keeps a client-side report from tearing the application down.
        if (!("action" in parsed.data)) return;
        this.enqueue(value as JsonObject);
      } catch {
        socket.destroy();
      }
    });
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
