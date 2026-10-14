from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from .errors import CapabilityError
from .ir import Declaration, Node

PROTOCOL_VERSION = "v0.9"
STANDARD_CATALOG = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"


@dataclass(slots=True)
class SurfaceSnapshot:
    catalog_id: str
    components: dict[str, dict[str, Any]]
    data: dict[str, Any]
    locals: dict[str, dict[str, Any]]


def _component_id(surface_id: str, key: str) -> str:
    # Component ids are scoped to a surface. A2UI requires the root id to be
    # exactly "root", so keys are already the canonical wire ids.
    return key


def _flatten(surface_id: str, root: Node) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}

    def set_pointer(target: dict[str, Any], pointer: str, value: Any) -> None:
        parts = [part.replace("~1", "/").replace("~0", "~") for part in pointer.split("/")[1:]]
        if not parts:
            raise ValueError("slot path must be a non-root JSON Pointer")
        current: Any = target
        for index, part in enumerate(parts[:-1]):
            next_value: Any = [] if parts[index + 1].isdigit() else {}
            if isinstance(current, list):
                position = int(part)
                while len(current) <= position:
                    current.append(None)
                if current[position] is None:
                    current[position] = next_value
                current = current[position]
            else:
                current = current.setdefault(part, next_value)
        last = parts[-1]
        if isinstance(current, list):
            position = int(last)
            while len(current) <= position:
                current.append(None)
            current[position] = value
        else:
            current[last] = value

    def visit(node: Node) -> str:
        node_id = _component_id(surface_id, node.key)
        value: dict[str, Any] = {"id": node_id, "component": node.component, **deepcopy(node.props)}
        for slot in node.slots:
            ids = [visit(child) for child in slot.nodes]
            if slot.kind == "single":
                if len(ids) != 1:
                    raise ValueError(f"single slot {slot.path} must contain exactly one node")
                slot_value: Any = ids[0]
            elif slot.kind == "template":
                if len(ids) != 1 or slot.data_path is None:
                    raise ValueError(f"template slot {slot.path} requires one node and data_path")
                slot_value = {"componentId": ids[0], "path": slot.data_path}
            else:
                slot_value = ids
            set_pointer(value, slot.path, slot_value)
        result[node_id] = value
        return node_id

    visit(root)
    return result


def _data_diff(before: Any, after: Any, path: str = "") -> list[tuple[str, bool, Any]]:
    if before == after:
        return []
    if isinstance(before, dict) and isinstance(after, dict):
        changes: list[tuple[str, bool, Any]] = []
        for key in sorted(before.keys() | after.keys()):
            escaped = key.replace("~", "~0").replace("/", "~1")
            child_path = f"{path}/{escaped}"
            if key not in after:
                changes.append((child_path, False, None))
            elif key not in before:
                changes.append((child_path, True, deepcopy(after[key])))
            else:
                changes.extend(_data_diff(before[key], after[key], child_path))
        return changes
    return [(path or "/", True, deepcopy(after))]


class Reconciler:
    def __init__(self, capabilities: set[str] | None = None):
        self.capabilities = capabilities or set()
        self._surfaces: dict[str, SurfaceSnapshot] = {}

    def render(self, declaration: Declaration) -> list[dict[str, Any]]:
        missing = declaration.required_capabilities - self.capabilities
        if missing:
            raise CapabilityError(f"renderer lacks required capabilities: {', '.join(sorted(missing))}")

        surface_id = declaration.surface_id
        components = _flatten(surface_id, declaration.root)
        previous = self._surfaces.get(surface_id)
        messages: list[dict[str, Any]] = []

        if previous is not None and previous.catalog_id != declaration.catalog_id:
            messages.append({"version": PROTOCOL_VERSION, "deleteSurface": {"surfaceId": surface_id}})
            previous = None

        if previous is None:
            initial_data = deepcopy(declaration.data)
            initial_data["$local"] = {key: deepcopy(value["initial"]) for key, value in declaration.locals.items()}
            messages.extend([
                {
                    "version": PROTOCOL_VERSION,
                    "createSurface": {
                        "surfaceId": surface_id,
                        "catalogId": declaration.catalog_id,
                        "sendDataModel": True,
                    },
                },
                {
                    "version": PROTOCOL_VERSION,
                    "updateComponents": {"surfaceId": surface_id, "components": list(components.values())},
                },
                {
                    "version": PROTOCOL_VERSION,
                    "updateDataModel": {"surfaceId": surface_id, "path": "/", "value": initial_data},
                },
            ])
        else:
            changed = [value for key, value in components.items() if previous.components.get(key) != value]
            if changed:
                messages.append({
                    "version": PROTOCOL_VERSION,
                    "updateComponents": {"surfaceId": surface_id, "components": changed},
                })
            for path, has_value, value in _data_diff(previous.data, declaration.data):
                update: dict[str, Any] = {"surfaceId": surface_id, "path": path}
                if has_value:
                    update["value"] = value
                messages.append({"version": PROTOCOL_VERSION, "updateDataModel": update})
            for key in sorted(previous.locals.keys() | declaration.locals.keys()):
                before = previous.locals.get(key)
                after = declaration.locals.get(key)
                path = f"/$local/{key.replace('~', '~0').replace('/', '~1')}"
                update = {"surfaceId": surface_id, "path": path}
                if after is not None and (before is None or before.get("resetKey") != after.get("resetKey")):
                    update["value"] = deepcopy(after["initial"])
                elif after is not None:
                    continue
                messages.append({"version": PROTOCOL_VERSION, "updateDataModel": update})

        self._surfaces[surface_id] = SurfaceSnapshot(
            catalog_id=declaration.catalog_id,
            components=components,
            data=deepcopy(declaration.data),
            locals=deepcopy(declaration.locals),
        )
        return messages

    def close(self, surface_id: str) -> list[dict[str, Any]]:
        if self._surfaces.pop(surface_id, None) is None:
            return []
        return [{"version": PROTOCOL_VERSION, "deleteSurface": {"surfaceId": surface_id}}]

    def sync_data(self, surface_id: str, data: dict[str, Any]) -> None:
        surface = self._surfaces.get(surface_id)
        if surface is not None:
            surface.data = deepcopy(data)
