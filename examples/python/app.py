import asyncio
import os
from dataclasses import dataclass

from omochi_ui import App, UnixSocketServerTransport


@dataclass
class State:
    temperature: int = 50
    result: str | None = None

@dataclass
class RunInput:
    temperature: int


app = App(State())


@app.action("run")
async def run(input: RunInput, context):
    await context.update(lambda state: (setattr(state, "temperature", input.temperature), setattr(state, "result", f"Ran at temperature {input.temperature}")))


@app.surface("main")
def main(ui, state):
    form = ui.local("form", {"temperature": state.temperature})
    ui.text("Hello", key="title", variant="h2")
    ui.slider("temperature", 0, 100, bind=form.bind("/temperature"))
    ui.button("Run", run.call({"temperature": form.value("/temperature")}), variant="primary")
    if state.result:
        ui.text(state.result, key="result")


def transport():
    """Publishes on a discoverable unix socket when OMOCHI_SERVICE names a service id.

    Without it the app speaks JSONL on stdio, which is what `omochi-ui dev` expects.
    """
    service_id = os.environ.get("OMOCHI_SERVICE")
    if not service_id:
        return None
    return UnixSocketServerTransport(service_id, name="Python example", icon="🐍")


if __name__ == "__main__":
    asyncio.run(app.start(transport()))
