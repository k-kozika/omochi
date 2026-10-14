import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "@omochi-ui/core/testing";
import { actionMessage, waitFor } from "@omochi-ui/core/testing";
import { CommandButton } from "../src/button.js";
import { observe, publisherFor, temporary } from "./helpers.js";

test("button waits for click, inherits cwd/env, preserves argv, streams output and suppresses concurrent clicks", async (t) => {
  const publisher = await publisherFor(t);
  const cwd = await temporary(t);
  const marker = path.join(cwd, "runs");
  process.env.OMOCHI_UTILS_TEST = "inherited";
  t.after(() => { delete process.env.OMOCHI_UTILS_TEST; });
  const button = new CommandButton(publisher, {
    name: "Build", cwd,
    command: [process.execPath, "-e", "require('fs').appendFileSync('runs','x');console.log(process.cwd(),process.env.OMOCHI_UTILS_TEST,process.argv[1]);console.error('stderr');setTimeout(()=>process.exit(7),300)", "literal $(echo bad)"],
  });
  t.after(() => button.close());
  await button.start();
  const observer = observe(t, publisher.transport.socketPath!);
  await waitFor(() => observer.text().includes("Ready"));
  await assert.rejects(access(marker));
  const click = () => observer.socket.write(JSON.stringify(actionMessage("main", {})) + "\n");
  click(); click();
  await waitFor(() => observer.text().includes("Running") && observer.text().includes("inherited"));
  assert.ok(observer.text().includes(cwd));
  assert.ok(observer.text().includes("literal $(echo bad)"));
  assert.ok(observer.text().includes("stderr"));
  await waitFor(() => observer.text().includes("Exited with code 7"));
  assert.equal(await readFile(marker, "utf8"), "x");
  click();
  await waitFor(async () => (await readFile(marker, "utf8")) === "xx");
  await waitFor(() => observer.text().includes("Exited with code 7"));
});

test("spawn failure remains visible and the service survives", async (t) => {
  const publisher = await publisherFor(t);
  const button = new CommandButton(publisher, { name: "Missing", command: ["/omochi-test/no-such-executable"] });
  t.after(() => button.close());
  await button.start();
  const observer = observe(t, publisher.transport.socketPath!);
  observer.socket.write(JSON.stringify(actionMessage("main", {})) + "\n");
  await waitFor(() => observer.text().includes("Failed to start:"));
  assert.deepEqual(publisher.list().surfaceIds, ["main"]);
});

test("output is bounded to a UTF-8 tail", async (t) => {
  const publisher = await publisherFor(t);
  const button = new CommandButton(publisher, { name: "Output", command: [process.execPath, "-e", "console.log('あ'.repeat(40000)+'END')"] });
  t.after(() => button.close());
  await button.start();
  const observer = observe(t, publisher.transport.socketPath!);
  observer.socket.write(JSON.stringify(actionMessage("main", {})) + "\n");
  await waitFor(() => observer.text().includes("Exited with code 0"));
  const text = observer.text();
  assert.match(text, /Earlier output truncated/);
  assert.match(text, /END/);
  assert.ok(!text.includes("�"));
  assert.ok(Buffer.byteLength(text) < 68_000);
});

test("shutdown kills a command and its TERM-resistant child", { timeout: 5000 }, async (t) => {
  const publisher = await publisherFor(t);
  const button = new CommandButton(publisher, { name: "Long running", command: [process.execPath, "-e", `
    const child = require('child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); console.log('descendant='+process.pid); setInterval(()=>{},1000)"], {stdio:'inherit'});
    console.log('leader='+process.pid);
    process.on('SIGTERM',()=>{});
    setInterval(()=>{},1000);
  `] });
  t.after(() => button.close());
  await button.start();
  const observer = observe(t, publisher.transport.socketPath!);
  observer.socket.write(JSON.stringify(actionMessage("main", {})) + "\n");
  await waitFor(() => observer.text().includes("descendant="));
  const leader = Number(observer.text().match(/leader=(\d+)/)![1]);
  await button.close();
  // close() awaits the child's close event, including pipes held by descendants.
  assert.throws(() => process.kill(leader, 0), { code: "ESRCH" });
});
