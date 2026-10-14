import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BASIC_CATALOG } from "@omochi-ui/sdk";
import { z } from "zod";
import { Publisher } from "./publisher.js";

const examples = {
  publish: [
    { version: "v0.9", createSurface: { surfaceId: "main", catalogId: BASIC_CATALOG.id, sendDataModel: true } },
    { version: "v0.9", updateComponents: { surfaceId: "main", components: [
      { id: "root", component: "Column", children: ["title", "input", "submit"] },
      { id: "title", component: "Text", text: "What should we build?" },
      { id: "input", component: "TextField", label: "Request", value: { path: "/request" } },
      { id: "submit", component: "Button", child: "submit-label", action: { event: { name: "submit", context: { request: { path: "/request" } } } } },
      { id: "submit-label", component: "Text", text: "Send" },
    ] } },
    { version: "v0.9", updateDataModel: { surfaceId: "main", path: "/", value: { request: "" } } },
  ],
  update: [{ version: "v0.9", updateComponents: { surfaceId: "main", components: [{ id: "title", component: "Text", text: "Working…" }] } }],
  delete: [{ version: "v0.9", deleteSurface: { surfaceId: "main" } }],
};

function result(value: object) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: { ...value } };
}

async function tool(work: () => Promise<object> | object) {
  try { return result(await work()); }
  catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }; }
}

export async function startMcp(publisher: Publisher, onClose: () => void): Promise<McpServer> {
  const server = new McpServer({ name: "omochi-utils", version: "0.1.0" }, {
    instructions: `Publish A2UI v0.9 surfaces to the local Omochi gateway. Basic Catalog: ${BASIC_CATALOG.id}. ` +
      "Use surface-local IDs (no gateway prefixes). Surfaces live only while this process runs. " +
      "Call read_events to receive button/form actions, then publish_messages to respond; events do not execute code. " +
      `Examples for publish_messages({messages: ...}): ${JSON.stringify(examples)}`,
  });
  server.registerTool("publish_messages", {
    description: `Publish an ordered, prevalidated batch of A2UI v0.9 createSurface/updateComponents/updateDataModel/deleteSurface messages. Basic Catalog: ${BASIC_CATALOG.id}. Example: ${JSON.stringify(examples.publish)}`,
    inputSchema: { messages: z.array(z.record(z.string(), z.unknown())).min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, ({ messages }) => tool(() => publisher.publish(messages)));
  server.registerTool("list_surfaces", {
    description: "List this process's service ID and currently published surface IDs.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => tool(() => publisher.list()));
  server.registerTool("read_events", {
    description: "Read button/form actions without consuming them. Start after=0, then use nextCursor. timeoutMs waits up to 30000ms. Latest 1000 events retained; dropped reports missing events. The original A2UI message includes action.context and optional client data model metadata.",
    inputSchema: {
      after: z.number().int().nonnegative().optional(),
      timeoutMs: z.number().int().min(0).max(30_000).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ after, timeoutMs }, extra) => tool(() => publisher.events.read(after, timeoutMs, extra.signal)));
  server.server.onclose = onClose;
  await server.connect(new StdioServerTransport());
  return server;
}
