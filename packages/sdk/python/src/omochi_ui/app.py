from __future__ import annotations

import asyncio
import inspect
from copy import deepcopy
from dataclasses import dataclass, is_dataclass
from typing import Any, Callable, Generic, TypeVar, cast, get_type_hints

from .builder import UI
from .catalog import BASIC_CATALOG, Catalog
from .errors import DeclarationError, ProtocolError
from .reconcile import Reconciler
from .transport import StdioTransport, Transport

InputType = TypeVar("InputType")
StateType = TypeVar("StateType")
UIType = TypeVar("UIType", bound=UI)

@dataclass(frozen=True, slots=True)
class ActionCall:
    action: str
    input: Any

class Action(Generic[InputType]):
    def __init__(self, name: str): self.name = name
    def call(self, input: InputType) -> ActionCall: return ActionCall(self.name, deepcopy(input))

class ActionContext(Generic[StateType]):
    def __init__(self, runtime: "Runtime[StateType, Any]"):
        self._runtime = runtime
        self._messages: list[dict[str, Any]] = []
        self._update_lock = asyncio.Lock()
        self._active = True
    async def update(self, mutator: Callable[[StateType], Any]) -> None:
        # The invocation holds the Runtime lock; only serialize its own updates here.
        async with self._update_lock:
            if not self._active: raise DeclarationError("action has already completed")
            result = mutator(self._runtime.state)
            if inspect.isawaitable(result): await result
            self._runtime._revision += 1
            self._messages.extend(await self._runtime._render_all_and_send())

class App(Generic[StateType, UIType]):
    def __init__(self, state: StateType, *, catalog: Catalog[UIType] = cast(Catalog[UIType], BASIC_CATALOG)):
        self.state, self.catalog = state, catalog
        self._views: dict[str, Callable[[UIType, StateType], Any]] = {}
        self._actions: dict[str, Callable[..., Any]] = {}
        self._built = False
    def surface(self, surface_id: str = "main"):
        def register(view):
            if self._built: raise DeclarationError("app is already built")
            if surface_id in self._views: raise DeclarationError(f"surface already registered: {surface_id!r}")
            self._views[surface_id] = view
            return view
        return register
    def action(self, name: str | Callable[..., Any] | None = None):
        explicit = name if isinstance(name, str) else None
        def register(handler):
            action_name = explicit or handler.__name__
            if self._built: raise DeclarationError("app is already built")
            if action_name in self._actions: raise DeclarationError(f"action already registered: {action_name!r}")
            self._actions[action_name] = handler
            return Action(action_name)
        return register(name) if callable(name) else register
    def build(self) -> "Runtime[StateType, UIType]":
        if self._built: raise DeclarationError("app is already built")
        self._built = True
        return Runtime(self.state, self.catalog, self._views, self._actions)
    async def start(self, transport: Transport | None = None) -> None:
        await self.build().start(transport)

class Runtime(Generic[StateType, UIType]):
    def __init__(self, state, catalog, views, actions):
        self.state, self.catalog = state, catalog
        self._views, self._actions = dict(views), dict(actions)
        self._reconciler = Reconciler()
        self._transport: Transport | None = None
        self._lock = asyncio.Lock()
        self._revision = 0
        self._started = False
        self._ready = asyncio.Event()
        self._closed = asyncio.Event()
        self._tasks: set[asyncio.Task[Any]] = set()
        self._pending_updates: list[tuple[Callable[[StateType], Any], asyncio.Future[Any]]] = []
        self._update_scheduled = False
    @property
    def app_revision(self): return self._revision
    def declaration(self, surface_id: str):
        try: view = self._views[surface_id]
        except KeyError as error: raise DeclarationError(f"unknown surface: {surface_id!r}") from error
        ui_type = self.catalog.ui_type or cast(type[UIType], UI)
        ui = ui_type(surface_id, self.catalog, lambda _: "")
        view(ui, self.state)
        return ui.build()
    def render(self, surface_id: str = "main") -> list[dict[str, Any]]:
        return self._reconciler.render(self.declaration(surface_id))
    def surface(self, surface_id: str = "main") -> list[dict[str, Any]]:
        return Reconciler(set(self._reconciler.capabilities)).render(self.declaration(surface_id))
    async def _render_all_and_send(self):
        messages = []
        for surface_id in self._views:
            current = self.render(surface_id); messages.extend(current)
            if self._transport:
                for message in current: await self._transport.send(message)
        return messages
    async def update(self, mutator):
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending_updates.append((mutator, future))
        if not self._update_scheduled:
            self._update_scheduled = True
            loop.call_soon(lambda: asyncio.create_task(self._flush_updates()))
        return await future
    async def _flush_updates(self):
        async with self._lock:
            batch = self._pending_updates[:]
            self._pending_updates.clear(); self._update_scheduled = False
            try:
                for mutator, _ in batch:
                    result = mutator(self.state)
                    if inspect.isawaitable(result): await result
                    self._revision += 1
                messages = await self._render_all_and_send()
                for _, future in batch:
                    if not future.done(): future.set_result(messages)
            except Exception as error:
                for _, future in batch:
                    if not future.done(): future.set_exception(error)
    async def invoke(self, name: str, input: Any):
        try: handler = self._actions[name]
        except KeyError as error: raise ProtocolError(f"unknown action: {name!r}") from error
        async with self._lock:
            context = ActionContext(self)
            value = _coerce_input(handler, input)
            try:
                result = handler(value, context)
                if inspect.isawaitable(result): await result
            finally:
                context._active = False
                # Finish an in-flight update before releasing the Runtime lock.
                async with context._update_lock:
                    pass
            return context._messages
    async def handle(self, message: dict[str, Any]):
        if message.get("type") == "getSurface":
            if not isinstance(message.get("surface"), str): raise ProtocolError("getSurface must contain string surface")
            return self.surface(message["surface"])
        if message.get("type") == "invoke":
            if not isinstance(message.get("action"), str): raise ProtocolError("invoke must contain string action")
            return await self.invoke(message["action"], message.get("input"))
        payload = message.get("action", message)
        name = payload.get("name") if isinstance(payload, dict) else None
        if not isinstance(name, str): raise ProtocolError("action must contain string name")
        context = payload.get("context") or {}
        return await self.invoke(name, context.get("input", payload.get("input")))
    dispatch = handle
    async def ready(self): await self._ready.wait()
    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine); self._tasks.add(task); task.add_done_callback(self._tasks.discard); return task
    async def shutdown(self):
        for task in self._tasks: task.cancel()
        if self._tasks: await asyncio.gather(*self._tasks, return_exceptions=True)
        self._closed.set()
    async def wait_closed(self): await self._closed.wait()
    async def start(self, transport: Transport | None = None):
        if self._started: raise DeclarationError("runtime has already been started")
        self._started = True; self._transport = transport or StdioTransport()
        self._reconciler = Reconciler(set(self._transport.capabilities))
        await self._render_all_and_send(); self._ready.set()
        try:
            async for message in self._transport.receive():
                responses = await self.handle(message)
                if message.get("type") == "getSurface":
                    for response in responses: await self._transport.send(response)
        finally: await self.shutdown()

def _coerce_input(handler, value):
    parameters = list(inspect.signature(handler).parameters.values())
    if not parameters: return value
    annotation = get_type_hints(handler).get(parameters[0].name, parameters[0].annotation)
    if annotation is inspect.Parameter.empty: return value
    if isinstance(value, dict) and isinstance(annotation, type) and is_dataclass(annotation): return annotation(**value)
    return value
