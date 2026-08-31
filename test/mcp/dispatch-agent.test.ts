import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { RemoteProbeProducerLive } from "../../src/remote/probe-producer"
import { McpQueriesLive } from "../../src/mcp/queries"
import { TOOL_DEFINITIONS } from "../../src/mcp/tool-definitions"
import { callTool, type ToolCallContext } from "../../src/mcp/tools"
import { kernelLayer, now } from "../kernel/job-store-harness"

const mcpLayer = Layer.merge(RemoteProbeProducerLive, McpQueriesLive).pipe(
  Layer.provideMerge(kernelLayer(":memory:")),
)

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof mcpLayer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(mcpLayer)))

const firstText = (result: { content: Array<{ type: "text"; text: string }> }) =>
  result.content[0]!.text

type Call = {
  readonly url: string
  readonly body: string
  readonly authorization: string | null
}

const daemon = (respond: () => Response, calls: Array<Call> = []): ToolCallContext => {
  const send = (input: URL, init: RequestInit): Promise<Response> => {
    calls.push({
      url: input.href,
      body: typeof init.body === "string" ? init.body : "",
      authorization: new Headers(init.headers).get("authorization"),
    })
    return Promise.resolve(respond())
  }
  return {
    writesConfigured: true,
    writesAuthorized: true,
    now: () => now,
    agentRunDaemon: { baseUrl: "http://127.0.0.1:8787", token: "run-token", send },
  }
}

const json = (value: unknown, status = 202) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })

const receipt = {
  runId: "agent-run-abc",
  sessionId: "opencode-session-ses_child",
  nativeSessionId: "ses_child",
  providerId: "zai-coding-plan",
  modelId: "glm-5.3-flash",
  outputTokens: 7,
  status: "dispatched",
}

const args = {
  route: "implement",
  repository: "workflowd",
  prompt: "Fix the flaky retry test and push the branch.",
}

describe("dispatch_agent", () => {
  test("is advertised as intent-based, pre-flighted and first-token-verified", () => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "dispatch_agent")
    expect(definition).toBeDefined()
    expect(definition?.description).toContain("never a provider-prefixed id")
    expect(definition?.description).toContain("first generated token")
    expect(definition?.description).toContain("refused loudly")
    expect(definition?.description).toContain("END YOUR TURN")
  })

  test("proxies to the daemon ingress and reports the verified receipt", async () => {
    const calls: Array<Call> = []
    const result = await run(
      callTool(
        "dispatch_agent",
        args,
        daemon(() => json(receipt), calls),
      ),
    )

    expect(result.isError).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("http://127.0.0.1:8787/workflows/agent-runs")
    expect(calls[0]!.authorization).toBe("Bearer run-token")
    expect(JSON.parse(calls[0]!.body)).toEqual({
      route: "implement",
      repository: "workflowd",
      prompt: args.prompt,
    })
    expect(result.structuredContent).toMatchObject({
      run_id: "agent-run-abc",
      session_id: "opencode-session-ses_child",
      native_session_id: "ses_child",
      output_tokens: 7,
      status: "dispatched",
      wait: null,
    })
    expect(firstText(result)).toContain("Dispatched and verified")
    expect(firstText(result)).toContain("End your turn")
  })

  test("forwards the optional wait fields and reports the registered wait", async () => {
    const calls: Array<Call> = []
    const result = await run(
      callTool(
        "dispatch_agent",
        {
          ...args,
          parent_session_id: "ses_parent",
          parent_kind: "claude",
          parent_directory: "/home/ben/repos/workflowd",
          parent_host: "ben-arch",
          resume_prompt: "Child finished; review its branch.",
          idempotency_key: "dispatch-7",
        },
        daemon(
          () =>
            json({
              ...receipt,
              wait: {
                waitId: "agent-wait-w",
                instanceId: "agent-wait-instance-w",
                status: "registered",
              },
            }),
          calls,
        ),
      ),
    )

    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      parentSessionId: "ses_parent",
      parentKind: "claude",
      parentDirectory: "/home/ben/repos/workflowd",
      parentHost: "ben-arch",
      resumePrompt: "Child finished; review its branch.",
      idempotencyKey: "dispatch-7",
    })
    expect(result.structuredContent).toMatchObject({
      wait: { waitId: "agent-wait-w", status: "registered" },
    })
    expect(firstText(result)).toContain("prompt your session when the child completes")
  })

  test("refuses without authorization or configuration and never calls the daemon", async () => {
    const calls: Array<Call> = []
    const context = daemon(() => json(receipt), calls)

    const unauthorized = await run(
      callTool("dispatch_agent", args, { ...context, writesAuthorized: false }),
    )
    expect(unauthorized.isError).toBe(true)
    expect(firstText(unauthorized)).toContain("unauthorized")

    const unconfigured = await run(
      callTool("dispatch_agent", args, {
        writesConfigured: true,
        writesAuthorized: true,
        now: () => now,
      }),
    )
    expect(unconfigured.isError).toBe(true)
    expect(firstText(unconfigured)).toContain("WORKFLOWD_AGENT_RUN_TOKEN")
    expect(calls).toHaveLength(0)
  })

  test("relays a machine-readable refusal so the caller can fix the dispatch", async () => {
    const result = await run(
      callTool(
        "dispatch_agent",
        args,
        daemon(() =>
          json(
            {
              error: "refused",
              reason: "provider_not_authenticated",
              detail:
                "route implement resolves to provider zai-coding-plan, which has no credentials",
            },
            409,
          ),
        ),
      ),
    )

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain("the dispatch was refused")
    expect(firstText(result)).toContain("zai-coding-plan")
    expect(result.structuredContent).toMatchObject({ reason: "provider_not_authenticated" })
  })

  test("rejects malformed arguments before contacting the daemon", async () => {
    const calls: Array<Call> = []
    const result = await run(
      callTool(
        "dispatch_agent",
        { route: "implement" },
        daemon(() => json(receipt), calls),
      ),
    )
    expect(result.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test("its structured output schema matches the receipt it returns", async () => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "dispatch_agent")
    const outputSchema = Schema.decodeUnknownSync(
      Schema.Struct({ required: Schema.Array(Schema.String) }),
    )(definition?.outputSchema)
    const result = await run(
      callTool(
        "dispatch_agent",
        args,
        daemon(() => json(receipt)),
      ),
    )
    for (const key of outputSchema.required) {
      expect(Object.keys(result.structuredContent ?? {})).toContain(key)
    }
  })
})
