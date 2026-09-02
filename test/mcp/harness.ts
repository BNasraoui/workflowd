import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import { RemoteProbeProducerLive } from "../../src/remote/probe-producer"
import { McpQueriesLive } from "../../src/mcp/queries"
import { TOOL_DEFINITIONS } from "../../src/mcp/tool-definitions"
import { kernelLayer } from "../kernel/job-store-harness"

/**
 * The exact validation an MCP SDK 1.30 client applies to every tool result's
 * structuredContent — isError or not. A structured refusal that fails this
 * check surfaces to the caller as a -32602 protocol error that masks the
 * refusal entirely.
 */
export const clientValidator = (toolName: string) => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === toolName)
  expect(definition?.outputSchema).toBeDefined()
  return new AjvJsonSchemaValidator().getValidator(definition!.outputSchema)
}

export const mcpLayer = Layer.merge(RemoteProbeProducerLive, McpQueriesLive).pipe(
  Layer.provideMerge(kernelLayer(":memory:")),
)

export const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof mcpLayer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(mcpLayer)))

export const firstText = (result: { content: Array<{ type: "text"; text: string }> }) =>
  result.content[0]!.text

export const json = (value: unknown, status = 202) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
