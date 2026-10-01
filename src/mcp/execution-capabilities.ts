import { Effect, Schema } from "effect"
import { ExecutionCapabilities } from "../execution-capability-contract"
import type { ToolCallContext, ToolResult } from "./tools"

const NoArguments = Schema.Record(Schema.String, Schema.Never)
const error = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true })

export const listExecutionCapabilities = Effect.fn("Mcp.listExecutionCapabilities")(function* (
  args: unknown,
  context: ToolCallContext,
) {
  if (!context.writesConfigured || !context.writesAuthorized)
    return error("unauthorized: capability discovery requires a valid MCP bearer token")
  const input = yield* Schema.decodeUnknownEffect(NoArguments)(args ?? {}, {
    onExcessProperty: "error",
  }).pipe(Effect.result)
  if (input._tag === "Failure")
    return error("invalid arguments: list_execution_capabilities takes no arguments")
  const daemon = context.executionCapabilitiesDaemon
  if (daemon === undefined)
    return error("capability discovery is not configured on this MCP server")
  const result = yield* Effect.tryPromise({
    try: async () => {
      const response = await (daemon.send ?? fetch)(
        new URL("/execution-capabilities", daemon.baseUrl),
        {
          method: "GET",
          headers: { authorization: `Bearer ${daemon.token}`, accept: "application/json" },
          signal: AbortSignal.timeout(35_000),
        },
      )
      if (!response.ok) throw new Error("Daemon discovery refused")
      const body: unknown = await response.json()
      return body
    },
    catch: () => new Error("Capability discovery unavailable"),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ExecutionCapabilities)), Effect.result)
  if (result._tag === "Failure")
    return error(
      "capability discovery unavailable: daemon refused, timed out, or returned an unsupported contract",
    )
  const value = result.success
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { ...value },
  }
})
