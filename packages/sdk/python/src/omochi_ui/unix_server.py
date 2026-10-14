from __future__ import annotations

import asyncio
import atexit
import json
import os
import re
import shutil
import socket as socket_module
import stat
import tempfile
from collections.abc import AsyncIterator
from contextlib import suppress
from pathlib import Path
from typing import Any

from .snapshot import A2uiSnapshot
from .transport import Transport

# Mirrors the id constraint the hub applies, so "<service_id>/<surface_id>" stays splittable.
SERVICE_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

# Linux caps sun_path at 108 bytes and macOS at 104; leave room for the null terminator.
_MAX_SOCKET_PATH_BYTES = 100

_SOCKET_FILE_NAME = "a2ui.sock"


def validate_service_id(service_id: str) -> str:
    # "." and ".." match the character class but would collapse or escape the service directory.
    if service_id in (".", "..") or not SERVICE_ID_PATTERN.match(service_id):
        raise ValueError(f"service_id must match {SERVICE_ID_PATTERN.pattern} and cannot be '.' or '..': {service_id!r}")
    return service_id


def omochi_runtime_root() -> Path:
    """Resolves the directory holding one subdirectory per published service.

    ``$XDG_RUNTIME_DIR`` is per-user and mode 0700, and that permission is the entire
    local trust boundary. A world-writable ``/tmp/omochi`` is never used, because another
    local user could pre-create a service directory and squat the socket.
    """
    configured = os.environ.get("XDG_RUNTIME_DIR")
    if configured:
        return Path(configured) / "omochi"
    return Path(tempfile.gettempdir()) / f"omochi-{os.getuid()}" / "omochi"


def _is_socket_in_use(path: Path) -> bool:
    probe = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
    probe.settimeout(0.5)
    try:
        probe.connect(str(path))
    except OSError:
        return False
    else:
        return True
    finally:
        probe.close()


class UnixSocketServerTransport(Transport):
    """Publishes one application on a unix domain socket and advertises it for discovery.

    The transport writes ``<runtime_dir>/<service_id>/manifest.json`` next to the socket
    so a hub can find it without configuration. Reaching the socket is the
    authentication: the runtime directory is mode 0700, so only the owning user can
    connect.

    Like the TypeScript ``WebSocketServerTransport`` it fans one application out to every
    connected renderer and merges their inbound messages into a single stream.
    """

    def __init__(
        self,
        service_id: str,
        *,
        name: str | None = None,
        icon: str | None = None,
        runtime_dir: str | os.PathLike[str] | None = None,
        capabilities: set[str] | None = None,
    ):
        self._service_id = validate_service_id(service_id)
        self._name = name or self._service_id
        self._icon = icon
        self._root = Path(runtime_dir) if runtime_dir is not None else omochi_runtime_root()
        self.capabilities = capabilities or set()
        self._snapshot = A2uiSnapshot()
        self._writers: set[asyncio.StreamWriter] = set()
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._server: asyncio.AbstractServer | None = None
        self._directory: Path | None = None
        self._start_lock = asyncio.Lock()
        self._closed = False
        atexit.register(self._cleanup_sync)

    @property
    def directory(self) -> Path | None:
        return self._directory

    @property
    def socket_path(self) -> Path | None:
        return self._directory / _SOCKET_FILE_NAME if self._directory else None

    async def start(self) -> None:
        """Publishes the socket and manifest. Called automatically on first use."""
        async with self._start_lock:
            if self._server is not None or self._closed:
                return
            directory = self._root / self._service_id
            directory.mkdir(parents=True, exist_ok=True)
            try:
                await self._listen(directory)
            except BaseException:
                # Leave no empty directory behind for a discovery pass to walk into.
                # rmdir refuses a non-empty directory, so a live service is never touched.
                with suppress(OSError):
                    directory.rmdir()
                raise

    async def _listen(self, directory: Path) -> None:
        # mkdir's mode is masked by umask and leaves an existing directory untouched.
        self._root.chmod(0o700)
        directory.chmod(0o700)
        path = directory / _SOCKET_FILE_NAME
        if len(str(path).encode()) > _MAX_SOCKET_PATH_BYTES:
            raise ValueError(f"unix socket path is too long for this platform: {path}")
        if path.exists():
            # A path that still accepts connections means another instance owns this
            # service id; the probe doubles as the mutual-exclusion primitive.
            if _is_socket_in_use(path):
                raise RuntimeError(f"another omochi service already owns {path}")
            path.unlink()
        self._server = await asyncio.start_unix_server(self._accept, path=str(path))
        # Linux enforces unix socket permissions on connect, and bind applies the umask.
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
        self._directory = directory
        manifest: dict[str, Any] = {"name": self._name, "socket": _SOCKET_FILE_NAME}
        if self._icon is not None:
            manifest["icon"] = self._icon
        # Advertise only once the socket accepts connections, so a readable manifest
        # is always connectable.
        self._write_manifest(directory, manifest)

    async def send(self, message: dict[str, Any]) -> None:
        await self.start()
        self._snapshot.apply(message)
        line = json.dumps(message, separators=(",", ":"), ensure_ascii=False) + "\n"
        for writer in list(self._writers):
            self._write(writer, line)

    async def receive(self) -> AsyncIterator[dict[str, Any]]:
        await self.start()
        while not self._closed:
            message = await self._queue.get()
            if message is None:  # type: ignore[comparison-overlap]
                return
            yield message

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        atexit.unregister(self._cleanup_sync)
        # Retract the advertisement before tearing the socket down.
        if self._directory is not None:
            shutil.rmtree(self._directory, ignore_errors=True)
        for writer in list(self._writers):
            writer.close()
        self._writers.clear()
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        # Releases a consumer parked on receive().
        self._queue.put_nowait(None)  # type: ignore[arg-type]

    @staticmethod
    def _write_manifest(directory: Path, manifest: dict[str, Any]) -> None:
        """Publishes atomically so a discovery pass never reads a half-written file."""
        temporary = directory / f".manifest.{os.getpid()}.tmp"
        temporary.write_text(json.dumps(manifest, ensure_ascii=False) + "\n")
        temporary.chmod(stat.S_IRUSR | stat.S_IWUSR)
        temporary.replace(directory / "manifest.json")

    @staticmethod
    def _write(writer: asyncio.StreamWriter, line: str) -> None:
        if writer.is_closing():
            return
        try:
            writer.write(line.encode())
        except OSError:
            pass

    async def _accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._writers.add(writer)
        try:
            for message in self._snapshot.messages():
                self._write(writer, json.dumps(message, separators=(",", ":"), ensure_ascii=False) + "\n")
            await writer.drain()
            while line := await reader.readline():
                text = line.decode().strip()
                if not text:
                    continue
                try:
                    message = json.loads(text)
                except ValueError:
                    break
                # "{error}" is a valid client message but carries no action for the
                # Runtime to invoke; dropping it keeps a client-side report from tearing
                # the application down.
                if isinstance(message, dict) and "action" in message:
                    self._queue.put_nowait(message)
        except (ConnectionError, OSError):
            pass
        finally:
            self._writers.discard(writer)
            writer.close()

    def _cleanup_sync(self) -> None:
        """Last-resort cleanup: interpreter shutdown cannot await ``close()``."""
        if self._directory is not None:
            shutil.rmtree(self._directory, ignore_errors=True)
