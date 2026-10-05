import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import {
  AgentRunIngress,
  AgentRunIngressLive,
  AgentRunProvider,
} from "../../../src/kernel/agent-run-ingress"
import { AgentRunStoreLive } from "../../../src/kernel/agent-run-store"
import { AgentRunWorktrees } from "../../../src/kernel/agent-run-worktrees"
import { AgentWaitIngress } from "../../../src/kernel/agent-wait-ingress"
import { ClaudeCli } from "../../../src/kernel/claude-session"
import { CodexCli } from "../../../src/kernel/codex-session"
import { KernelEventStoreLive } from "../../../src/kernel/event-store"
import { KernelSessionStoreLive } from "../../../src/kernel/session-store"
import { CiService } from "../../../src/ci/service"
import { makeCiStore } from "../../../src/ci/store"
import { ResidentCodex, ResidentCodexLive } from "../../../src/resident/service"
import { WorkflowStoreLive } from "../../../src/store"
import { WorkSignal } from "../../../src/work-signal"

export type HostReady = { port: number }

const root = process.env.RESIDENT_TEST_ROOT
const binary = process.env.RESIDENT_TEST_BINARY
if (root === undefined || binary === undefined) throw new Error("test root and binary required")
const unused = () => Effect.die("unused test integration")
const ciConfig = {
  token: "test",
  repositories: [],
  servers: [],
  auth: { mode: "token" as const, token: "test" },
}
const database = SqliteClient.layer({ filename: join(root, "state.db") })
const store = WorkflowStoreLive.pipe(Layer.provideMerge(database))
const runs = AgentRunStoreLive.pipe(Layer.provideMerge(store))
const sessions = KernelSessionStoreLive.pipe(Layer.provideMerge(store))
const events = KernelEventStoreLive.pipe(Layer.provideMerge(store))
const ci = Layer.effect(CiService, makeCiStore).pipe(Layer.provideMerge(store))
const resident = ResidentCodexLive(
  {
    home: join(root, "codex-home"),
    socket: join(root, "resident.sock"),
    // Keep the same isolated namespace when the host restarts against this database.
    unitPrefix: `workflowd-test-resident-${basename(root)}-`,
  },
  binary,
  ciConfig,
).pipe(Layer.provideMerge(Layer.mergeAll(runs, events, ci)), Layer.provideMerge(store))
const codex = Layer.effect(
  CodexCli,
  Effect.map(ResidentCodex, (service) => service.cli),
).pipe(Layer.provideMerge(resident))
const ingress = AgentRunIngressLive({
  routes: [],
  codexRoutes: [{ name: "codex", modelID: null }],
  repositories: [{ name: "scratch", directory: join(root, "repo") }],
  agent: "worker",
  worktreeRoot: join(root, "worktrees"),
  verifyTimeoutMs: 10000,
  verifyPollIntervalMs: 20,
  progressWindowMs: 60000,
  maxAttempts: 1,
  claudeHosts: [],
  identity: {
    owningHostId: "fixture",
    providerId: "fixture",
    serverId: "fixture",
    endpointAlias: "fixture",
    endpointIdentity: "fixture://local",
    providerVersion: 1,
  },
}).pipe(
  Layer.provideMerge(Layer.mergeAll(runs, sessions, codex)),
  Layer.provide(
    Layer.succeed(AgentRunProvider, {
      listProviders: unused,
      listModels: unused,
      createSession: unused,
      promptSession: unused,
      abortSession: unused,
      sessionTelemetry: unused,
    }),
  ),
  Layer.provide(
    Layer.succeed(AgentRunWorktrees, {
      create: (input) => Effect.tryPromise(() => mkdir(input.directory, { recursive: true })),
    }),
  ),
  Layer.provide(Layer.succeed(AgentWaitIngress, { register: unused })),
  Layer.provide(Layer.succeed(ClaudeCli, { sessionExists: unused, resume: unused })),
  Layer.provide(Layer.succeed(WorkSignal, { subscribe: unused, wake: () => Effect.void })),
)
const stopped = Promise.withResolvers<void>()
process.once("SIGINT", () => stopped.resolve())
process.once("SIGTERM", () => stopped.resolve())
await Effect.runPromise(
  Effect.gen(function* () {
    const service = yield* AgentRunIngress
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Effect.runPromise(
          service.register(
            { route: "codex", repository: "scratch", prompt: "hold", idempotencyKey: "restart" },
            new Date(),
          ),
        ).then(
          (value) => Response.json(value),
          (error) => Response.json({ error: String(error) }, { status: 500 }),
        ),
    })
    yield* Effect.tryPromise(() =>
      writeFile(join(root, "ready.json"), JSON.stringify({ port: server.port })),
    )
    yield* Effect.tryPromise(() => stopped.promise)
    yield* Effect.tryPromise(() => server.stop(true))
  }).pipe(Effect.provide(ingress)),
)
