import { expect, test } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { routeRequest } from "../../src/http"
import { callTool } from "../../src/mcp/tools"
import { McpQueriesLive } from "../../src/mcp/queries"
import { RemoteProbeProducerLive } from "../../src/remote/probe-producer"
import { WorkSignalLive } from "../../src/work-signal"
import { kernelLayer } from "../kernel/job-store-harness"
import { createMcpFetchHandler } from "../../src/mcp/server"
import { makeExecutionCapabilities } from "../../src/execution-capabilities"
import { SqlClient } from "effect/unstable/sql"

const { list: snapshot } = makeExecutionCapabilities({
  host: "box",
  refreshMs: 100,
  timeoutMs: 10,
  sources: [{ executor: "fixture", discover: async () => [{ provider: "p", model: "new-model" }] }],
})
const listing = () => Effect.tryPromise({ try: snapshot, catch: () => new Error("failed") })
const testLayer = Layer.mergeAll(McpQueriesLive, RemoteProbeProducerLive, WorkSignalLive).pipe(
  Layer.provideMerge(kernelLayer(":memory:")),
)
const daemonHandler = (request: Request) =>
  Effect.runPromise(
    routeRequest(request, {
      webhookSecret: "unused",
      now: new Date(),
      executionCapabilities: { token: "daemon-secret", list: listing },
    }).pipe(Effect.provide(testLayer)),
  )

test("interrupting MCP discovery aborts its native fetch and remains an interruption", async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const finish = Promise.withResolvers<Response>()
  const abort = new AbortController()
  const pending = Effect.runPromiseExit(
    callTool(
      "list_execution_capabilities",
      {},
      {
        writesAuthorized: true,
        writesConfigured: true,
        now: () => new Date(),
        executionCapabilitiesDaemon: {
          baseUrl: "http://daemon",
          token: "private-credential",
          send: async (_url, init) => {
            started.resolve(init.signal!)
            return finish.promise
          },
        },
      },
    ).pipe(Effect.provide(testLayer)),
    { signal: abort.signal },
  )
  try {
    const signal = await started.promise
    abort.abort()
    const exit = await pending
    expect(signal.aborted).toBe(true)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  } finally {
    abort.abort()
    finish.resolve(Response.json({ capabilities: [], sources: [] }))
    await pending
  }
})

test("daemon discovery is authenticated and lists native capabilities independently of dispatch", async () => {
  const denied = await daemonHandler(new Request("http://daemon/execution-capabilities"))
  expect(denied.status).toBe(401)
  const response = await daemonHandler(
    new Request("http://daemon/execution-capabilities", {
      headers: { authorization: "Bearer daemon-secret" },
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    capabilities: [{ identity: { model: "new-model" } }],
  })
})

test("compact model discovery targets an execution host and filters harness through HTTP and MCP", async () => {
  const request = new Request("http://daemon/models?host=remote&harness=fixture", {
    headers: { authorization: "Bearer daemon-secret" },
  })
  const response = await daemonHandler(request)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    models: [{ host: "remote", catalogHost: "box", harness: "fixture", model: "new-model" }],
    sources: [{ host: "box", kind: "fixture" }],
  })
  const result = await Effect.runPromise(
    callTool(
      "list_models",
      { host: "remote", harness: "fixture" },
      {
        writesConfigured: true,
        writesAuthorized: true,
        now: () => new Date(),
        executionCapabilitiesDaemon: {
          baseUrl: "http://daemon",
          token: "daemon-secret",
          send: (url, init) => daemonHandler(new Request(url.toString(), init)),
        },
      },
    ).pipe(Effect.provide(testLayer)),
  )
  expect(result.structuredContent).toMatchObject({
    models: [{ host: "remote", catalogHost: "box", model: "new-model" }],
    sources: [{ host: "box", kind: "fixture" }],
  })
})

test("selection preview resolves without a dispatch or worktree side effect", async () => {
  const response = await daemonHandler(
    new Request("http://daemon/execution-selections/resolve", {
      method: "POST",
      headers: { authorization: "Bearer daemon-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "new-model", executor: "fixture", allowUnknownAccess: true }),
    }),
  )
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ reason: "executor_unavailable" })
})

test("a remote-host family preview uses the common catalog without creating a run", async () => {
  const discovery = makeExecutionCapabilities({
    host: "box",
    refreshMs: 100,
    timeoutMs: 100,
    sources: [
      {
        executor: "codex:local",
        kind: "codex",
        protocol: "fixture",
        discover: async () => [{ provider: "openai", model: "gpt-6.10-sol" }],
      },
    ],
  })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* routeRequest(
        new Request("http://daemon/execution-selections/resolve", {
          method: "POST",
          headers: { authorization: "Bearer daemon-secret", "content-type": "application/json" },
          body: JSON.stringify({ family: "sol", host: "remote", allowUnknownAccess: true }),
        }),
        {
          webhookSecret: "unused",
          now: new Date(),
          executionCapabilities: {
            token: "daemon-secret",
            list: () =>
              Effect.tryPromise({ try: discovery.list, catch: () => new Error("failed") }),
          },
        },
      )
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`SELECT run_id FROM kernel_agent_runs`
      return { response, rows }
    }).pipe(Effect.provide(testLayer)),
  )
  expect(result.response.status).toBe(200)
  expect(await result.response.json()).toMatchObject({
    outcome: "resolved",
    selection: { host: "remote", catalogHost: "box", model: "gpt-6.10-sol", family: "sol" },
  })
  expect(result.rows).toHaveLength(0)
})

test("MCP capability tool proxies the same contract, enforces auth and redacts proxy failures", async () => {
  const context = {
    writesAuthorized: true,
    writesConfigured: true,
    now: () => new Date(),
    executionCapabilitiesDaemon: {
      baseUrl: "http://daemon",
      token: "daemon-secret",
      send: (url: URL, init: RequestInit) => daemonHandler(new Request(url.toString(), init)),
    },
  }
  const run = (auth: boolean, args: unknown = {}) =>
    Effect.runPromise(
      callTool("list_execution_capabilities", args, { ...context, writesAuthorized: auth }).pipe(
        Effect.provide(testLayer),
      ),
    )
  expect((await run(false)).isError).toBe(true)
  expect((await run(true)).structuredContent).toMatchObject({
    capabilities: [{ identity: { model: "new-model" } }],
  })
  expect((await run(true, { route: "unsupported" })).isError).toBe(true)
  const handler = createMcpFetchHandler({
    auth: { mode: "enabled", token: "mcp-secret" },
    executionCapabilitiesDaemon: context.executionCapabilitiesDaemon,
    runTool: (name, args, ctx) =>
      Effect.runPromise(callTool(name, args, ctx).pipe(Effect.provide(testLayer))),
  })
  const response = await handler(
    new Request("http://mcp/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer mcp-secret",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_execution_capabilities", arguments: {} },
      }),
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    result: { structuredContent: { capabilities: [{ identity: { model: "new-model" } }] } },
  })
})

test("public discovery reports disabled interfaces and failed proxies without secrets", async () => {
  const disabled = await Effect.runPromise(
    routeRequest(new Request("http://daemon/execution-capabilities"), {
      webhookSecret: "unused",
      now: new Date(),
    }).pipe(Effect.provide(testLayer)),
  )
  expect(disabled.status).toBe(404)
  const failed = await Effect.runPromise(
    routeRequest(
      new Request("http://daemon/execution-capabilities", {
        headers: { authorization: "Bearer daemon-secret" },
      }),
      {
        webhookSecret: "unused",
        now: new Date(),
        executionCapabilities: {
          token: "daemon-secret",
          list: () => Effect.fail(new Error("private-credential")),
        },
      },
    ).pipe(Effect.provide(testLayer)),
  )
  expect(failed.status).toBe(503)
  expect(await failed.text()).not.toContain("private-credential")
  const authorized = { writesAuthorized: true, writesConfigured: true, now: () => new Date() }
  const missing = await Effect.runPromise(
    callTool("list_execution_capabilities", {}, authorized).pipe(Effect.provide(testLayer)),
  )
  expect(missing.isError).toBe(true)
  for (const send of [
    async () => new Response("private-credential", { status: 503 }),
    async () => Response.json({ secret: "private-credential" }),
    async (): Promise<Response> => {
      throw new Error("private-credential")
    },
  ]) {
    const result = await Effect.runPromise(
      callTool(
        "list_execution_capabilities",
        {},
        {
          ...authorized,
          executionCapabilitiesDaemon: { baseUrl: "http://daemon", token: "daemon-secret", send },
        },
      ).pipe(Effect.provide(testLayer)),
    )
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain("private-credential")
    expect(result.structuredContent).toBeUndefined()
  }
})
