import type { JsonObject } from "@omochi-ui/sdk";

export interface SurfaceEvent {
  sequence: number;
  receivedAt: string;
  message: JsonObject;
}

/** A cursor is a sequence number, not an acknowledgement: reads are repeatable. */
export class EventBuffer {
  private readonly events: SurfaceEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private sequence = 0;
  private closed = false;

  constructor(private readonly capacity = 1000) {}

  push(message: JsonObject): void {
    if (this.closed) return;
    this.events.push({ sequence: ++this.sequence, receivedAt: new Date().toISOString(), message: structuredClone(message) });
    if (this.events.length > this.capacity) this.events.shift();
    for (const wake of this.waiters) wake();
  }

  async read(after = 0, timeoutMs = 0, signal?: AbortSignal) {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence) throw new Error("after must be an existing cursor (or 0)");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) throw new Error("timeoutMs must be between 0 and 30000");
    signal?.throwIfAborted();
    if (!this.closed && this.sequence === after && timeoutMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          signal?.removeEventListener("abort", abort);
        };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal?.reason ?? new Error("cancelled")); };
        const timer = setTimeout(wake, timeoutMs);
        this.waiters.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    signal?.throwIfAborted();
    const oldest = this.events[0]?.sequence ?? this.sequence + 1;
    return {
      events: structuredClone(this.events.filter((event) => event.sequence > after)),
      nextCursor: this.sequence,
      dropped: Math.max(0, oldest - after - 1),
      closed: this.closed,
    };
  }

  close(): void {
    this.closed = true;
    for (const wake of this.waiters) wake();
  }
}
