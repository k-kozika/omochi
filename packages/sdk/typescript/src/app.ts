import { UI } from "./builder.js";
import { BASIC_CATALOG, type BasicComponentMap, type CatalogDefinition, type ComponentMap } from "./catalog.js";
import { DeclarationError, ProtocolError } from "./errors.js";
import { Reconciler } from "./reconcile.js";
import { StdioTransport, type Transport } from "./transport.js";
import type { A2UIMessage, ActionCall, ActionContext, ActionHandler, Declaration, JsonObject, JsonValue } from "./types.js";

type RegisteredAction<State> = (input: JsonValue, context: ActionContext<State>) => unknown | Promise<unknown>;
type View<State, Components extends ComponentMap> = (ui: UI<Components>, state: State) => void;

export class Action<Input extends JsonValue = JsonValue> {
  constructor(readonly name: string) {}
  call(input: JsonValue): ActionCall { return Object.freeze({ action: this.name, input: structuredClone(input) }); }
}

export class App<State, Components extends ComponentMap = BasicComponentMap> {
  private readonly views = new Map<string, View<State, Components>>();
  private readonly actions = new Map<string, RegisteredAction<State>>();
  private built = false;
  constructor(readonly state: State, readonly catalog: CatalogDefinition<Components> = BASIC_CATALOG as CatalogDefinition<Components>) {}
  surface(surfaceId: string, view: View<State, Components>): this {
    if (this.built) throw new DeclarationError("app is already built");
    if (this.views.has(surfaceId)) throw new DeclarationError(`surface already registered: ${JSON.stringify(surfaceId)}`);
    this.views.set(surfaceId, view); return this;
  }
  action<Input extends JsonValue>(name: string, handler: ActionHandler<Input, State>): Action<Input> {
    if (this.built) throw new DeclarationError("app is already built");
    if (this.actions.has(name)) throw new DeclarationError(`action already registered: ${JSON.stringify(name)}`);
    this.actions.set(name, handler as RegisteredAction<State>); return new Action<Input>(name);
  }
  build(): Runtime<State, Components> {
    if (this.built) throw new DeclarationError("app is already built");
    this.built = true; return new Runtime(this.state, this.catalog, this.views, this.actions);
  }
  async start(transport: Transport = new StdioTransport()): Promise<void> { await this.build().start(transport); }
}

export class Runtime<State, Components extends ComponentMap = BasicComponentMap> {
  private reconciler = new Reconciler();
  private transport: Transport | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private started = false;
  private closed = false;
  private readyResolve!: () => void;
  private closedResolve!: () => void;
  private readonly readyPromise = new Promise<void>((resolve) => { this.readyResolve = resolve; });
  private readonly closedPromise = new Promise<void>((resolve) => { this.closedResolve = resolve; });
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly taskControllers = new Set<AbortController>();
  private pendingUpdates: Array<{ mutator: (state: State) => void | Promise<void>; resolve: (messages: A2UIMessage[]) => void; reject: (error: unknown) => void }> = [];
  private updateScheduled = false;
  constructor(private readonly state: State, private readonly catalog: CatalogDefinition<Components>, private readonly views: Map<string, View<State, Components>>, private readonly actions: Map<string, RegisteredAction<State>>) {}
  get appRevision(): number { return this.revision; }
  declaration(surfaceId: string): Declaration {
    const view = this.views.get(surfaceId);
    if (!view) throw new DeclarationError(`unknown surface: ${JSON.stringify(surfaceId)}`);
    const ui = new UI(surfaceId, this.catalog); view(ui, this.state); return ui.build();
  }
  render(surfaceId = "main"): A2UIMessage[] { return this.reconciler.render(this.declaration(surfaceId)); }
  surface(surfaceId = "main"): A2UIMessage[] { return new Reconciler(this.reconciler.capabilities).render(this.declaration(surfaceId)); }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const current = this.queue.then(work, work); this.queue = current.then(() => undefined, () => undefined); return current;
  }
  private async renderAllAndSend(): Promise<A2UIMessage[]> {
    const all: A2UIMessage[] = [];
    for (const surfaceId of this.views.keys()) { const messages = this.render(surfaceId); all.push(...messages); if (this.transport) for (const message of messages) await this.transport.send(message); }
    return all;
  }
  async update(mutator: (state: State) => void | Promise<void>): Promise<A2UIMessage[]> {
    return new Promise<A2UIMessage[]>((resolve, reject) => {
      this.pendingUpdates.push({ mutator, resolve, reject });
      if (this.updateScheduled) return;
      this.updateScheduled = true;
      queueMicrotask(() => {
        void this.enqueue(async () => {
          const batch = this.pendingUpdates.splice(0);
          this.updateScheduled = false;
          try {
            for (const item of batch) { await item.mutator(this.state); this.revision++; }
            const messages = await this.renderAllAndSend();
            for (const item of batch) item.resolve(messages);
          } catch (error) {
            for (const item of batch) item.reject(error);
          }
        });
      });
    });
  }
  async invoke(name: string, input: JsonValue): Promise<A2UIMessage[]> {
    const action = this.actions.get(name); if (!action) throw new ProtocolError(`unknown action: ${JSON.stringify(name)}`);
    return this.enqueue(async () => {
      const messages: A2UIMessage[] = [];
      let updates: Promise<void> = Promise.resolve();
      let active = true;
      const context: ActionContext<State> = {
        update: (mutator) => {
          if (!active) return Promise.reject(new DeclarationError("action has already completed"));
          // Use an action-local queue: entering the Runtime queue again would deadlock.
          const current = updates.then(async () => {
            await mutator(this.state);
            this.revision++;
            messages.push(...await this.renderAllAndSend());
          });
          updates = current.then(() => undefined, () => undefined);
          return current;
        },
      };
      try {
        await action(structuredClone(input), context);
      } finally {
        active = false;
        await updates;
      }
      return messages;
    });
  }
  async handle(message: JsonObject): Promise<A2UIMessage[]> {
    if (message.type === "getSurface") { if (typeof message.surface !== "string") throw new ProtocolError("getSurface must contain string surface"); return this.surface(message.surface); }
    if (message.type === "invoke") { if (typeof message.action !== "string") throw new ProtocolError("invoke must contain string action"); return this.invoke(message.action, message.input ?? null); }
    const payload = objectValue(message.action) ?? message;
    if (typeof payload.name !== "string") throw new ProtocolError("action must contain string name");
    const context = objectValue(payload.context) ?? {};
    return this.invoke(payload.name, context.input ?? payload.input ?? null);
  }
  dispatch(message: JsonObject): Promise<A2UIMessage[]> { return this.handle(message); }
  ready(): Promise<void> { return this.readyPromise; }
  spawn(task: Promise<unknown> | ((signal: AbortSignal) => Promise<unknown>)): void {
    const controller = new AbortController();
    const running = typeof task === "function" ? task(controller.signal) : task;
    this.tasks.add(running); this.taskControllers.add(controller);
    void running.finally(() => { this.tasks.delete(running); this.taskControllers.delete(controller); });
  }
  async shutdown(): Promise<void> { if (this.closed) return; this.closed = true; for (const controller of this.taskControllers) controller.abort(); await Promise.allSettled(this.tasks); this.closedResolve(); }
  waitClosed(): Promise<void> { return this.closedPromise; }
  async start(transport: Transport = new StdioTransport()): Promise<void> {
    if (this.started) throw new DeclarationError("runtime has already been started");
    this.started = true; this.transport = transport; this.reconciler = new Reconciler(transport.capabilities);
    await this.renderAllAndSend(); this.readyResolve();
    try {
      for await (const message of transport) {
        const responses = await this.handle(message);
        if (message.type === "getSurface") for (const response of responses) await transport.send(response);
      }
    } finally { await this.shutdown(); }
  }
}

function objectValue(value: JsonValue | undefined): JsonObject | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null; }
