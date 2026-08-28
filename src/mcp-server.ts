import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { BunRuntime } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, ManagedRuntime } from "effect"
import { KernelEventStoreLive } from "./kernel/event-store"
import { KernelJobStoreLive } from "./kernel/job-store"
import { RemoteProbeProducerLive } from "./remote/probe-producer"
import { WorkflowStoreLive } from "./store"
import {
  loadAgentWaitDaemon,
  loadMcpWriteAuth,
  type AgentWaitDaemonConfig,
  type McpWriteAuth,
} from "./mcp/auth"
import { createMcpFetchHandler, type RunTool } from "./mcp/server"
import { McpQueriesLive } from "./mcp/queries"
import { callTool, type ToolResult } from "./mcp/tools"

export const DEFAULT_MCP_PORT = 8791

type McpServerProcessOptions = {
  readonly env?: Record<string, string | undefined>
  readonly runMain?: (program: Effect.Effect<void, Error, never>) => void
}

const parsePort = (env: Record<string, string | undefined>) => {
  const raw = env.WORKFLOWD_MCP_PORT
  if (raw === undefined || raw === "") return DEFAULT_MCP_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("WORKFLOWD_MCP_PORT must be an integer between 0 and 65535")
  }
  return port
}

const databaseLayer = (filename: string) => {
  const database = SqliteClient.layer({ filename })
  const bootstrap = WorkflowStoreLive.pipe(Layer.provideMerge(database))
  const kernel = Layer.merge(KernelEventStoreLive, KernelJobStoreLive).pipe(
    Layer.provideMerge(bootstrap),
  )
  return Layer.merge(RemoteProbeProducerLive, McpQueriesLive).pipe(Layer.provideMerge(kernel))
}

export type StartedMcpServer = {
  readonly port: number
  readonly writesEnabled: boolean
  readonly agentWaitsEnabled: boolean
  readonly stop: () => Promise<void>
}

/**
 * Opens the authoritative workflowd SQLite store and serves the MCP
 * streamable-HTTP endpoint on loopback. All state lives in the database;
 * this process holds nothing but a connection.
 */
export const startMcpServer = (
  env: Record<string, string | undefined>,
): Effect.Effect<StartedMcpServer, Error> =>
  Effect.gen(function* () {
    const port = yield* Effect.try({
      try: () => parsePort(env),
      catch: (cause) => new Error(String(cause)),
    })
    const auth: McpWriteAuth = yield* Effect.tryPromise({
      try: () => loadMcpWriteAuth(env),
      catch: (cause) => new Error(String(cause)),
    })
    const agentWaitDaemon: AgentWaitDaemonConfig | undefined = yield* Effect.tryPromise({
      try: () => loadAgentWaitDaemon(env),
      catch: (cause) => new Error(String(cause)),
    })
    const filename =
      env.WORKFLOWD_DATABASE_PATH ?? join(homedir(), ".local/state/workflowd/workflowd.db")
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(filename), { recursive: true }),
      catch: (cause) => new Error(`Could not create state directory: ${String(cause)}`),
    })
    const runtime = ManagedRuntime.make(databaseLayer(filename))
    const runTool: RunTool = (name, args, context) =>
      runtime
        .runPromise(
          callTool(name, args, context).pipe(
            Effect.catchAll((): Effect.Effect<ToolResult> =>
              Effect.succeed({
                content: [{ type: "text", text: "tool call failed: store error" }],
                isError: true,
              }),
            ),
          ),
        )
        .catch((): ToolResult => ({
          content: [{ type: "text", text: "tool call failed: internal error" }],
          isError: true,
        }))
    const fetchHandler = createMcpFetchHandler({
      runTool,
      auth,
      ...(agentWaitDaemon === undefined ? {} : { agentWaitDaemon }),
    })
    const server = yield* Effect.try({
      try: () => Bun.serve({ hostname: "127.0.0.1", port, fetch: fetchHandler }),
      catch: (cause) => new Error(`Could not start MCP server: ${String(cause)}`),
    })
    return {
      port: server.port ?? port,
      writesEnabled: auth.mode === "enabled",
      agentWaitsEnabled: agentWaitDaemon !== undefined,
      stop: async () => {
        await server.stop(true)
        await runtime.dispose()
      },
    }
  })

const program = (env: Record<string, string | undefined>) =>
  Effect.gen(function* () {
    const started = yield* startMcpServer(env)
    yield* Effect.logInfo(
      `workflowd MCP server listening on 127.0.0.1:${started.port} ` +
        `(writes ${started.writesEnabled ? "enabled" : "disabled"}, ` +
        `agent waits ${started.agentWaitsEnabled ? "enabled" : "disabled"})`,
    )
    return yield* Effect.never
  })

export const runMcpServerProcess = (options: McpServerProcessOptions = {}) =>
  (options.runMain ?? BunRuntime.runMain)(
    program(options.env ?? process.env).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(JSON.stringify(cause) ?? "MCP server failed"),
      ),
    ),
  )

if (import.meta.main) runMcpServerProcess()
