import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "@omochi-ui/core/testing";
import { actionMessage, waitFor } from "@omochi-ui/core/testing";
import { CommandWatch } from "../src/watch.js";
import { observe, publisherFor, temporary } from "./helpers.js";

test("watch runs immediately without overlap, shows diffs and history, and pauses", async (t) => {
  const publisher = await publisherFor(t);
  const cwd = await temporary(t);
  const marker = path.join(cwd, "count");
  const watch = new CommandWatch(publisher, {
    name: "Status", cwd, intervalMs: 80, diff: true, onChange: false, history: 3,
    command: [process.execPath, "-e", "const f='count',fs=require('fs');const n=fs.existsSync(f)?Number(fs.readFileSync(f))+1:1;fs.writeFileSync(f,String(n));console.log('value='+n)"],
  });
  t.after(() => watch.close());
  const observer = observe(t, publisher.transport.socketPath!);
  await watch.start();
  await waitFor(() => observer.text().includes("value=2") && observer.text().includes("previous") && observer.text().includes("History"));
  observer.socket.write(JSON.stringify(namedAction("pause")) + "\n");
  await waitFor(() => observer.text().includes("Paused"));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const count = await readFile(marker, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(await readFile(marker, "utf8"), count);
});

test("watch on-change suppresses identical completed renders", async (t) => {
  const publisher = await publisherFor(t);
  const watch = new CommandWatch(publisher, {
    name: "Stable", intervalMs: 40, diff: false, onChange: true,
    command: [process.execPath, "-e", "console.log('same')"],
  });
  t.after(() => watch.close());
  const observer = observe(t, publisher.transport.socketPath!);
  await watch.start();
  await waitFor(() => observer.text().includes("same") && observer.text().includes("Exited with code 0"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const messages = observer.messages.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(observer.messages.length, messages);
});

test("watch stops commands that exceed the configured timeout", async (t) => {
  const publisher = await publisherFor(t);
  const watch = new CommandWatch(publisher, {
    name: "Timeout", intervalMs: 60_000, timeoutMs: 50, diff: false, onChange: false,
    command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
  });
  t.after(() => watch.close());
  const observer = observe(t, publisher.transport.socketPath!);
  await watch.start();
  await waitFor(() => observer.text().includes("Timed out"));
});

function namedAction(name: string): unknown {
  const message = actionMessage("main", {}) as { action: { name: string } };
  message.action.name = name;
  return message;
}

for (const history of [undefined, 0, 2]) {
  test(`watch retains only enabled history (limit ${history})`, async (t) => {
    const publisher = await publisherFor(t);
    const watch = new CommandWatch(publisher, {
      name: "History", intervalMs: 60_000, diff: false, onChange: false, history,
      command: [process.execPath, "-e", "console.log('completed')"],
    });
    t.after(() => watch.close());
    const internal = watch as unknown as {
      run(): Promise<void>;
      onAction(name: string): void;
      entries: unknown[];
    };
    internal.onAction("pause");
    for (let run = 0; run < 5; run++) {
      await internal.run();
      assert.equal(internal.entries.length, Math.min(run + 1, history ?? 0));
    }
  });
}
