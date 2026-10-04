import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { routeRequest } from "../../src/http"
import { startMcpServer, type StartedMcpServer } from "../../src/mcp-server"
import { CHANNEL_NOTIFICATION } from "../../src/mcp/channel"
import { AgentHandoffStoreLive } from "../../src/kernel/agent-handoff-store"
import {
  AgentRunIngress,
  AgentRunIngressLive,
  AgentRunProvider,
  type AgentRunProviderPort,
} from "../../src/kernel/agent-run-ingress"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { AgentRunWorktrees } from "../../src/kernel/agent-run-worktrees"
import { AgentWaitIngressLive } from "../../src/kernel/agent-wait-ingress"
import { ClaudeCli } from "../../src/kernel/claude-session"
import { CodexCli } from "../../src/kernel/codex-session"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { KernelSessionStoreLive } from "../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignal } from "../../src/work-signal"
import { defaultState, makeCodexCli, makeProvider } from "../kernel/agent-run-ingress-harness"

const identity = {
  owningHostId: "mint",
  providerId: "opencode-primary",
  serverId: "opencode-primary",
  endpointAlias: "local",
  endpointIdentity: "http://127.0.0.1:4096",
  providerVersion: 1,
}

/** Each created session gets its own id and first-token telemetry. */
const provider = (): AgentRunProviderPort => {
  const state = defaultState()
  const base = makeProvider(state)
  let created = 0
  return {
    ...base,
    createSession: (input) =>
      base.createSession(input).pipe(
        Effect.map(() => {
          created += 1
          const id = `ses_child_${created}`
          state.telemetry.set(id, {
            directory: input.directory,
            outputTokens: 3,
            updatedAtMs: Date.now(),
            idle: false,
          })
          return { id }
        }),
      ),
  }
}

const daemonLayer = (filename: string) => {
  const bootstrap = WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename })))
  const signals = Layer.succeed(WorkSignal, {
    subscribe: () => Effect.never,
    wake: () => Effect.void,
  })
  const events = KernelEventStoreLive.pipe(Layer.provideMerge(bootstrap))
  const sessions = KernelSessionStoreLive.pipe(Layer.provideMerge(bootstrap))
  const handoffs = AgentHandoffStoreLive.pipe(
    Layer.provideMerge(events),
    Layer.provideMerge(bootstrap),
  )
  const waits = AgentWaitIngressLive(identity).pipe(
    Layer.provideMerge(Layer.mergeAll(events, sessions, handoffs)),
    Layer.provideMerge(signals),
  )
  const runs = AgentRunStoreLive.pipe(Layer.provideMerge(bootstrap))
  return AgentRunIngressLive({
    routes: [{ name: "implement", providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }],
    codexRoutes: [],
    claudeRoutes: [],
    repositories: [{ name: "workflowd", directory: "/fixture/workflowd" }],
    agent: "build",
    worktreeRoot: "/fixture/worktrees",
    verifyTimeoutMs: 2_000,
    verifyPollIntervalMs: 5,
    progressWindowMs: 60_000,
    maxAttempts: 3,
    claudeHosts: [],
    identity,
  }).pipe(
    Layer.provideMerge(Layer.mergeAll(runs, sessions, waits)),
    Layer.provideMerge(Layer.succeed(AgentRunProvider, provider())),
    Layer.provideMerge(Layer.succeed(AgentRunWorktrees, { create: () => Effect.void })),
    Layer.provideMerge(
      Layer.succeed(ClaudeCli, {
        sessionExists: () => Effect.succeed(false),
        resume: () => Effect.die(new Error("unused")),
      }),
    ),
    Layer.provideMerge(Layer.succeed(CodexCli, makeCodexCli([]).port)),
    Layer.provideMerge(signals),
  )
}

let directory: string
let daemonRuntime: ManagedRuntime.ManagedRuntime<
  Layer.Success<ReturnType<typeof daemonLayer>>,
  unknown
>
let daemon: ReturnType<typeof Bun.serve>
let mcp: StartedMcpServer

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "workflowd-channel-e2e-"))
  const database = join(directory, "workflowd.db")
  daemonRuntime = ManagedRuntime.make(daemonLayer(database))
  const ingress = await daemonRuntime.runPromise(Effect.service(AgentRunIngress))
  daemon = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      daemonRuntime.runPromise(
        routeRequest(request, {
          webhookSecret: "",
          now: new Date(),
          agentRuns: { token: "run-token", ...ingress },
        }),
      ),
  })
  mcp = await Effect.runPromise(
    startMcpServer({
      WORKFLOWD_MCP_PORT: "0",
      WORKFLOWD_DATABASE_PATH: database,
      WORKFLOWD_MCP_TOKEN: "mcp-token",
      WORKFLOWD_DAEMON_URL: `http://127.0.0.1:${daemon.port}`,
      WORKFLOWD_AGENT_RUN_TOKEN: "run-token",
    }),
  )
})

afterAll(async () => {
  await mcp.stop()
  await daemon.stop(true)
  await daemonRuntime.dispose()
  await rm(directory, { recursive: true, force: true })
})

const connectChannel = async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "../../src/mcp-channel.ts")],
    env: {
      WORKFLOWD_MCP_URL: `http://127.0.0.1:${mcp.port}/mcp`,
      WORKFLOWD_MCP_TOKEN: "mcp-token",
      WORKFLOWD_CHANNEL_POLL_MS: "20",
    },
  })
  const client = new Client({ name: "claude-code", version: "1" })
  const events: Array<{ method: string; params?: Record<string, unknown> | undefined }> = []
  client.fallbackNotificationHandler = async (notification) => {
    events.push({ method: notification.method, params: notification.params })
  }
  await client.connect(transport)
  return { client, events }
}

const Receipt = Schema.Struct({ run_id: Schema.String, mailbox_id: Schema.String })
const ChannelParams = Schema.Struct({
  content: Schema.String,
  meta: Schema.Record(Schema.String, Schema.String),
})
const MailboxPrompt = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const dispatch = async (client: Client, prompt: string) => {
  const result = await client.callTool({
    name: "dispatch_agent",
    arguments: { route: "implement", repository: "workflowd", prompt },
  })
  expect(result.isError).toBeUndefined()
  return Schema.decodeUnknownSync(Receipt)(result.structuredContent)
}

const mailboxRow = (mailboxId: string) =>
  daemonRuntime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ prompt: string }>`
        SELECT prompt FROM resident_inbox WHERE mailbox_id = ${mailboxId}`
      return rows.map((row) => Schema.decodeUnknownSync(MailboxPrompt)(row.prompt))
    }),
  )

const until = async (check: () => boolean) => {
  const deadline = Date.now() + 5_000
  while (!check() && Date.now() < deadline) await Bun.sleep(20)
}

test("a dispatched child's terminal mailbox message arrives as one channel event on its own connection", async () => {
  const first = await connectChannel()
  const second = await connectChannel()
  try {
    const mine = await dispatch(first.client, "Implement the first change.")
    const theirs = await dispatch(second.client, "Implement the second change.")
    expect(mine.mailbox_id).not.toBe(theirs.mailbox_id)

    await daemonRuntime.runPromise(
      Effect.gen(function* () {
        const runs = yield* AgentRunStore
        yield* runs.complete({ runId: mine.run_id, now: new Date(), finalMessage: "first done" })
      }),
    )
    await until(() => first.events.length > 0)
    await Bun.sleep(200)

    const [row] = await mailboxRow(mine.mailbox_id)
    expect(first.events).toHaveLength(1)
    expect(first.events[0]?.method).toBe(CHANNEL_NOTIFICATION)
    const params = Schema.decodeUnknownSync(ChannelParams)(first.events[0]?.params)
    expect(JSON.parse(params.content)).toEqual(row!)
    expect(params.meta).toEqual({
      run_id: mine.run_id,
      mailbox_id: mine.mailbox_id,
      status: "completed",
    })
    expect(second.events).toEqual([])
    expect(await mailboxRow(theirs.mailbox_id)).toEqual([])
  } finally {
    await first.client.close()
    await second.client.close()
  }
})
