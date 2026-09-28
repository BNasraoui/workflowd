import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { subscribeToEvent } from "./subscribe"

/** Launched under the resident run's process root; never a shared bearer proxy. */
export function createSubscriptionMcp(env: Record<string, string | undefined>) {
  const server = new Server(
    { name: "workflowd-subscriptions", version: "0.1.0" },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "subscribe_to_event",
        description:
          "Subscribe your mailbox to final CI or agent-run state. Returns a durable receipt immediately. After pushing and subscribing, end your turn; workflowd sends one completion message. Requires a resident workflowd worker.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { enum: ["ci", "agent_run"] },
            repository: { type: "string" },
            sha: { type: "string" },
            run_id: { type: "string" },
          },
          required: ["kind"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    try {
      if (call.params.name !== "subscribe_to_event") throw new Error("Unknown tool")
      const receipt = await subscribeToEvent(call.params.arguments, env)
      return {
        content: [{ type: "text", text: JSON.stringify(receipt) }],
        structuredContent: receipt,
      }
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Subscription refused; requires a valid selector and authenticated resident run. Do not end the turn as if registered.",
          },
        ],
      }
    }
  })
  return server
}

if (import.meta.main) await createSubscriptionMcp(process.env).connect(new StdioServerTransport())
