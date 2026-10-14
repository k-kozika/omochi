import { App } from "@omochi-ui/sdk";
import { UnixSocketServerTransport } from "@omochi-ui/sdk/node";

const state: { temperature: number; result: string | null } = {
  temperature: 50,
  result: null,
};

const app = new App(state);

const run = app.action<{ temperature: number }>("run", async (input, context) => {
  await context.update((current) => { current.temperature = input.temperature; current.result = `Ran at temperature ${input.temperature}`; });
});

app.surface("main", (ui, current) => {
  const form = ui.local("form", { temperature: current.temperature });
  ui.text("Hello", { key: "title", variant: "h2" });
  ui.slider("temperature", 0, 100, { bind: form.bind("/temperature") });
  ui.button("Run", run.call({ temperature: form.value("/temperature") }), { variant: "primary" });
  if (current.result) ui.text(current.result, { key: "result" });
});

// Publishes on a discoverable unix socket when OMOCHI_SERVICE names a service id.
// Without it the app speaks JSONL on stdio, which is what `omochi-ui dev` expects.
const serviceId = process.env.OMOCHI_SERVICE;
await app.start(
  serviceId
    ? new UnixSocketServerTransport({ serviceId, name: "TypeScript example", icon: "\u{1F537}" })
    : undefined,
);
