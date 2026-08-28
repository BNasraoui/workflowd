import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { RemoteProbeProducerLive } from "../../src/remote/probe-producer"
import { McpQueriesLive } from "../../src/mcp/queries"
import { callTool, TOOL_DEFINITIONS, type ToolCallContext } from "../../src/mcp/tools"
import { kernelLayer, now } from "../kernel/job-store-harness"

const mcpLayer = Layer.merge(RemoteProbeProducerLive, McpQueriesLive).pipe(
  Layer.provideMerge(kernelLayer(":memory:")),
)

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Layer.Success<typeof mcpLayer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(mcpLayer)))

const firstText = (result: { content: Array<{ type: "text"; text: string }> }) =>
  result.content[0]!.text

type Call = {
  readonly url: string
  readonly method: string
  readonly body: string
  readonly authorization: string | null
}

const daemon = (respond: () => Response, calls: Array<Call> = []): ToolCallContext => {
  const send = (input: URL, init: RequestInit): Promise<Response> => {
    calls.push({
      url: input.href,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : "",
      authorization: new Headers(init.headers).get("authorization"),
    })
    return Promise.resolve(respond())
  }
  return {
    writesConfigured: true,
    writesAuthorized: true,
    now: () => now,
    agentWaitDaemon: { baseUrl: "http://127.0.0.1:8787", token: "daemon-token", send },
  }
}

const sentBody = (call: Call): unknown => JSON.parse(call.body)

const json = (value: unknown, status = 202) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

const args = {
  parent_session_id: "parent-stable",
  child_session_id: "child-stable",
  resume_prompt: "The child finished; read its result and continue.",
}

describe("wait_for_agent", () => {
  test("is advertised with the fire-and-ack contract and the custody requirement", () => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "wait_for_agent")

    expect(definition).toBeDefined()
    expect(definition!.description).toContain("does " + "NOT block")
    expect(definition!.description).toContain("operator_required")
    expect(definition!.description).toContain("kernel custody")
    expect(definition!.description).toContain("Do not poll")
    expect(definition!.inputSchema.required).toEqual([
      "parent_session_id",
      "child_session_id",
      "resume_prompt",
    ])
  })

  test("proxies to the daemon ingress and acks with the wait id", async () => {
    const calls: Array<Call> = []
    const result = await run(
      callTool(
        "wait_for_agent",
        args,
        daemon(
          () =>
            json({
              waitId: "agent-wait-abc",
              instanceId: "agent-wait-instance-abc",
              status: "registered",
            }),
          calls,
        ),
      ),
    )

    expect(result.isError).toBeUndefined()
    const text = firstText(result)
    expect(text).toContain("Received: watching child-stable")
    expect(text).toContain("agent-wait-abc")
    expect(text).toContain("End your turn now")
    expect(text).toContain("Do not poll")

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("http://127.0.0.1:8787/workflows/agent-waits")
    expect(calls[0]!.method).toBe("POST")
    // The MCP surface is snake_case; the HTTP payload is the daemon's camelCase.
    expect(sentBody(calls[0]!)).toEqual({
      parentSessionId: "parent-stable",
      childSessionId: "child-stable",
      resumePrompt: "The child finished; read its result and continue.",
    })
    expect(calls[0]!.authorization).toBe("Bearer daemon-token")
  })

  test("forwards an idempotency key and reports a duplicate as already registered", async () => {
    const calls: Array<Call> = []
    const result = await run(
      callTool(
        "wait_for_agent",
        { ...args, idempotency_key: "handoff-7" },
        daemon(
          () =>
            json({
              waitId: "agent-wait-abc",
              instanceId: "agent-wait-instance-abc",
              status: "duplicate",
            }),
          calls,
        ),
      ),
    )

    expect(firstText(result)).toContain("Already registered")
    expect(sentBody(calls[0]!)).toMatchObject({ idempotencyKey: "handoff-7" })
  })

  test("refuses without a bearer token and never calls the daemon", async () => {
    const calls: Array<Call> = []
    const context = daemon(() => json({}), calls)
    const result = await run(
      callTool("wait_for_agent", args, { ...context, writesAuthorized: false }),
    )

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain("unauthorized")
    expect(calls).toHaveLength(0)
  })

  test("refuses when the server has no write token configured", async () => {
    const context = daemon(() => json({}))
    const result = await run(
      callTool("wait_for_agent", args, {
        ...context,
        writesConfigured: false,
        writesAuthorized: false,
      }),
    )

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain("writes are disabled")
  })

  test("explains the missing configuration when no daemon is wired", async () => {
    const result = await run(
      callTool("wait_for_agent", args, {
        writesConfigured: true,
        writesAuthorized: true,
        now: () => now,
      }),
    )

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain("WORKFLOWD_DAEMON_URL")
    expect(firstText(result)).toContain("WORKFLOWD_AGENT_WAIT_TOKEN")
  })

  test("relays a custody refusal verbatim so the agent can fix the call", async () => {
    const result = await run(
      callTool(
        "wait_for_agent",
        args,
        daemon(() =>
          json(
            {
              error: "custody",
              reason: "not_in_kernel_custody",
              detail: "child session child-stable is not in kernel custody",
            },
            409,
          ),
        ),
      ),
    )

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain("child session child-stable is not in kernel custody")
  })

  test("reports an unreachable daemon as an actionable tool error", async () => {
    const result = await run(
      callTool(
        "wait_for_agent",
        args,
        daemon(() => {
          throw new Error("connection refused")
        }),
      ),
    )

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain("could not reach the workflowd daemon")
  })

  test("rejects malformed arguments before contacting the daemon", async () => {
    const calls: Array<Call> = []
    const result = await run(
      callTool(
        "wait_for_agent",
        { parent_session_id: "only-one" },
        daemon(() => json({}), calls),
      ),
    )

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain("invalid arguments")
    expect(calls).toHaveLength(0)
  })
})
