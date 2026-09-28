import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { ResidentCodex, ResidentCodexLive } from "../../src/resident/service"
import { RpcClient } from "../../src/resident/rpc"
import { CiService } from "../../src/ci/service"
import { makeCiStore } from "../../src/ci/store"
import { WorkflowStoreLive } from "../../src/store"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import type { startAppServer } from "../../src/resident/process"

function fixture() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const history = new Map<
    string,
    Array<{ id: string; status: string; items: Array<{ type: string; clientId: string }> }>
  >()
  let currentRpc: RpcClient | undefined
  let counter = 0
  let notify: Parameters<typeof startAppServer>[1] = () => {}
  const factory: typeof startAppServer = (_options, notification) => {
    notify = notification
    const rpc = new RpcClient((line) => {
      const frame = Schema.decodeUnknownSync(
        Schema.Struct({
          id: Schema.Number,
          method: Schema.String,
          params: Schema.Record(Schema.String, Schema.Unknown),
        }),
      )(JSON.parse(line))
      calls.push(frame)
      let result: unknown = {}
      if (frame.method === "thread/start") result = { thread: { id: `thread-${++counter}` } }
      if (frame.method === "thread/read")
        result = { thread: { turns: history.get(String(frame.params.threadId)) ?? [] } }
      if (frame.method === "thread/queue/list") result = { data: [], nextCursor: null }
      rpc.receive(JSON.stringify({ id: frame.id, result }))
      if (frame.method === "thread/queue/add") {
        const threadId = frame.params.threadId
        const id = frame.params.clientUserMessageId
        const turns = history.get(String(threadId)) ?? []
        turns.push({
          id: String(id),
          status: "inProgress",
          items: [{ type: "userMessage", clientId: String(id) }],
        })
        history.set(String(threadId), turns)
        notify({ method: "turn/started", params: { threadId, turn: { id, status: "inProgress" } } })
        notify({
          method: "item/completed",
          params: { threadId, item: { type: "agentMessage", text: "model output" } },
        })
        if (
          !Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ text: Schema.String })))(
            frame.params.input,
          )[0]?.text.endsWith("hold")
        )
          notify({
            method: "turn/completed",
            params: { threadId, turn: { id, status: "completed" } },
          })
      }
    }, notification)
    currentRpc = rpc
    return {
      rpc,
      initialize: async () => {},
      close: async () => {
        rpc.close()
      },
    }
  }
  return {
    factory,
    calls,
    disconnect: () => {
      currentRpc?.close()
      notify({ method: "workflowd/disconnected", params: null })
    },
    complete: (threadId: string, id: string) =>
      notify({ method: "turn/completed", params: { threadId, turn: { id, status: "completed" } } }),
  }
}
const config = { token: "secret", home: "/scratch/codex" }
const ciConfig = {
  token: "ci-token",
  repositories: [{ repository: "o/r", installationId: 1, workflows: ["CI"] }],
  servers: [],
  auth: { mode: "token" as const, token: "nats" },
}
const layer = (factory: typeof startAppServer) =>
  ResidentCodexLive(config, "unused", ciConfig, factory).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effect(CiService, makeCiStore),
        AgentRunStoreLive,
        KernelSessionStoreLive,
      ),
    ),
    Layer.provideMerge(WorkflowStoreLive),
    Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
  )
test("dispatches concurrent threads with independent directories and completes their event streams", async () => {
  const fake = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const resident = yield* ResidentCodex
      yield* resident.cli.preflight
      const processes = yield* Effect.all(
        [
          resident.cli.spawn({ runId: "a", directory: "/work/a", prompt: "done", model: null }),
          resident.cli.spawn({ runId: "b", directory: "/work/b", prompt: "done", model: "model" }),
        ],
        { concurrency: "unbounded" },
      )
      const results = yield* Effect.all(processes.map((p) => p.exited))
      expect(results.map((r) => r.exitCode)).toEqual([0, 0])
      expect(
        fake.calls
          .filter((c) => c.method === "thread/start")
          .map((c) => c.params.cwd)
          .sort(),
      ).toEqual(["/work/a", "/work/b"])
      expect(fake.calls.some((c) => c.method === "turn/start")).toBe(false)
      expect(yield* resident.route(new Request("http://localhost/unrelated"))).toBeUndefined()
      expect(
        (yield* resident.route(
          new Request("http://localhost/ci/resident-waits", { method: "POST" }),
        ))?.status,
      ).toBe(401)
    }).pipe(Effect.provide(layer(fake.factory))),
  )
})
test("a registered CI wait ends the old turn and queues a new one", async () => {
  const fake = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const resident = yield* ResidentCodex
      const runs = yield* AgentRunStore
      const sessions = yield* KernelSessionStore
      const ci = yield* CiService
      const now = new Date()
      yield* runs.create({
        runId: "a",
        route: "test",
        providerId: "codex-cli",
        modelId: "test-model",
        agent: "build",
        repository: "o/r",
        directory: "/work/a",
        prompt: "hold",
        promptSha256: "a".repeat(64),
        parentSessionId: null,
        resumePrompt: null,
        maxAttempts: 3,
        createdAt: now,
      })
      yield* runs.claimSpawn({ runId: "a", now })
      const process = yield* resident.cli.spawn({
        runId: "a",
        directory: "/work/a",
        prompt: "hold",
        model: null,
      })
      const events = process.events[Symbol.asyncIterator]()
      for (;;) {
        const next = yield* Effect.promise(() => events.next())
        if (next.value?.type === "agent_message") break
      }
      yield* sessions.registerResource({
        resourceId: "r",
        owningHostId: "h",
        absolutePath: "/work/a",
        kind: "worktree",
        createdAt: now,
      })
      yield* sessions.registerSession({
        sessionId: "s",
        providerKind: "codex",
        providerVersion: 1,
        providerId: "codex-cli",
        serverId: "h",
        owningHostId: "h",
        endpointAlias: "local-cli",
        endpointIdentity: "codex-cli://h",
        nativeSessionId: "thread-1",
        resourceId: "r",
        createdAt: now,
      })
      yield* runs.markSpawned({
        runId: "a",
        nativeSessionId: "thread-1",
        sessionId: "s",
        resourceId: "r",
        now,
      })
      yield* runs.markVerified({ runId: "a", outputTokens: 1, now })
      const target = { repository: "o/r", sha: "a".repeat(40) }
      const response = yield* resident.route(
        new Request("http://localhost/ci/resident-waits", {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({ ...target, threadId: "thread-1", timeoutMs: 60000 }),
        }),
      )
      expect(response?.status).toBe(202)
      fake.complete("thread-1", "dispatch:a")
      yield* ci.snapshot(
        target,
        [
          {
            id: 1,
            name: "CI",
            attempt: 1,
            status: "completed",
            conclusion: "failure",
            failingJobs: ["lint"],
          },
        ],
        null,
        Date.now(),
      )
      expect((yield* process.exited).exitCode).toBe(0)
      expect((yield* runs.read("a"))?.state).toBe("completed")
      expect(fake.calls.filter((c) => c.method === "thread/queue/add")).toHaveLength(2)
    }).pipe(Effect.provide(layer(fake.factory))),
  )
})

test("daemon restart reloads the same thread and queues interrupted work", async () => {
  const fake = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const resident = yield* ResidentCodex
      const process = yield* resident.cli.spawn({
        runId: "a",
        directory: "/work/a",
        prompt: "hold",
        model: "model-a",
      })
      const iterator = process.events[Symbol.asyncIterator]()
      for (;;) {
        const event = yield* Effect.promise(() => iterator.next())
        if (event.value?.type === "agent_message") break
      }
      fake.disconnect()
      expect((yield* process.exited).exitCode).toBe(0)
      const resumes = fake.calls.filter((c) => c.method === "thread/resume")
      expect(resumes).toHaveLength(1)
      expect(resumes[0]?.params).toMatchObject({
        threadId: "thread-1",
        cwd: "/work/a",
        model: "model-a",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      })
      expect(fake.calls.filter((c) => c.method === "thread/start")).toHaveLength(1)
    }).pipe(Effect.provide(layer(fake.factory))),
  )
})
