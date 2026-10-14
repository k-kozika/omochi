from __future__ import annotations

import asyncio
import json
import unittest
from dataclasses import dataclass
from pathlib import Path

from omochi_ui import App, DeclarationError

ROOT = Path(__file__).parents[4]
FIXTURE = json.loads((ROOT / "spec/fixtures/basic.json").read_text())

@dataclass
class RunInput:
    temperature: int

def make_runtime():
    state = {"temperature": 50, "result": None}
    app = App(state)
    @app.action("run")
    async def run(input: RunInput, context):
        await context.update(lambda current: current.update(temperature=input.temperature, result=f"Result: {input.temperature}"))
    @app.surface("main")
    def main(ui, current):
        form = ui.local("form", {"temperature": current["temperature"]})
        ui.text("Hello", key="hello")
        ui.slider("temperature", 0, 100, bind=form.bind("/temperature"))
        ui.button("Run", run.call({"temperature": form.value("/temperature")}))
        if current["result"]: ui.text(current["result"], key="result")
    return app.build(), state

class RuntimeTests(unittest.TestCase):
    def test_shared_fixture(self):
        runtime, state = make_runtime()
        self.assertEqual(runtime.render(), FIXTURE["initialMessages"])
        self.assertEqual(asyncio.run(runtime.handle(FIXTURE["action"])), FIXTURE["afterActionMessages"])
        self.assertEqual(state["temperature"], 75)

    def test_action_is_independent_of_surface(self):
        state = {"value": 0}; app = App(state)
        @app.action("set")
        async def set_value(input, context): await context.update(lambda current: current.update(value=input["value"]))
        runtime = app.build()
        self.assertEqual(asyncio.run(runtime.invoke("set", {"value": 7})), [])
        self.assertEqual(state["value"], 7)

    def test_external_update_renders_all_surfaces(self):
        state = {"value": 0}; app = App(state)
        @app.surface("one")
        def one(ui, current): ui.text(str(current["value"]), key="value")
        @app.surface("two")
        def two(ui, current): ui.text(str(current["value"]), key="value")
        runtime = app.build(); runtime.render("one"); runtime.render("two")
        messages = asyncio.run(runtime.update(lambda current: current.update(value=1)))
        self.assertEqual({message["updateComponents"]["surfaceId"] for message in messages}, {"one", "two"})

    def test_concurrent_updates_are_coalesced(self):
        async def scenario():
            state = {"value": 0}; app = App(state)
            @app.surface("main")
            def main(ui, current): ui.text(str(current["value"]), key="value")
            runtime = app.build(); runtime.render()
            first, second = await asyncio.gather(runtime.update(lambda current: current.update(value=1)), runtime.update(lambda current: current.update(value=2)))
            return state, first, second
        state, first, second = asyncio.run(scenario())
        self.assertEqual(first, second)
        self.assertEqual(state["value"], 2)

    def test_local_initial_is_preserved_until_reset(self):
        state = {"value": "one", "revision": 0}; app = App(state)
        @app.surface("main")
        def main(ui, current):
            form = ui.local("form", {"draft": current["value"]}, reset_key=current["revision"])
            ui.text_field("draft", label="Draft", bind=form.bind("/draft"))
        runtime = app.build(); runtime.render()
        self.assertEqual(asyncio.run(runtime.update(lambda current: current.update(value="two"))), [])
        self.assertEqual(asyncio.run(runtime.update(lambda current: current.update(revision=1))), [{"version": "v0.9", "updateDataModel": {"surfaceId": "main", "path": "/$local/form", "value": {"draft": "two"}}}])

    def test_get_surface_is_full_snapshot(self):
        runtime, _ = make_runtime(); runtime.render()
        self.assertIn("createSurface", asyncio.run(runtime.handle({"type": "getSurface", "surface": "main"}))[0])

    def test_duplicate_local_fails(self):
        app = App({})
        @app.surface("main")
        def main(ui, _): ui.local("x", {}); ui.local("x", {})
        with self.assertRaises(DeclarationError): app.build().render()

if __name__ == "__main__": unittest.main()
