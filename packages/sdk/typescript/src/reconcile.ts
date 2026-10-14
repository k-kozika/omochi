import { CapabilityError } from "./errors.js";
import type { A2UIMessage, Declaration, JsonObject, JsonValue, NodeIR } from "./types.js";

interface SurfaceSnapshot {
  catalogId: string;
  components: Map<string, JsonObject>;
  data: JsonObject;
  locals: Declaration["locals"];
}

const clone = <T>(value: T): T => structuredClone(value);
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
// Component ids are surface-scoped and A2UI requires the root id to be "root".
const componentId = (_surfaceId: string, key: string): string => key;

function flatten(surfaceId: string, root: NodeIR): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  const setPointer = (object: JsonObject, pointer: string, value: JsonValue): void => {
    const parts = pointer.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (!parts.length) throw new Error("slot path must be a non-root JSON Pointer");
    let target: JsonObject | JsonValue[] = object;
    for (const [index, part] of parts.slice(0, -1).entries()) {
      const nextPart = parts[index + 1]!;
      const existing: JsonValue | undefined = Array.isArray(target) ? target[Number(part)] : target[part];
      const next: JsonObject | JsonValue[] = existing !== null && typeof existing === "object"
        ? existing : /^\d+$/.test(nextPart) ? [] : {};
      if (Array.isArray(target)) target[Number(part)] = next;
      else target[part] = next;
      target = next;
    }
    const last = parts.at(-1)!;
    if (Array.isArray(target)) target[Number(last)] = value;
    else target[last] = value;
  };
  const visit = (node: NodeIR): string => {
    const id = componentId(surfaceId, node.key);
    const value: JsonObject = { id, component: node.component, ...clone(node.props) };
    for (const slot of node.slots ?? []) {
      const ids = slot.nodes.map(visit);
      if (slot.kind === "single") {
        if (ids.length !== 1) throw new Error(`single slot ${slot.path} must contain exactly one node`);
        setPointer(value, slot.path, ids[0]!);
      } else if (slot.kind === "template") {
        if (ids.length !== 1 || !slot.dataPath) throw new Error(`template slot ${slot.path} requires one node and dataPath`);
        setPointer(value, slot.path, { componentId: ids[0]!, path: slot.dataPath });
      } else {
        setPointer(value, slot.path, ids);
      }
    }
    result.set(id, value);
    return id;
  };
  visit(root);
  return result;
}

type DataChange = { path: string; present: boolean; value?: JsonValue };

function dataDiff(before: JsonValue, after: JsonValue, path = ""): DataChange[] {
  if (equal(before, after)) return [];
  const beforeObject = before !== null && typeof before === "object" && !Array.isArray(before);
  const afterObject = after !== null && typeof after === "object" && !Array.isArray(after);
  if (beforeObject && afterObject) {
    const left = before as JsonObject;
    const right = after as JsonObject;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) => {
      const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
      const childPath = `${path}/${escaped}`;
      if (!(key in right)) return [{ path: childPath, present: false }];
      if (!(key in left)) return [{ path: childPath, present: true, value: clone(right[key]!) }];
      return dataDiff(left[key]!, right[key]!, childPath);
    });
  }
  return [{ path: path || "/", present: true, value: clone(after) }];
}

export class Reconciler {
  readonly capabilities: Set<string>;
  private readonly surfaces = new Map<string, SurfaceSnapshot>();

  constructor(capabilities: Iterable<string> = []) {
    this.capabilities = new Set(capabilities);
  }

  render(declaration: Declaration): A2UIMessage[] {
    const missing = declaration.requiredCapabilities.filter((value) => !this.capabilities.has(value));
    if (missing.length) throw new CapabilityError(`renderer lacks required capabilities: ${missing.sort().join(", ")}`);

    const surfaceId = declaration.surfaceId;
    const initialData: JsonObject = clone(declaration.data);
    initialData.$local = Object.fromEntries(Object.entries(declaration.locals).map(([key, local]) => [key, clone(local.initial)]));
    const components = flatten(surfaceId, declaration.root);
    let previous = this.surfaces.get(surfaceId);
    const messages: A2UIMessage[] = [];
    if (previous && previous.catalogId !== declaration.catalogId) {
      messages.push({ version: "v0.9", deleteSurface: { surfaceId } });
      previous = undefined;
    }

    if (!previous) {
      messages.push(
        { version: "v0.9", createSurface: { surfaceId, catalogId: declaration.catalogId, sendDataModel: true } },
        { version: "v0.9", updateComponents: { surfaceId, components: [...components.values()] } },
        { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: initialData } },
      );
    } else {
      const changed = [...components].filter(([key, value]) => !equal(previous!.components.get(key), value)).map(([, value]) => value);
      if (changed.length) messages.push({ version: "v0.9", updateComponents: { surfaceId, components: changed } });
      for (const change of dataDiff(previous.data, declaration.data)) {
        const update: JsonObject = { surfaceId, path: change.path };
        if (change.present) update.value = change.value!;
        messages.push({ version: "v0.9", updateDataModel: update });
      }
      const localKeys = [...new Set([...Object.keys(previous.locals), ...Object.keys(declaration.locals)])].sort();
      for (const key of localKeys) {
        const before = previous.locals[key];
        const after = declaration.locals[key];
        const path = `/$local/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        if (!after) messages.push({ version: "v0.9", updateDataModel: { surfaceId, path } });
        else if (!before || !equal(before.resetKey, after.resetKey)) messages.push({ version: "v0.9", updateDataModel: { surfaceId, path, value: clone(after.initial) } });
      }
    }

    this.surfaces.set(surfaceId, { catalogId: declaration.catalogId, components, data: clone(declaration.data), locals: clone(declaration.locals) });
    return messages;
  }

  syncData(surfaceId: string, data: JsonObject): void {
    const surface = this.surfaces.get(surfaceId);
    if (surface) surface.data = clone(data);
  }

  close(surfaceId: string): A2UIMessage[] {
    if (!this.surfaces.delete(surfaceId)) return [];
    return [{ version: "v0.9", deleteSurface: { surfaceId } }];
  }
}
