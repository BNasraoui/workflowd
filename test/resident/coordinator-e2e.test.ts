import { expect, setDefaultTimeout, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { Effect, Layer, Schedule, Schema } from "effect"
import { AgentRunReceipt } from "../../src/agent-run-contract"
import { CiService } from "../../src/ci/service"
import { makeCiStore } from "../../src/ci/store"
import { routeRequest } from "../../src/http"
import { AgentHandoffStoreLive } from "../../src/kernel/agent-handoff-store"
import {
  AgentRunIngress,
  AgentRunIngressLive,
  AgentRunProvider,
} from "../../src/kernel/agent-run-ingress"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { AgentRunWorktrees } from "../../src/kernel/agent-run-worktrees"
import { AgentWaitIngressLive } from "../../src/kernel/agent-wait-ingress"
import { ClaudeCli } from "../../src/kernel/claude-session"
import { CodexCli } from "../../src/kernel/codex-session"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { KernelSessionStoreLive } from "../../src/kernel/session-store"
import { ResidentCodex, ResidentCodexLive } from "../../src/resident/service"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignal } from "../../src/work-signal"
import { defaultState, makeProvider } from "../kernel/agent-run-ingress-harness"

setDefaultTimeout(30_000)

const identity = {
  owningHostId: "mint",
  providerId: "opencode-primary",
  serverId: "opencode-primary",
  endpointAlias: "local",
  endpointIdentity: "http://127.0.0.1:4096",
  providerVersion: 1,
}

const QueueAdd = Schema.fromJsonString(
  Schema.Struct({
    threadId: Schema.String,
    clientUserMessageId: Schema.String,
    input: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
  }),
)

/** The daemon's resident wiring: real ResidentCodexLive over a spawned app-server, on a file DB. */
const daemonLayer = (root: string, binary: string) => {
  const bootstrap = WorkflowStoreLive.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(root, "workflowd.db") })),
  )
  const signals = Layer.succeed(WorkSignal, {
    subscribe: () => Effect.never,
    wake: () => Effect.void,
  })
  const events = KernelEventStoreLive.pipe(Layer.provideMerge(bootstrap))
  const sessions = KernelSessionStoreLive.pipe(Layer.provideMerge(bootstrap))
  const runs = AgentRunStoreLive.pipe(Layer.provideMerge(bootstrap))
  const handoffs = AgentHandoffStoreLive.pipe(
    Layer.provideMerge(events),
    Layer.provideMerge(bootstrap),
  )
  const waits = AgentWaitIngressLive(identity).pipe(
    Layer.provideMerge(Layer.mergeAll(events, sessions, handoffs)),
    Layer.provideMerge(signals),
  )
  const ci = Layer.effect(CiService, makeCiStore).pipe(Layer.provideMerge(bootstrap))
  const resident = ResidentCodexLive({ socket: join(root, "resident.sock"), home: root }, binary, {
    token: "fixture",
    repositories: [],
    servers: [],
    auth: { mode: "token", token: "fixture" },
  }).pipe(Layer.provideMerge(Layer.mergeAll(runs, events, ci)))
  return AgentRunIngressLive({
    routes: [],
    codexRoutes: [{ name: "native", modelID: "native" }],
    claudeRoutes: [],
    repositories: [{ name: "workflowd", directory: root }],
    agent: "build",
    worktreeRoot: root,
    verifyTimeoutMs: 5_000,
    verifyPollIntervalMs: 5,
    progressWindowMs: 60_000,
    maxAttempts: 3,
    claudeHosts: [],
    identity,
  }).pipe(
    Layer.provideMerge(Layer.mergeAll(runs, sessions, waits)),
    Layer.provideMerge(
      Layer.effect(
        CodexCli,
        Effect.map(ResidentCodex, (port) => port.cli),
      ).pipe(Layer.provideMerge(resident)),
    ),
    Layer.provideMerge(Layer.succeed(AgentRunProvider, makeProvider(defaultState()))),
    Layer.provideMerge(Layer.succeed(AgentRunWorktrees, { create: () => Effect.void })),
    Layer.provideMerge(
      Layer.succeed(ClaudeCli, {
        sessionExists: () => Effect.succeed(false),
        resume: () => Effect.die(new Error("unused")),
      }),
    ),
    Layer.provideMerge(signals),
  )
}

const queueAdds = (root: string) =>
  readFile(join(root, "queue-add.jsonl"), "utf8")
    .catch(() => "")
    .then((text) =>
      text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => Schema.decodeUnknownSync(QueueAdd)(line)),
    )

const dispatch = (prompt: string) =>
  Effect.gen(function* () {
    const ingress = yield* AgentRunIngress
    const response = yield* routeRequest(
      new Request("http://daemon/workflows/agent-runs", {
        method: "POST",
        headers: { authorization: "Bearer secret" },
        body: JSON.stringify({ route: "native", repository: "workflowd", prompt }),
      }),
      { webhookSecret: "", now: new Date(), agentRuns: { token: "secret", ...ingress } },
    )
    expect(response.status).toBe(202)
    return yield* Effect.promise(() => response.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AgentRunReceipt)),
    )
  })

test("a resident Codex coordinator receives its child's terminal message in one thread/queue/add", async () => {
  const root = await mkdtemp("/tmp/w-")
  const binary = join(root, "codex")
  await writeFile(
    binary,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(
      join(import.meta.dir, "fixtures/codex-thread-app-server.mjs"),
    )} "$@"\n`,
  )
  await chmod(binary, 0o755)
  const finalMessage = "child finished: CHILD-FINAL-7f3a"
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const child = yield* dispatch("Do the child task. HOLD_TURN")
        const caller = yield* dispatch(`Coordinate the child. SUBSCRIBE_AGENT_RUN ${child.runId}`)
        const sql = yield* SqlClient.SqlClient
        // The scripted turn subscribed and ended; the thread waits for its one completion.
        yield* sql<{ state: string }>`SELECT state FROM resident_threads
          WHERE thread_id = ${caller.nativeSessionId}`.pipe(
          Effect.repeat({
            until: (rows) => rows[0]?.state === "waiting",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        )

        const runs = yield* AgentRunStore
        yield* runs.complete({ runId: child.runId, now: new Date(), finalMessage })

        const delivered = yield* Effect.promise(() => queueAdds(root)).pipe(
          Effect.repeat({
            until: (adds) => adds.some((add) => add.input[0]?.text.includes(finalMessage)),
            schedule: Schedule.spaced("50 millis"),
          }),
          Effect.timeout("10 seconds"),
        )
        // Let several resident ticks pass: delivery must not repeat.
        yield* Effect.sleep("2500 millis")
        const adds = yield* Effect.promise(() => queueAdds(root))
        expect(adds).toHaveLength(delivered.length)
        const completions = adds.filter((add) => add.input[0]?.text.includes(finalMessage))
        expect(completions).toHaveLength(1)
        expect(completions[0]?.threadId).toBe(caller.nativeSessionId)
        const text = completions[0]!.input[0]!.text
        const payload = Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              kind: Schema.Literal("agent_run"),
              runId: Schema.String,
              terminal: Schema.Record(Schema.String, Schema.Unknown),
            }),
          ),
        )(/^workflowd completion: (.*)\. Continue the task from this result\.$/s.exec(text)?.[1])
        expect(payload.runId).toBe(child.runId)
        expect(payload.terminal).toMatchObject({
          run_id: child.runId,
          status: "completed",
          final_message: finalMessage,
          final_message_ref: null,
        })
      }).pipe(Effect.scoped, Effect.provide(daemonLayer(root, binary))),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
