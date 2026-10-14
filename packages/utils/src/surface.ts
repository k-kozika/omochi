import { BASIC_CATALOG, Reconciler, UI, type JsonObject } from "@omochi-ui/sdk";
import { Publisher } from "./publisher.js";

export abstract class UtilitySurface {
  protected readonly reconciler = new Reconciler();
  protected closing = false;
  private readonly unsubscribe: () => void;
  private timer?: NodeJS.Timeout;

  constructor(protected readonly publisher: Publisher, protected readonly name: string) {
    this.unsubscribe = publisher.onAction((message) => this.receiveAction(message));
  }

  async start(): Promise<void> { await this.render(); }

  protected abstract build(ui: UI): void;
  protected onAction(_name: string): void {}

  protected scheduleRender(): void {
    if (this.timer || this.closing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.render().catch((error: unknown) => {
        if (!this.closing) process.stderr.write(`surface render: ${String(error)}\n`);
      });
    }, 50);
  }

  protected async render(): Promise<void> {
    if (this.closing) return;
    const ui = new UI("main", BASIC_CATALOG);
    this.build(ui);
    const messages = this.reconciler.render(ui.build());
    if (messages.length) await this.publisher.publish(messages);
  }

  protected closeSurface(): void {
    if (this.closing) return;
    this.closing = true;
    this.unsubscribe();
    clearTimeout(this.timer);
  }

  private receiveAction(message: JsonObject): void {
    const action = message.action;
    if (!action || typeof action !== "object" || Array.isArray(action)) return;
    if (action.surfaceId !== "main" || typeof action.name !== "string") return;
    this.onAction(action.name);
  }
}
