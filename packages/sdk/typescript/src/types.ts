export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ReadonlyJsonValue = JsonPrimitive | readonly ReadonlyJsonValue[] | { readonly [key: string]: ReadonlyJsonValue };
export type ReadonlyJsonObject = { readonly [key: string]: ReadonlyJsonValue };

export interface SlotIR {
  path: string;
  kind: "single" | "list" | "template";
  nodes: NodeIR[];
  dataPath?: string;
}

export interface NodeIR {
  key: string;
  component: string;
  props: JsonObject;
  slots?: SlotIR[];
}

export interface Declaration {
  irVersion: "2";
  surfaceId: string;
  catalogId: string;
  root: NodeIR;
  data: JsonObject;
  locals: Record<string, LocalDeclaration>;
  requiredCapabilities: string[];
}

export interface LocalDeclaration {
  initial: JsonValue;
  resetKey?: JsonValue;
}

export interface A2UIMessage {
  version: "v0.9";
  [messageType: string]: JsonValue;
}

export interface ActionContext<State = unknown> {
  update(mutator: (state: State) => void | Promise<void>): Promise<void>;
}

export type TypedActionContext<State> = ActionContext<State>;

export interface LocalValueExpression extends JsonObject {
  readonly $local: string;
  readonly path: string;
}

export interface ActionCall {
  readonly action: string;
  readonly input: JsonValue;
}

export type ActionHandler<Input, State> = (input: Input, context: ActionContext<State>) => unknown | Promise<unknown>;
export type View<State = unknown> = (ui: import("./builder.js").UI, state: State) => void;
