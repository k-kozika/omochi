from __future__ import annotations

import copy
import re
from typing import Any

_ARRAY_INDEX = re.compile(r"^(0|[1-9]\d*)$")

# `None` is a valid JSON value, so absence needs a distinct sentinel.
_MISSING = object()


def _pointer_parts(path: str) -> list[str]:
    if not path.startswith("/"):
        raise ValueError(f"data model path must start with '/': {path!r}")
    return [part.replace("~1", "/").replace("~0", "~") for part in path[1:].split("/")]


def _is_array_index(value: str) -> bool:
    return bool(_ARRAY_INDEX.match(value))


def _is_container(value: Any) -> bool:
    return isinstance(value, (dict, list))


def _set_index(target: list[Any], index: int, value: Any) -> None:
    # A write past the end leaves JSON nulls, matching a sparse array on the wire.
    while len(target) <= index:
        target.append(None)
    target[index] = value


def _update_at_pointer(root: Any, path: str, present: bool, value: Any) -> Any:
    if path in ("", "/"):
        return copy.deepcopy(value) if present else _MISSING

    parts = _pointer_parts(path)
    result: Any = copy.deepcopy(root) if root is not _MISSING else None
    if not _is_container(result):
        result = [] if _is_array_index(parts[0]) else {}
    current: Any = result

    for index, part in enumerate(parts[:-1]):
        next_part = parts[index + 1]
        if isinstance(current, list):
            if not _is_array_index(part):
                raise ValueError(f"array data model path segment must be an index: {part!r}")
            position = int(part)
            child = current[position] if position < len(current) else None
            if not _is_container(child):
                child = [] if _is_array_index(next_part) else {}
                _set_index(current, position, child)
        else:
            child = current.get(part)
            if not _is_container(child):
                child = [] if _is_array_index(next_part) else {}
                current[part] = child
        current = child

    last = parts[-1]
    if isinstance(current, list):
        if not _is_array_index(last):
            raise ValueError(f"array data model path segment must be an index: {last!r}")
        position = int(last)
        if present:
            _set_index(current, position, copy.deepcopy(value))
        elif position < len(current):
            del current[position]
    elif present:
        current[last] = copy.deepcopy(value)
    else:
        current.pop(last, None)
    return result


class _SurfaceSnapshot:
    __slots__ = ("create", "components", "data", "has_data")

    def __init__(self, create: dict[str, Any]):
        self.create = create
        self.components: dict[str, dict[str, Any]] = {}
        self.data: Any = _MISSING
        # A surface whose data model was deleted at the root still needs one replay
        # message, so presence is tracked separately from the value itself.
        self.has_data = False


class A2uiSnapshot:
    """Materializes one shared A2UI stream so a renderer can join without replaying history.

    Mirrors the TypeScript implementation in ``packages/sdk/typescript/src/node/snapshot.ts``.
    Only messages the Runtime itself produced are applied, so the four v0.9 message kinds
    are matched structurally rather than validated against the wire schema.
    """

    def __init__(self) -> None:
        self._surfaces: dict[str, _SurfaceSnapshot] = {}

    def apply(self, message: dict[str, Any]) -> None:
        if "createSurface" in message:
            surface_id = message["createSurface"]["surfaceId"]
            if surface_id in self._surfaces:
                raise ValueError(f"surface already exists: {surface_id!r}")
            self._surfaces[surface_id] = _SurfaceSnapshot(copy.deepcopy(message))
        elif "updateComponents" in message:
            update = message["updateComponents"]
            surface = self._surface(update["surfaceId"])
            for component in update["components"]:
                component_id = component.get("id")
                if not isinstance(component_id, str):
                    raise ValueError("component must contain a string id")
                surface.components[component_id] = copy.deepcopy(component)
        elif "updateDataModel" in message:
            update = message["updateDataModel"]
            surface = self._surface(update["surfaceId"])
            surface.data = _update_at_pointer(
                surface.data,
                update.get("path", "/"),
                "value" in update,
                update.get("value"),
            )
            surface.has_data = True
        elif "deleteSurface" in message:
            self._surfaces.pop(message["deleteSurface"]["surfaceId"], None)
        else:
            raise ValueError("expected an A2UI v0.9 server message")

    def messages(self) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        for surface_id, surface in self._surfaces.items():
            messages.append(copy.deepcopy(surface.create))
            if surface.components:
                messages.append({
                    "version": "v0.9",
                    "updateComponents": {
                        "surfaceId": surface_id,
                        "components": [copy.deepcopy(component) for component in surface.components.values()],
                    },
                })
            if surface.has_data:
                update: dict[str, Any] = {"surfaceId": surface_id, "path": "/"}
                if surface.data is not _MISSING:
                    update["value"] = copy.deepcopy(surface.data)
                messages.append({"version": "v0.9", "updateDataModel": update})
        return messages

    def surface_ids(self) -> list[str]:
        return list(self._surfaces)

    def _surface(self, surface_id: str) -> _SurfaceSnapshot:
        surface = self._surfaces.get(surface_id)
        if surface is None:
            raise ValueError(f"unknown surface: {surface_id!r}")
        return surface
