from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class Slot:
    path: str
    kind: str
    nodes: list["Node"] = field(default_factory=list)
    data_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "path": self.path,
            "kind": self.kind,
            "nodes": [node.to_dict() for node in self.nodes],
        }
        if self.data_path is not None:
            value["dataPath"] = self.data_path
        return value


@dataclass(slots=True)
class Node:
    key: str
    component: str
    props: dict[str, Any] = field(default_factory=dict)
    slots: list[Slot] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "key": self.key,
            "component": self.component,
            "props": self.props,
        }
        if self.slots:
            value["slots"] = [slot.to_dict() for slot in self.slots]
        return value


@dataclass(slots=True)
class Declaration:
    surface_id: str
    catalog_id: str
    root: Node
    data: dict[str, Any]
    locals: dict[str, dict[str, Any]] = field(default_factory=dict)
    required_capabilities: set[str] = field(default_factory=set)

    def to_dict(self) -> dict[str, Any]:
        return {
            "irVersion": "2",
            "surfaceId": self.surface_id,
            "catalogId": self.catalog_id,
            "root": self.root.to_dict(),
            "data": self.data,
            "locals": self.locals,
            "requiredCapabilities": sorted(self.required_capabilities),
        }
