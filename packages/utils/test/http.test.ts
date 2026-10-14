import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "@omochi-ui/core/testing";
import { actionMessage, waitFor } from "@omochi-ui/core/testing";
import { HttpWatch } from "../src/http.js";
import { observe, publisherFor } from "./helpers.js";

test("http formats JSON and records unhealthy and recovered transitions", async (t) => {
  let status = 200;
  const server = createServer((_request, response) => {
    const body = JSON.stringify({ ok: status === 200 });
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const publisher = await publisherFor(t);
  const http = new HttpWatch(publisher, {
    name: "Health", url: `http://127.0.0.1:${address.port}/health`, intervalMs: 60_000, timeoutMs: 1000,
    expectStatus: [200, 299], expectBody: '"ok":true',
  });
  t.after(() => http.close());
  const observer = observe(t, publisher.transport.socketPath!);
  await http.start();
  await waitFor(() => observer.text().includes("Healthy") && observer.text().includes("\\n  \\\"ok\\\": true"));

  status = 503;
  observer.socket.write(JSON.stringify(namedAction("run")) + "\n");
  await waitFor(() => observer.text().includes("Unhealthy") && observer.text().includes("Became unhealthy"));
  status = 200;
  observer.socket.write(JSON.stringify(namedAction("run")) + "\n");
  await waitFor(() => observer.text().includes("Recovered"));
});

function namedAction(name: string): unknown {
  const message = actionMessage("main", {}) as { action: { name: string } };
  message.action.name = name;
  return message;
}
