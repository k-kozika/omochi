# Local development quickstart

From the repository root, run:

```sh
bun run quickstart
```

The command builds the workspace, starts the services and hub described by
`omochi.toml`, and opens its temporary dashboard preset. The preview initially
reports unhealthy. Use the **Preview server** panel to start Vite and watch the
health panel recover. Ctrl+C stops the hub and every utility started by `up`.

## Add your agent

The preset deliberately contains only ordinary command-based tools. Connect an
MCP-capable agent to a stdio server with the following shape, replacing the path
with the absolute path to this checkout:

```json
{
  "mcpServers": {
    "omochi-quickstart": {
      "command": "bun",
      "args": [
        "/absolute/path/to/omochi-ui/packages/utils/bin/omochi-utils.js",
        "mcp",
        "--service-id",
        "quickstart-agent",
        "--name",
        "Agent"
      ]
    }
  }
}
```

Then ask the agent:

> Inspect this repository without editing it. Publish an Omochi `main` surface
> with a short project-health summary, anything worth noticing, and the next
> useful command to run.

The new surface appears in the hub's view picker. Choose **Save as dashboard**
on the preset, add the agent view, and save the personalized dashboard. The
agent process owns that surface; disconnecting the MCP server retracts it.
