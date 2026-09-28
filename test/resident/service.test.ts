import { join } from "node:path"
import { requestRunSocket } from "../../src/worker-identity/socket-client"
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
  const pids = new Map<string, number>()
  const probes = new Map<number, (socket: string, targets: string[]) => Promise<string>>()
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
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      const { requestRunSocket } = await import(process.env.TEST_CLIENT);
      const text = await Bun.stdin.text();
      if (text) {
        const input = JSON.parse(text);
        const statuses = [];
        for (const threadId of input.targets) statuses.push((await requestRunSocket(input.socket, "/ci/resident-waits", JSON.stringify({
          threadId, repository: "o/r", sha: "a".repeat(40), timeoutMs: 60000,
        }))).status);
        console.log(statuses.join(","));
      }
    `,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        env: {
          ...process.env,
          TEST_CLIENT: join(import.meta.dir, "../../src/worker-identity/socket-client.ts"),
        },
      },
    )
    probes.set(child.pid, async (socket, targets) => {
      child.stdin.write(JSON.stringify({ socket, targets }))
      child.stdin.end()
      const output = await new Response(child.stdout).text()
      await child.exited
      return output.trim()
    })
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
      if (frame.method === "thread/start") {
        const id = `thread-${++counter}`
        pids.set(id, child.pid)
        result = { thread: { id } }
      }
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
      pid: child.pid,
      rpc,
      initialize: async () => {},
      close: async () => {
        rpc.close()
        child.stdin.end()
        await child.exited
      },
    }
  }
  return {
    factory,
    pids,
    probe: (thread: string, targets: string[]) =>
      probes.get(pids.get(thread)!)!(config.socket, targets),
    calls,
    disconnect: () => {
      currentRpc?.close()
      notify({ method: "workflowd/disconnected", params: null })
    },
    complete: (threadId: string, id: string) =>
      notify({ method: "turn/completed", params: { threadId, turn: { id, status: "completed" } } }),
  }
}
const config = {
  socket: `/tmp/workflowd-resident-test-${process.pid}.sock`,
  home: "/scratch/codex",
}
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
const prepareRun = (now: Date, runId = "a") =>
  Effect.gen(function* () {
    const runs = yield* AgentRunStore
    yield* runs.create({
      runId,
      route: "test",
      providerId: "codex-cli",
      modelId: "test-model",
      agent: "build",
      repository: "o/r",
      directory: `/work/${runId}`,
      prompt: "hold",
      promptSha256: "a".repeat(64),
      parentSessionId: null,
      resumePrompt: null,
      maxAttempts: 3,
      createdAt: now,
    })
    yield* runs.claimSpawn({ runId, now })
  })
const verifyRun = (now: Date, runId = "a", threadId = "thread-1") =>
  Effect.gen(function* () {
    const runs = yield* AgentRunStore
    const sessions = yield* KernelSessionStore
    yield* sessions.registerResource({
      resourceId: `r-${runId}`,
      owningHostId: "h",
      absolutePath: `/work/${runId}`,
      kind: "worktree",
      createdAt: now,
    })
    yield* sessions.registerSession({
      sessionId: `s-${runId}`,
      providerKind: "codex",
      providerVersion: 1,
      providerId: "codex-cli",
      serverId: "h",
      owningHostId: "h",
      endpointAlias: "local-cli",
      endpointIdentity: "codex-cli://h",
      nativeSessionId: threadId,
      resourceId: `r-${runId}`,
      createdAt: now,
    })
    yield* runs.markSpawned({
      runId,
      nativeSessionId: threadId,
      sessionId: `s-${runId}`,
      resourceId: `r-${runId}`,
      now,
    })
    yield* runs.markVerified({ runId, outputTokens: 1, now })
  })
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
      ).toBe(403)
    }).pipe(Effect.provide(layer(fake.factory))),
  )
})
test("a registered CI wait ends the old turn and queues a new one", async () => {
  const fake = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const resident = yield* ResidentCodex
      const runs = yield* AgentRunStore
      const ci = yield* CiService
      const now = new Date()
      yield* prepareRun(now)
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
      yield* verifyRun(now)
      const target = { repository: "o/r", sha: "a".repeat(40) }
      const other = yield* resident.cli.spawn({
        runId: "b",
        directory: "/work/b",
        prompt: "hold",
        model: null,
      })
      expect(other).toBeDefined()
      const wait = () =>
        new Request("http://localhost/ci/resident-waits", {
          method: "POST",
          body: JSON.stringify({ ...target, threadId: "thread-1", timeoutMs: 60000 }),
        })
      expect((yield* resident.route(wait(), fake.pids.get("thread-2")))?.status).toBe(403)
      expect((yield* resident.route(wait(), process.pid))?.status).toBe(403)
      const response = yield* resident.route(
        new Request("http://localhost/ci/resident-waits", {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({ ...target, threadId: "thread-1", timeoutMs: 60000 }),
        }),
        fake.pids.get("thread-1"),
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
      expect(fake.calls.filter((c) => c.method === "thread/queue/add")).toHaveLength(3)
    }).pipe(Effect.provide(layer(fake.factory))),
  )
})

test("daemon restart reloads the same thread and queues interrupted work", async () => {
  const fake = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const resident = yield* ResidentCodex
      const now = new Date()
      yield* prepareRun(now)
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
      yield* verifyRun(now)
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

test("restart cannot wake a thread without verified dispatch custody", async () => {
  const fake = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const resident = yield* ResidentCodex
      const process = yield* resident.cli.spawn({
        runId: "orphan",
        directory: "/work/a",
        prompt: "hold",
        model: null,
      })
      const iterator = process.events[Symbol.asyncIterator]()
      for (;;) {
        const event = yield* Effect.promise(() => iterator.next())
        if (event.value?.type === "agent_message") break
      }
      fake.disconnect()
      expect((yield* process.exited).exitCode).toBe(1)
      expect(fake.calls.filter((c) => c.method === "thread/resume")).toHaveLength(0)
    }).pipe(Effect.provide(layer(fake.factory))),
  )
})

test("two resident roots cannot register each other's thread waits over the socket", async () => {
  const fake = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const resident = yield* ResidentCodex
      const now = new Date()
      for (const [runId, threadId] of [
        ["a", "thread-1"],
        ["b", "thread-2"],
      ] as const) {
        yield* prepareRun(now, runId)
        yield* resident.cli.spawn({
          runId,
          directory: `/work/${runId}`,
          prompt: "hold",
          model: null,
        })
        yield* verifyRun(now, runId, threadId)
      }
      expect(
        (yield* Effect.promise(() =>
          requestRunSocket(
            config.socket,
            "/ci/resident-waits",
            JSON.stringify({
              threadId: "thread-1",
              repository: "o/r",
              sha: "a".repeat(40),
              timeoutMs: 60000,
            }),
          ),
        )).status,
      ).toBe(403)
      const statuses = yield* Effect.promise(() =>
        Promise.all([
          fake.probe("thread-1", ["thread-2", "thread-1"]),
          fake.probe("thread-2", ["thread-1", "thread-2"]),
        ]),
      )
      expect(statuses).toEqual(["403,202", "403,202"])
    }).pipe(Effect.provide(layer(fake.factory))),
  )
})
