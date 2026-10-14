import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "@omochi-ui/core/testing";
import { actionMessage, waitFor } from "@omochi-ui/core/testing";
import { CommandProcess } from "../src/process.js";
import { observe, publisherFor, temporary } from "./helpers.js";

test("process starts manually, restarts on failure, and manual stop cancels restarts", async (t) => {
  const publisher = await publisherFor(t);
  const cwd = await temporary(t);
  const marker = path.join(cwd, "runs");
  const processSurface = new CommandProcess(publisher, {
    name: "Worker", cwd, restart: "on-failure", restartDelayMs: 80,
    command: [process.execPath, "-e", "require('fs').appendFileSync('runs','x');process.exit(2)"],
  });
  t.after(() => processSurface.close());
  const observer = observe(t, publisher.transport.socketPath!);
  await processSurface.start();
  await waitFor(() => observer.text().includes("Stopped"));
  observer.socket.write(JSON.stringify(namedAction("start")) + "\n");
  await waitFor(async () => (await readFile(marker, "utf8").catch(() => "")).length >= 2);
  assert.ok(observer.text().includes("automatic restarts"));
  observer.socket.write(JSON.stringify(namedAction("stop")) + "\n");
  await waitFor(() => observer.text().includes("Stopped"));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const count = (await readFile(marker, "utf8")).length;
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal((await readFile(marker, "utf8")).length, count);
});

function namedAction(name: string): unknown {
  const message = actionMessage("main", {}) as { action: { name: string } };
  message.action.name = name;
  return message;
}
