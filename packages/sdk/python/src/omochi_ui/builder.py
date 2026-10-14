from __future__ import annotations

from contextlib import AbstractContextManager, contextmanager
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Callable, Iterator, Literal, Sequence, Unpack, overload

from .catalog import (
    BASIC_CATALOG, ButtonOptions, ButtonProps, CardProps, Catalog, CheckableOptions, CommonProps,
    CheckBoxProps, ChoicePickerOptions, ChoicePickerProps, DateTimeInputOptions,
    DateTimeInputProps, DividerProps, DynamicString, IconProps, ImageOptions, ImageProps,
    LayoutOptions, LayoutProps, ListOptions, ListProps, MediaOptions, MediaProps, ModalProps,
    SliderOptions, SliderProps, TabsProps, TextFieldOptions, TextFieldProps, TextOptions,
    TextProps,
)
from .errors import DeclarationError
from .ir import Declaration, Node, Slot

Action = Callable[..., Any]
STANDARD_CATALOG = BASIC_CATALOG.id
_MISSING = object()

def _escape_pointer(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")

def _unescape_pointer(value: str) -> str:
    return value.replace("~1", "/").replace("~0", "~")

class ModelBinding(dict[str, str]):
    def __init__(self, path: str):
        dict.__init__(self, path=path)

    @property
    def path(self) -> str:
        return self["path"]

    def __setitem__(self, _key: str, _value: str) -> None:
        raise TypeError("model bindings are read-only")

    def __delitem__(self, _key: str) -> None:
        raise TypeError("model bindings are read-only")

    def __deepcopy__(self, _memo: dict[int, Any]) -> dict[str, str]:
        return {"path": self.path}

class Local:
    __slots__ = ("key", "_bindings")
    def __init__(self, key: str, bindings: set[int]):
        self.key = key
        self._bindings = bindings
    def bind(self, path: str) -> ModelBinding:
        _validate_pointer(path)
        binding = ModelBinding(_local_path(self.key, path))
        self._bindings.add(id(binding))
        return binding
    def value(self, path: str) -> dict[str, str]:
        _validate_pointer(path)
        return {"$local": self.key, "path": path}

@dataclass(frozen=True, slots=True)
class Tab:
    title: DynamicString
    content: Callable[["UI"], Any]

class UI:
    """Builds a typed normalized declaration for one A2UI surface."""

    def __init__(self, surface_id: str, catalog: Catalog, register_action: Callable[[Action], str], previous_data: dict[str, Any] | None = None):
        self.surface_id = surface_id
        self.catalog = catalog
        root_slot = Slot(path="/children", kind="list")
        self._root = Node(key="root", component="Column", slots=[root_slot])
        self._targets = [root_slot.nodes]
        self._register_action = register_action
        previous_inputs = (previous_data or {}).get("inputs", {})
        self._data: dict[str, Any] = {"inputs": deepcopy(previous_inputs) if isinstance(previous_inputs, dict) else {}}
        self._locals: dict[str, dict[str, Any]] = {}
        self._bindings: set[int] = set()
        self._uncontrolled_inputs: set[str] = set()
        self._required_capabilities: set[str] = set()
        self._auto_key = 0
        self._keys = {"root"}

    def local(self, key: str, initial: Any, *, reset_key: Any = _MISSING) -> Local:
        if not key or key in self._locals:
            raise DeclarationError(f"local key must be unique and non-empty: {key!r}")
        declaration = {"initial": deepcopy(initial)}
        if reset_key is not _MISSING:
            declaration["resetKey"] = deepcopy(reset_key)
        self._locals[key] = declaration
        return Local(key, self._bindings)

    def _key(self, key: str | None) -> str:
        resolved = key if key is not None else f"auto:{self._auto_key}"
        if key is None:
            self._auto_key += 1
        if resolved in self._keys:
            raise DeclarationError(f"duplicate component key on {self.surface_id!r}: {resolved!r}")
        self._keys.add(resolved)
        return resolved

    def _append(self, component: str, props: dict[str, Any], key: str | None) -> Node:
        node = Node(key=self._key(key), component=component, props=props)
        self._targets[-1].append(node)
        return node

    def _slot(self, node: Node, path: str, kind: str, build: Callable[["UI"], Any]) -> Slot:
        slot = Slot(path=path, kind=kind)
        node.slots.append(slot)
        self._targets.append(slot.nodes)
        try:
            build(self)
        finally:
            self._targets.pop()
        return slot

    @overload
    def component(self, component: Literal["Text"], *, key: str, **props: Unpack[TextProps]) -> None: ...
    @overload
    def component(self, component: Literal["Image"], *, key: str, **props: Unpack[ImageProps]) -> None: ...
    @overload
    def component(self, component: Literal["Icon"], *, key: str, **props: Unpack[IconProps]) -> None: ...
    @overload
    def component(self, component: Literal["Video", "AudioPlayer"], *, key: str, **props: Unpack[MediaProps]) -> None: ...
    @overload
    def component(self, component: Literal["Row", "Column"], *, key: str, **props: Unpack[LayoutProps]) -> None: ...
    @overload
    def component(self, component: Literal["List"], *, key: str, **props: Unpack[ListProps]) -> None: ...
    @overload
    def component(self, component: Literal["Card"], *, key: str, **props: Unpack[CardProps]) -> None: ...
    @overload
    def component(self, component: Literal["Tabs"], *, key: str, **props: Unpack[TabsProps]) -> None: ...
    @overload
    def component(self, component: Literal["Modal"], *, key: str, **props: Unpack[ModalProps]) -> None: ...
    @overload
    def component(self, component: Literal["Divider"], *, key: str, **props: Unpack[DividerProps]) -> None: ...
    @overload
    def component(self, component: Literal["Button"], *, key: str, **props: Unpack[ButtonProps]) -> None: ...
    @overload
    def component(self, component: Literal["TextField"], *, key: str, **props: Unpack[TextFieldProps]) -> None: ...
    @overload
    def component(self, component: Literal["CheckBox"], *, key: str, **props: Unpack[CheckBoxProps]) -> None: ...
    @overload
    def component(self, component: Literal["ChoicePicker"], *, key: str, **props: Unpack[ChoicePickerProps]) -> None: ...
    @overload
    def component(self, component: Literal["Slider"], *, key: str, **props: Unpack[SliderProps]) -> None: ...
    @overload
    def component(self, component: Literal["DateTimeInput"], *, key: str, **props: Unpack[DateTimeInputProps]) -> None: ...
    def component(self, component: str, *, key: str, **props: Any) -> None:
        self._append(component, props, key)

    def text(self, value: DynamicString, *, key: str | None = None, **props: Unpack[TextOptions]) -> None:
        self._append("Text", {"text": value, **props}, key)

    def image(self, url: DynamicString, *, key: str | None = None, **props: Unpack[ImageOptions]) -> None:
        self._append("Image", {"url": url, **props}, key)

    def icon(self, name: str | dict[str, str], *, key: str | None = None, **props: Unpack[CommonProps]) -> None:
        self._append("Icon", {"name": name, **props}, key)

    def video(self, url: DynamicString, *, key: str | None = None, **props: Unpack[CommonProps]) -> None:
        self._append("Video", {"url": url, **props}, key)

    def audio_player(self, url: DynamicString, *, key: str | None = None, **props: Unpack[MediaOptions]) -> None:
        self._append("AudioPlayer", {"url": url, **props}, key)

    def divider(self, *, key: str | None = None, **props: Unpack[DividerProps]) -> None:
        self._append("Divider", props, key)

    @contextmanager
    def _container(self, component: str, *, key: str | None, props: dict[str, Any], path: str = "/children", kind: str = "list") -> Iterator[None]:
        node = self._append(component, props, key)
        slot = Slot(path=path, kind=kind)
        node.slots.append(slot)
        self._targets.append(slot.nodes)
        try:
            yield
        finally:
            self._targets.pop()
            if kind == "single" and len(slot.nodes) != 1:
                raise DeclarationError(f"{component} must contain exactly one child")

    def row(self, *, key: str | None = None, **props: Unpack[LayoutOptions]) -> AbstractContextManager[None]: return self._container("Row", key=key, props=props)
    def column(self, *, key: str | None = None, **props: Unpack[LayoutOptions]) -> AbstractContextManager[None]: return self._container("Column", key=key, props=props)
    def list(self, *, key: str | None = None, **props: Unpack[ListOptions]) -> AbstractContextManager[None]: return self._container("List", key=key, props=props)
    def card(self, *, key: str | None = None, **props: Unpack[CommonProps]) -> AbstractContextManager[None]: return self._container("Card", key=key, props=props, path="/child", kind="single")

    def tabs(self, tabs: Sequence[Tab], *, key: str | None = None, **props: Unpack[CommonProps]) -> None:
        node = self._append("Tabs", {**props, "tabs": [{"title": tab.title} for tab in tabs]}, key)
        for index, tab in enumerate(tabs):
            slot = self._slot(node, f"/tabs/{index}/child", "single", tab.content)
            if len(slot.nodes) != 1:
                raise DeclarationError("each tab must build exactly one child")

    def modal(self, *, trigger: Callable[["UI"], Any], content: Callable[["UI"], Any], key: str | None = None, **props: Unpack[CommonProps]) -> None:
        node = self._append("Modal", props, key)
        if len(self._slot(node, "/trigger", "single", trigger).nodes) != 1 or len(self._slot(node, "/content", "single", content).nodes) != 1:
            raise DeclarationError("modal trigger and content must each build exactly one child")

    def button(self, label: DynamicString, call: Any, *, key: str | None = None, **props: Unpack[ButtonOptions]) -> None:
        action_name = call.action
        node = self._append("Button", {
            **props,
            "action": {"event": {"name": action_name, "context": {"input": _resolve_local_values(call.input)}}},
        }, key or f"action:{action_name}")
        self._slot(node, "/child", "single", lambda ui: ui.text(label, key=f"{node.key}:label"))

    def _input(self, component: str, name: str, default: Any, bind: ModelBinding | None, props: dict[str, Any], key: str | None) -> None:
        if "on_change" in props or "onChange" in props:
            raise DeclarationError(f"{component} does not define an input change action in the Basic Catalog")
        if bind is None:
            self._uncontrolled_inputs.add(name)
            self._data["inputs"].setdefault(name, default)
            path = f"/inputs/{_escape_pointer(name)}"
        else:
            if id(bind) not in self._bindings:
                raise DeclarationError("bind must be a reference returned by local.bind()")
            path = bind.path
        self._append(component, {**props, "value": {"path": path}}, key or f"input:{name}")

    def _input_control(self, component: str, name: str, fallback: Any, default: Any, bind: ModelBinding | None, props: dict[str, Any], key: str | None) -> None:
        if bind is not None and default is not _MISSING:
            raise DeclarationError("default and bind cannot be used together")
        self._input(component, name, fallback if default is _MISSING else default, bind, props, key)

    def text_field(self, name: str, *, label: DynamicString, default: Any = _MISSING, bind: ModelBinding | None = None, key: str | None = None, **props: Unpack[TextFieldOptions]) -> None: self._input_control("TextField", name, "", default, bind, {"label": label, **props}, key)
    def check_box(self, name: str, *, label: DynamicString, default: Any = _MISSING, bind: ModelBinding | None = None, key: str | None = None, **props: Unpack[CheckableOptions]) -> None: self._input_control("CheckBox", name, False, default, bind, {"label": label, **props}, key)
    def choice_picker(self, name: str, *, options: list[dict[str, Any]], default: Any = _MISSING, bind: ModelBinding | None = None, key: str | None = None, **props: Unpack[ChoicePickerOptions]) -> None: self._input_control("ChoicePicker", name, [], default, bind, {"options": options, **props}, key)
    def slider(self, name: str, minimum: float, maximum: float, *, default: Any = _MISSING, bind: ModelBinding | None = None, key: str | None = None, **props: Unpack[SliderOptions]) -> None: self._input_control("Slider", name, minimum, default, bind, {"min": minimum, "max": maximum, **props}, key)
    def date_time_input(self, name: str, *, default: Any = _MISSING, bind: ModelBinding | None = None, key: str | None = None, **props: Unpack[DateTimeInputOptions]) -> None: self._input_control("DateTimeInput", name, "", default, bind, props, key)

    def build(self) -> Declaration:
        for name in list(self._data["inputs"]):
            if name not in self._uncontrolled_inputs:
                del self._data["inputs"][name]
        return Declaration(surface_id=self.surface_id, catalog_id=self.catalog.id, root=self._root, data=self._data, locals=self._locals, required_capabilities=self._required_capabilities)

def _validate_pointer(path: str) -> None:
    if path and not path.startswith("/"):
        raise DeclarationError(f"local path must be a JSON Pointer: {path!r}")

def _local_path(key: str, path: str) -> str:
    return f"/$local/{_escape_pointer(key)}{path}"

def _resolve_local_values(value: Any) -> Any:
    if isinstance(value, dict) and isinstance(value.get("$local"), str) and isinstance(value.get("path"), str):
        return {"path": _local_path(value["$local"], value["path"])}
    if isinstance(value, dict):
        return {key: _resolve_local_values(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_resolve_local_values(item) for item in value]
    return value
