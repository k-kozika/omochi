import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "@omochi-ui/core/testing";
import { waitFor } from "@omochi-ui/core/testing";
import { InputStream } from "../src/stream.js";
import { FileTail } from "../src/tail.js";
import { observe, publisherFor, temporary } from "./helpers.js";

test("tail waits for creation and follows appends, replacement, and truncation", { timeout: 8000 }, async (t) => {
  const publisher = await publisherFor(t);
  const directory = await temporary(t);
  const file = path.join(directory, "app.log");
  const tail = new FileTail(publisher, { name: "Log", path: file, lines: 2 });
  t.after(() => tail.close());
  const observer = observe(t, publisher.transport.socketPath!);
  await tail.start();
  await waitFor(() => observer.text().includes("Waiting for"));
  await writeFile(file, "one\ntwo\nthree\n");
  await waitFor(() => observer.text().includes("two") && observer.text().includes("three"));
  await writeFile(file, "one\ntwo\nthree\nfour\n");
  await waitFor(() => observer.text().includes("four"));
  await rename(file, `${file}.1`);
  await writeFile(file, "rotated\n");
  await waitFor(() => observer.text().includes("File replaced") && observer.text().includes("rotated"));
  await writeFile(file, "short\n");
  await waitFor(() => observer.text().includes("File truncated") && observer.text().includes("short"));
});

test("stream publishes input and keeps the surface after EOF", async (t) => {
  const publisher = await publisherFor(t);
  const input = new PassThrough();
  const stream = new InputStream(publisher, { name: "Pipe", input });
  t.after(() => stream.close());
  const observer = observe(t, publisher.transport.socketPath!);
  await stream.start();
  input.write("hello あ");
  input.end(" world");
  await waitFor(() => observer.text().includes("hello あ world") && observer.text().includes("Input closed"));
  assert.deepEqual(publisher.list().surfaceIds, ["main"]);
});
