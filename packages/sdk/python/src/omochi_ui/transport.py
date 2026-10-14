from __future__ import annotations

import asyncio
import json
import sys
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any


class Transport(ABC):
    capabilities: set[str] = set()

    @abstractmethod
    async def send(self, message: dict[str, Any]) -> None: ...

    @abstractmethod
    def receive(self) -> AsyncIterator[dict[str, Any]]: ...


class StdioTransport(Transport):
    """Newline-delimited JSON over stdin/stdout."""

    def __init__(self, *, capabilities: set[str] | None = None):
        self.capabilities = capabilities or set()

    async def send(self, message: dict[str, Any]) -> None:
        line = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
        # A JSONL write is small and stdout's text wrapper is not reliably safe
        # to drive from multiple executor threads while stdin is also blocked.
        self._write(line)

    @staticmethod
    def _write(line: str) -> None:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()

    async def receive(self) -> AsyncIterator[dict[str, Any]]:
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        loop = asyncio.get_running_loop()
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)
        while line := await reader.readline():
            text = line.decode()
            if text.strip():
                yield json.loads(text)


class CallbackTransport(Transport):
    """Adapts any WebSocket-like integration without coupling the core to a library."""

    def __init__(
        self,
        send: Callable[[dict[str, Any]], Awaitable[None]],
        receive: Callable[[], AsyncIterator[dict[str, Any]]],
        *,
        capabilities: set[str] | None = None,
    ):
        self._send = send
        self._receive = receive
        self.capabilities = capabilities or set()

    async def send(self, message: dict[str, Any]) -> None:
        await self._send(message)

    def receive(self) -> AsyncIterator[dict[str, Any]]:
        return self._receive()


class WebSocketTransport(CallbackTransport):
    """Wraps an object exposing async send(str) and async iteration of messages."""

    def __init__(self, socket: Any, *, capabilities: set[str] | None = None):
        async def send(message: dict[str, Any]) -> None:
            await socket.send(json.dumps(message, separators=(",", ":"), ensure_ascii=False))

        async def receive() -> AsyncIterator[dict[str, Any]]:
            async for message in socket:
                yield json.loads(message)

        super().__init__(send, receive, capabilities=capabilities)
