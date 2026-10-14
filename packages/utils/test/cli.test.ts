import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@omochi-ui/core/testing";
import { waitFor } from "@omochi-ui/core/testing";
import { temporary } from "./helpers.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("help and invalid arguments do not publish a service", async () => {
  for (const [args, code] of [
    [[], 0],
    [["button", "--help"], 0],
    [["mcp", "--cwd", "/tmp"], 2],
    [["button"], 2],
    [["watch", "--interval", "2", "--", "true"], 2],
    [["watch", "--history", "101", "--", "true"], 2],
    [["process", "--restart", "sometimes", "--", "true"], 2],
    [["tail"], 2],
    [["stream", "extra"], 2],
    [["http", "ftp://example.test"], 2],
    [["http", "--expect-status", "500-200", "http://example.test"], 2],
  ] as const) {
    const child = spawn(process.execPath, [cli, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    const [exitCode] = await once(child, "close");
    assert.equal(exitCode, code);
    assert.match(code === 0 ? stdout : stderr, /Usage:/);
    assert.equal(code === 0 ? stderr : stdout, "");
  }
});

test("MCP EOF and SIGTERM retract the service and exit cleanly", { timeout: 10_000 }, async (t) => {
  const directory = await temporary(t);
  for (const termination of ["eof", "signal"] as const) {
    const child = spawn(process.execPath, [cli, "mcp", "--service-id", termination], { env: { ...process.env, XDG_RUNTIME_DIR: directory } });
    t.after(() => { child.kill("SIGKILL"); });
    const exited = once(child, "close");
    const manifest = path.join(directory, "omochi", termination, "manifest.json");
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.stdout.on("data", (data) => { stdout += String(data); });
    await waitFor(() => stderr.includes("Published service"));
    await access(manifest);
    if (termination === "eof") child.stdin.end();
    else child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
    await assert.rejects(access(manifest));
    assert.equal(stdout, "", "only MCP frames may be written to stdout");
  }
});
