import type {
  AudioPlayerProps, BasicComponentMap, ButtonProps, CardProps, CatalogDefinition, CheckBoxProps,
  ChoicePickerProps, CommonProps, ComponentMap, DateTimeInputProps, DividerProps,
  DynamicString, IconProps, ImageProps, LayoutProps, ListProps, SliderProps, TextFieldProps, TextProps, VideoProps,
} from "./catalog.js";
import { BASIC_CATALOG } from "./catalog.js";
import { DeclarationError } from "./errors.js";
import type { ActionCall, Declaration, JsonObject, JsonValue, LocalDeclaration, LocalValueExpression, NodeIR, SlotIR } from "./types.js";

export const STANDARD_CATALOG = BASIC_CATALOG.id;
const escapePointer = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1");
type Keyed<T> = Omit<T, "child" | "children" | "tabs" | "trigger" | "content" | "value" | "action"> & { key?: string };
export interface ModelBinding { readonly path: string }
type InputControl<T> = { default?: T; bind?: never } | { bind: ModelBinding; default?: never };

const clone = <T>(value: T): T => structuredClone(value);

export class UI<Components extends ComponentMap = BasicComponentMap> {
  private readonly root: NodeIR = { key: "root", component: "Column", props: {}, slots: [{ path: "/children", kind: "list", nodes: [] }] };
  private readonly targets: NodeIR[][] = [this.root.slots![0]!.nodes];
  private readonly data: JsonObject;
  private readonly bindings = new WeakSet<object>();
  private readonly locals: Record<string, LocalDeclaration> = {};
  private readonly uncontrolledInputNames = new Set<string>();
  private readonly requiredCapabilities = new Set<string>();
  private readonly keys = new Set<string>(["root"]);
  private autoKey = 0;

  constructor(
    private readonly surfaceId: string,
    private readonly catalog: CatalogDefinition<Components>,
    previousData: JsonObject = {},
  ) {
    const inputs = previousData.inputs;
    this.data = { inputs: inputs !== null && typeof inputs === "object" && !Array.isArray(inputs) ? clone(inputs) : {} };
  }

  local(key: string, initial: JsonValue, options: { resetKey?: JsonValue } = {}): Local {
    if (!key || key in this.locals) throw new DeclarationError(`local key must be unique and non-empty: ${JSON.stringify(key)}`);
    this.locals[key] = { initial: clone(initial), ...(Object.hasOwn(options, "resetKey") ? { resetKey: clone(options.resetKey!) } : {}) };
    return new Local(key, this.bindings);
  }

  private key(key?: string): string {
    const resolved = key ?? `auto:${this.autoKey++}`;
    if (this.keys.has(resolved)) throw new DeclarationError(`duplicate component key on ${JSON.stringify(this.surfaceId)}: ${JSON.stringify(resolved)}`);
    this.keys.add(resolved);
    return resolved;
  }

  private append(component: string, props: JsonObject, key?: string): NodeIR {
    const node: NodeIR = { key: this.key(key), component, props };
    this.targets.at(-1)!.push(node);
    return node;
  }

  private slot(node: NodeIR, path: string, kind: SlotIR["kind"], build: (ui: this) => void, dataPath?: string): SlotIR {
    const slot: SlotIR = { path, kind, nodes: [], ...(dataPath ? { dataPath } : {}) };
    node.slots = [...(node.slots ?? []), slot];
    this.targets.push(slot.nodes);
    try { build(this); } finally { this.targets.pop(); }
    return slot;
  }

  component<Name extends keyof Components & string>(component: Name, options: { key: string } & Components[Name]): void {
    const { key, ...props } = options;
    this.append(component, props as JsonObject, key);
  }

  text(value: DynamicString, options: Omit<TextProps, "text"> & { key?: string } = {}): void {
    const { key, ...props } = options;
    this.append("Text", { text: value, ...props } as unknown as JsonObject, key);
  }

  image(url: DynamicString, options: Omit<ImageProps, "url"> & { key?: string } = {}): void { const { key, ...props } = options; this.append("Image", { url, ...props } as unknown as JsonObject, key); }
  icon(name: IconProps["name"], options: Omit<IconProps, "name"> & { key?: string } = {}): void { const { key, ...props } = options; this.append("Icon", { name, ...props } as unknown as JsonObject, key); }
  video(url: DynamicString, options: Omit<VideoProps, "url"> & { key?: string } = {}): void { const { key, ...props } = options; this.append("Video", { url, ...props } as unknown as JsonObject, key); }
  audioPlayer(url: DynamicString, options: Omit<AudioPlayerProps, "url"> & { key?: string } = {}): void { const { key, ...props } = options; this.append("AudioPlayer", { url, ...props } as unknown as JsonObject, key); }
  divider(options: DividerProps & { key?: string } = {}): void { const { key, ...props } = options; this.append("Divider", props as JsonObject, key); }

  private layout(component: "Row" | "Column" | "List", options: Keyed<LayoutProps | ListProps>, build: (ui: this) => void): void {
    const { key, ...props } = options;
    const node = this.append(component, props as JsonObject, key);
    this.slot(node, "/children", "list", build);
  }
  row(options: Keyed<LayoutProps>, build: (ui: this) => void): void { this.layout("Row", options, build); }
  column(options: Keyed<LayoutProps>, build: (ui: this) => void): void { this.layout("Column", options, build); }
  list(options: Keyed<ListProps>, build: (ui: this) => void): void { this.layout("List", options, build); }
  card(options: Keyed<CardProps>, build: (ui: this) => void): void {
    const { key, ...props } = options;
    const node = this.append("Card", props as JsonObject, key);
    const slot = this.slot(node, "/child", "single", build);
    if (slot.nodes.length !== 1) throw new DeclarationError("card must build exactly one child; wrap multiple children in column()");
  }

  tabs(options: { key?: string; tabs: Array<{ title: DynamicString; content: (ui: UI<Components>) => void }> } & CommonProps): void {
    const { key, tabs, ...common } = options;
    const node = this.append("Tabs", { ...common, tabs: tabs.map(({ title }) => ({ title })) } as unknown as JsonObject, key);
    tabs.forEach((tab, index) => {
      const slot = this.slot(node, `/tabs/${index}/child`, "single", tab.content as (ui: this) => void);
      if (slot.nodes.length !== 1) throw new DeclarationError("each tab must build exactly one child; wrap multiple children in column()");
    });
  }

  modal(options: { key?: string; trigger: (ui: UI<Components>) => void; content: (ui: UI<Components>) => void } & CommonProps): void {
    const { key, trigger, content, ...common } = options;
    const node = this.append("Modal", common as JsonObject, key);
    const triggerSlot = this.slot(node, "/trigger", "single", trigger as (ui: this) => void);
    const contentSlot = this.slot(node, "/content", "single", content as (ui: this) => void);
    if (triggerSlot.nodes.length !== 1 || contentSlot.nodes.length !== 1) throw new DeclarationError("modal trigger and content must each build exactly one child");
  }

  button(label: DynamicString, call: ActionCall, options: Omit<ButtonProps, "child" | "action"> & { key?: string } = {}): void {
    const actionName = call.action;
    const { key, ...props } = options;
    const node = this.append("Button", {
      ...props,
      action: { event: { name: actionName, context: { input: resolveLocalValues(call.input) } } },
    } as unknown as JsonObject, key ?? `action:${actionName}`);
    this.slot(node, "/child", "single", (ui) => ui.text(label, { key: `${node.key}:label` }));
  }

  private input(name: string, component: string, value: unknown, bind: ModelBinding | undefined, props: JsonObject, key?: string): void {
    if ("onChange" in props || "on_change" in props) throw new DeclarationError(`${component} does not define an input change action in the Basic Catalog`);
    const path = bind?.path ?? `/inputs/${escapePointer(name)}`;
    if (bind && !this.bindings.has(bind)) throw new DeclarationError("bind must be a reference returned by local.bind()");
    if (!bind) {
      this.uncontrolledInputNames.add(name);
      if (!(name in (this.data.inputs as JsonObject))) (this.data.inputs as JsonObject)[name] = value as never;
    }
    this.append(component, { ...props, value: { path } }, key ?? `input:${name}`);
  }
  private assertControl(options: { default?: unknown; bind?: ModelBinding }): void {
    if (options.bind && Object.prototype.hasOwnProperty.call(options, "default")) throw new DeclarationError("default and bind cannot be used together");
  }
  textField(name: string, options: Omit<TextFieldProps, "value"> & { key?: string } & InputControl<string>): void { this.assertControl(options); const { default: initial = "", bind, key, ...props } = options; this.input(name, "TextField", initial, bind, props as unknown as JsonObject, key); }
  checkBox(name: string, options: Omit<CheckBoxProps, "value"> & { key?: string } & InputControl<boolean>): void { this.assertControl(options); const { default: initial = false, bind, key, ...props } = options; this.input(name, "CheckBox", initial, bind, props as unknown as JsonObject, key); }
  choicePicker(name: string, options: Omit<ChoicePickerProps, "value"> & { key?: string } & InputControl<string[]>): void { this.assertControl(options); const { default: initial = [], bind, key, ...props } = options; this.input(name, "ChoicePicker", initial, bind, props as unknown as JsonObject, key); }
  slider(name: string, minimum: number, maximum: number, options: Omit<SliderProps, "min" | "max" | "value"> & { key?: string } & InputControl<number> = {}): void { this.assertControl(options); const { default: initial = minimum, bind, key, ...props } = options; this.input(name, "Slider", initial, bind, { min: minimum, max: maximum, ...props } as unknown as JsonObject, key); }
  dateTimeInput(name: string, options: Omit<DateTimeInputProps, "value"> & { key?: string } & InputControl<string>): void { this.assertControl(options); const { default: initial = "", bind, key, ...props } = options; this.input(name, "DateTimeInput", initial, bind, props as JsonObject, key); }

  build(): Declaration {
    const inputs = this.data.inputs as JsonObject;
    for (const name of Object.keys(inputs)) if (!this.uncontrolledInputNames.has(name)) delete inputs[name];
    return { irVersion: "2", surfaceId: this.surfaceId, catalogId: this.catalog.id, root: this.root, data: this.data, locals: clone(this.locals), requiredCapabilities: [...this.requiredCapabilities].sort() };
  }
}

export class Local {
  constructor(private readonly key: string, private readonly bindings: WeakSet<object>) {}

  bind(path: string): ModelBinding {
    assertPointer(path);
    const binding = Object.freeze({ path: localPath(this.key, path) });
    this.bindings.add(binding);
    return binding;
  }

  value(path: string): LocalValueExpression {
    assertPointer(path);
    return Object.freeze({ $local: this.key, path });
  }
}

function assertPointer(path: string): void {
  if (path !== "" && !path.startsWith("/")) throw new DeclarationError(`local path must be a JSON Pointer: ${JSON.stringify(path)}`);
}

function localPath(key: string, path: string): string {
  return `/$local/${escapePointer(key)}${path}`;
}

function resolveLocalValues(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.$local === "string" && typeof value.path === "string") {
    return { path: localPath(value.$local, value.path) };
  }
  if (Array.isArray(value)) return value.map(resolveLocalValues);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveLocalValues(child)]));
  return value;
}
