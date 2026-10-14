from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from omochi_ui import App, UnixSocketServerTransport


def counter_app() -> App:
    app = App({"count": 0})

    @app.action("increment")
    async def increment(input, context):
        await context.update(lambda current: current.update(count=current["count"] + 1))

    @app.surface("main")
    def main(ui, current):
        ui.text(f"Count: {current['count']}", key="count")
        ui.button("Increment", increment.call(None), key="increment")

    return app


async def read_messages(reader: asyncio.StreamReader, count: int) -> list[dict]:
    messages = []
    while len(messages) < count:
        line = await asyncio.wait_for(reader.readline(), timeout=5)
        if not line:
            raise AssertionError("the service closed the connection")
        if line.strip():
            messages.append(json.loads(line))
    return messages


class UnixSocketServerTransportTests(unittest.TestCase):
    def test_publishes_and_cleans_up_a_discoverable_service(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root:
                transport = UnixSocketServerTransport("demo", name="Demo", icon="🎤", runtime_dir=root)
                running = asyncio.create_task(counter_app().start(transport))
                await transport.start()

                directory = Path(root) / "demo"
                self.assertEqual(transport.directory, directory)
                self.assertEqual(
                    json.loads((directory / "manifest.json").read_text()),
                    {"name": "Demo", "socket": "a2ui.sock", "icon": "🎤"},
                )
                self.assertEqual(directory.stat().st_mode & 0o777, 0o700)

                reader, writer = await asyncio.open_unix_connection(str(transport.socket_path))
                initial = await read_messages(reader, 3)
                self.assertEqual(initial[0]["createSurface"]["surfaceId"], "main")
                writer.close()

                await transport.close()
                await running
                self.assertFalse(directory.exists())

        asyncio.run(scenario())

    def test_fans_out_and_snapshots_for_a_late_client(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root:
                transport = UnixSocketServerTransport("demo", runtime_dir=root)
                running = asyncio.create_task(counter_app().start(transport))
                await transport.start()
                path = str(transport.socket_path)

                reader, writer = await asyncio.open_unix_connection(path)
                await read_messages(reader, 3)
                writer.write((json.dumps({
                    "version": "v0.9",
                    "action": {
                        "name": "increment",
                        "surfaceId": "main",
                        "sourceComponentId": "increment",
                        "timestamp": "2026-08-12T00:00:00.000Z",
                        "context": {},
                    },
                }) + "\n").encode())
                await writer.drain()
                await read_messages(reader, 1)

                late_reader, late_writer = await asyncio.open_unix_connection(path)
                replay = await read_messages(late_reader, 3)
                components = next(m for m in replay if "updateComponents" in m)
                labels = {c["id"]: c.get("text") for c in components["updateComponents"]["components"]}
                self.assertEqual(labels["count"], "Count: 1")

                writer.close()
                late_writer.close()
                await transport.close()
                await running

        asyncio.run(scenario())

    def test_rejects_a_service_id_that_would_escape_the_runtime_directory(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            for service_id in (".", "..", "a/b", "", "x" * 65):
                with self.assertRaises(ValueError):
                    UnixSocketServerTransport(service_id, runtime_dir=root)

    def test_refuses_a_second_instance_and_recovers_a_stale_socket(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as root:
                first = UnixSocketServerTransport("demo", runtime_dir=root)
                running = asyncio.create_task(counter_app().start(first))
                await first.start()

                duplicate = UnixSocketServerTransport("demo", runtime_dir=root)
                with self.assertRaises(RuntimeError):
                    await duplicate.start()
                await duplicate.close()

                await first.close()
                await running

                # A socket file left behind by a crash must not block the next start.
                (Path(root) / "demo").mkdir(exist_ok=True)
                (Path(root) / "demo" / "a2ui.sock").touch()
                restarted = UnixSocketServerTransport("demo", runtime_dir=root)
                second = asyncio.create_task(counter_app().start(restarted))
                await restarted.start()
                self.assertIsNotNone(restarted.socket_path)
                await restarted.close()
                await second

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
