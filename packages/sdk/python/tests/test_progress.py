import asyncio
import json
import unittest
from pathlib import Path

from omochi_ui import App
from omochi_ui.builder import Tab


class MemoryTransport:
    capabilities = set()

    def __init__(self):
        self.sent = []
        self.fail = False

    async def send(self, message):
        if self.fail:
            raise RuntimeError("send failed")
        self.sent.append(message)

    async def receive(self):
        for message in []:
            yield message


class ProgressTests(unittest.IsolatedAsyncioTestCase):
    async def test_tabs_fixture(self):
        fixture = json.loads((Path(__file__).parents[4] / "spec/fixtures/tabs.json").read_text())
        app = App({"title": "Second"})

        @app.surface("main")
        def view(ui, state):
            ui.tabs([
                Tab("First", lambda ui: ui.text("A", key="first")),
                Tab(state["title"], lambda ui: ui.text("B", key="second")),
            ], key="tabs")

        runtime = app.build()
        self.assertEqual(runtime.render()[1]["updateComponents"]["components"], fixture["initialComponents"])
        messages = await runtime.update(lambda s: s.update(title="Renamed"))
        self.assertEqual(messages, [{"version": "v0.9", "updateComponents": {
            "surfaceId": "main", "components": fixture["afterUpdateComponents"],
        }}])

    async def test_progress_before_completion(self):
        entered, release = asyncio.Event(), asyncio.Event()
        app = App({"status": "idle"})
        for surface_id in ["one", "two"]:
            app.surface(surface_id)(lambda ui, state: ui.text(state["status"], key="status"))

        @app.action("work")
        async def work(_, ctx):
            await ctx.update(lambda s: s.update(status="working"))
            entered.set()
            await release.wait()
            await ctx.update(lambda s: s.update(status="done"))
            await ctx.update(lambda s: None)

        runtime = app.build()
        transport = MemoryTransport()
        await runtime.start(transport)
        transport.sent.clear()
        task = asyncio.create_task(runtime.invoke("work", None))
        try:
            await asyncio.wait_for(entered.wait(), 3)
            self.assertEqual(len(transport.sent), 2)
            self.assertEqual(transport.sent[0]["updateComponents"]["components"][0]["text"], "working")
        finally:
            release.set()
        messages = await task
        self.assertEqual(messages, transport.sent)
        self.assertEqual(len(messages), 4)

    async def test_concurrent_context_updates_and_offline_result(self):
        app = App({"value": 0})
        app.surface("main")(lambda ui, s: ui.text(str(s["value"]), key="value"))

        @app.action("work")
        async def work(_, ctx):
            async def first(state):
                await asyncio.sleep(0)
                state["value"] = 1
            await asyncio.gather(ctx.update(first), ctx.update(lambda s: s.update(value=2)))

        runtime = app.build()
        runtime.render()
        messages = await runtime.invoke("work", None)
        self.assertEqual([m["updateComponents"]["components"][0]["text"] for m in messages], ["1", "2"])

    async def test_errors_do_not_rollback_or_hold_lock(self):
        state = {"value": 0}
        app = App(state)
        app.surface("main")(lambda ui, s: ui.text(str(s["value"]), key="value"))

        @app.action("fail")
        async def fail(_, ctx):
            await ctx.update(lambda s: s.update(value=1))
            raise RuntimeError("action failed")

        @app.action("set")
        async def set_value(_, ctx):
            await ctx.update(lambda s: s.update(value=s["value"] + 1))

        runtime = app.build()
        transport = MemoryTransport()
        await runtime.start(transport)
        transport.sent.clear()
        with self.assertRaisesRegex(RuntimeError, "action failed"):
            await runtime.invoke("fail", None)
        self.assertEqual(state["value"], 1)
        self.assertEqual(len(transport.sent), 1)
        transport.fail = True
        with self.assertRaisesRegex(RuntimeError, "send failed"):
            await runtime.invoke("set", None)
        transport.fail = False
        self.assertEqual(len(await asyncio.wait_for(runtime.invoke("set", None), 3)), 1)
