import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import type { TestContext } from "@omochi-ui/core/testing";
import { A2uiSnapshot } from "@omochi-ui/core";
import { Publisher } from "../src/publisher.js";

export async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "omochi-utils-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function publisherFor(t: TestContext) {
  const root = await temporary(t);
  const publisher = await Publisher.open({ serviceId: "test", runtimeDir: root });
  t.after(() => publisher.close());
  return publisher;
}

export function observe(t: TestContext, socketPath: string) {
  const socket = connect(socketPath);
  const snapshot = new A2uiSnapshot();
  const messages: unknown[] = [];
  const lines = createInterface({ input: socket });
  lines.on("line", (line) => {
    const message: unknown = JSON.parse(line);
    messages.push(message);
    snapshot.apply(message);
  });
  t.after(() => { lines.close(); socket.destroy(); });
  return { socket, snapshot, messages, text: () => JSON.stringify(snapshot.messages()) };
}
