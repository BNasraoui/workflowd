import { Effect, Schema } from "effect"
import { DirectorySnapshot } from "../directory/contract"
import type { ToolCallContext, ToolResult } from "./tools"

export const DirectoryQuery = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literals(["agents", "runners", "capabilities"])),
  id: Schema.optionalKey(Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256)))),
})
const error = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true })
export const queryDirectory = Effect.fn("Mcp.queryDirectory")(function* (
  args: unknown,
  context: ToolCallContext,
) {
  if (!context.writesConfigured || !context.writesAuthorized)
    return error("unauthorized: directory requires a valid MCP bearer token")
  const input = yield* Schema.decodeUnknownEffect(DirectoryQuery)(args ?? {}, {
    onExcessProperty: "error",
  }).pipe(Effect.result)
  if (
    input._tag === "Failure" ||
    (input.success.id !== undefined && input.success.kind === undefined)
  )
    return error(
      "invalid arguments: choose agents, runners or capabilities before specifying an id",
    )
  const daemon = context.executionCapabilitiesDaemon
  if (daemon === undefined) return error("directory requires daemon discovery configuration")
  const result = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await (daemon.send ?? fetch)(new URL("/directory", daemon.baseUrl), {
        method: "GET",
        headers: { authorization: `Bearer ${daemon.token}`, accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      })
      if (!response.ok) throw new Error("Directory refused")
      const body: unknown = await response.json()
      return body
    },
    catch: () => new Error("Directory unavailable"),
  }).pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(DirectorySnapshot)(body, { onExcessProperty: "error" }),
    ),
    Effect.result,
  )
  if (result._tag === "Failure")
    return error("directory unavailable: daemon refused or returned an unsupported contract")
  const query = input.success
  const snapshot = result.success
  const agents =
    query.kind === undefined || query.kind === "agents"
      ? snapshot.agents.filter((agent) => query.id === undefined || agent.recipientId === query.id)
      : []
  const runners =
    query.kind === "agents"
      ? []
      : snapshot.runners.filter(
          (runner) =>
            query.id === undefined ||
            (query.kind === "capabilities"
              ? runner.hostId === query.id
              : runner.runnerId === query.id),
        )
  if (query.id !== undefined && agents.length + runners.length === 0)
    return error("directory identity not found")
  const value = { agents, runners }
  const output: ToolResult = {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
  return output
})
