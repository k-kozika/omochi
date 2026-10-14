export interface FanOutClient {
  send(text: string): void
  close(code: number, reason: string): void
}

/**
 * One shared A2UI stream delivered to every attached renderer.
 *
 * The replay is injected rather than owned so a single-backend bridge can hand over
 * its own snapshot while the hub composes one snapshot per discovered service.
 */
export class FanOut {
  private readonly clients = new Set<FanOutClient>()

  constructor(private readonly replay: () => Iterable<unknown>) {}

  get size(): number {
    return this.clients.size
  }

  add(client: FanOutClient): void {
    this.clients.add(client)
    for (const message of this.replay()) client.send(JSON.stringify(message))
  }

  remove(client: FanOutClient): void {
    this.clients.delete(client)
  }

  /** Broadcasts an already encoded frame so callers choose between raw and rewritten bytes. */
  broadcast(encoded: string): void {
    for (const client of this.clients) client.send(encoded)
  }

  closeAll(code: number, reason: string): void {
    for (const client of this.clients) client.close(code, reason)
  }
}
