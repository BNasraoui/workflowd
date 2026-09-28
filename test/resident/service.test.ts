import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { makeResidentStore } from "../../src/resident/store"
import { join } from "node:path"
import { requestRunSocket } from "../../src/worker-identity/socket-client"
import { expect, test } from "bun:test"
import { Effect, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
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
  let rejectedMethod: string | undefined
  const closed: number[] = []
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
        for (const runId of input.targets) statuses.push((await requestRunSocket(input.socket, "/subscriptions", JSON.stringify({
          runId, selector: {kind: "ci", repository: "o/r", sha: "a".repeat(40)},
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
      void child.stdin.end()
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
      if (frame.method === rejectedMethod) {
        rpc.receive(
          JSON.stringify({ id: frame.id, error: { code: -32601, message: "method not found" } }),
        )
        return
      }
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
        closed.push(child.pid)
        rpc.close()
        void child.stdin.end()
        await child.exited
      },
    }
  }
  return {
    factory,
    closed,
    reject: (method: string) => {
      rejectedMethod = method
    },
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
        KernelEventStoreLive,
        KernelSessionStoreLive,
      ),
    ),
    Layer.provideMerge(WorkflowStoreLive),
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
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
        (yield* resident.route(new Request("http://localhost/subscriptions", { method: "POST" })))
          ?.status,
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
        new Request("http://localhost/subscriptions", {
          method: "POST",
          body: JSON.stringify({ runId: "a", selector: { kind: "ci", ...target } }),
        })
      expect((yield* resident.route(wait(), fake.pids.get("thread-2")))?.status).toBe(403)
      expect((yield* resident.route(wait(), globalThis.process.pid))?.status).toBe(403)
      const response = yield* resident.route(
        new Request("http://localhost/subscriptions", {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({ runId: "a", selector: { kind: "ci", ...target } }),
        }),
        fake.pids.get("thread-1"),
      )
      expect(response?.status).toBe(202)
      expect((yield* resident.route(wait(), fake.pids.get("thread-1")))?.status).toBe(202)
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
            "/subscriptions",
            JSON.stringify({
              runId: "a",
              selector: { kind: "ci", repository: "o/r", sha: "a".repeat(40) },
            }),
          ),
        )).status,
      ).toBe(403)
      const statuses = yield* Effect.promise(() =>
        Promise.all([fake.probe("thread-1", ["b", "a"]), fake.probe("thread-2", ["a", "b"])]),
      )
      expect(statuses).toEqual(["403,202", "403,202"])
    }).pipe(Effect.provide(layer(fake.factory))),
  )
})

for (const method of ["thread/queue/add", "thread/queue/list", "thread/read"]) {
  test(`resident persists operator-required after rejected ${method}`, async () => {
    const fake = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const resident = yield* ResidentCodex
        const store = yield* makeResidentStore
        const runs = yield* AgentRunStore
        const now = new Date()
        yield* prepareRun(now)
        if (method === "thread/queue/add") fake.reject(method)
        const process = yield* resident.cli.spawn({
          runId: "a",
          directory: "/work/a",
          prompt: "hold",
          model: null,
        })
        if (method !== "thread/queue/add") {
          yield* verifyRun(now)
          yield* store.enqueue("lost", "thread-1", "wake")
          yield* store.sending("lost")
          fake.reject(method)
        }
        expect((yield* process.exited).exitCode).toBe(1)
        expect((yield* store.read("thread-1"))?.state).toBe("operator_required")
        expect(yield* store.pending()).toHaveLength(0)
        if (method !== "thread/queue/add")
          expect((yield* runs.read("a"))?.state).toBe("operator_required")
      }).pipe(Effect.provide(layer(fake.factory))),
    )
  })
}

test("completed resident runs release their owned app-server", async () => {
  const fake = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const resident = yield* ResidentCodex
      const process = yield* resident.cli.spawn({
        runId: "a",
        directory: "/work/a",
        prompt: "done",
        model: null,
      })
      yield* process.exited
      yield* Effect.sleep(30)
      expect(fake.closed).toContain(fake.pids.get("thread-1")!)
    }).pipe(Effect.provide(layer(fake.factory))),
  )
})

for (const kind of ["ci", "agent_run"] as const) {
  for (const reject of [false, true]) {
    test(`${kind} already finished delivers immediately, queue failure=${reject}`, async () => {
      const fake = fixture()
      await Effect.runPromise(
        Effect.gen(function* () {
          const resident = yield* ResidentCodex
          const store = yield* makeResidentStore
          const ci = yield* CiService
          const runs = yield* AgentRunStore
          const now = new Date()
          yield* prepareRun(now)
          const process = yield* resident.cli.spawn({
            runId: "a",
            directory: "/work/a",
            prompt: "hold",
            model: null,
          })
          const iterator = process.events[Symbol.asyncIterator]()
          for (;;) {
            const event = yield* Effect.promise(() => iterator.next())
            if (event.value?.type === "agent_message") break
          }
          yield* verifyRun(now)
          const target = { repository: "o/r", sha: "a".repeat(40) }
          if (kind === "ci") {
            yield* ci.watch(target, 1, ["CI"], Date.now())
            yield* ci.snapshot(
              target,
              [
                {
                  id: 7,
                  name: "CI",
                  attempt: 1,
                  status: "completed",
                  conclusion: "success",
                  failingJobs: [],
                },
              ],
              null,
              Date.now(),
            )
          } else {
            yield* prepareRun(now, "child")
            yield* runs.fail({ runId: "child", diagnostic: "spawn failed", now })
          }
          if (reject) fake.reject("thread/queue/add")
          const selector = kind === "ci" ? { kind, ...target } : { kind, run_id: "child" }
          const response = yield* resident.route(
            new Request("http://localhost/subscriptions", {
              method: "POST",
              body: JSON.stringify({ runId: "a", selector }),
            }),
            fake.pids.get("thread-1"),
          )
          expect(response?.status).toBe(202)
          const receipt = yield* Effect.promise(() => response!.json())
          expect(receipt).toMatchObject({
            deliveryState: reject ? "operator_required" : "delivered",
          })
          if (reject)
            expect(receipt).toMatchObject({
              instruction: expect.stringContaining("operator attention"),
            })
          expect((yield* process.exited).exitCode).toBe(reject ? 1 : 0)
          expect(fake.calls.filter((c) => c.method === "thread/queue/add")).toHaveLength(2)
          expect((yield* store.read("thread-1"))?.state).toBe(
            reject ? "operator_required" : "finished",
          )
          const sql = yield* SqlClient.SqlClient
          const messages =
            yield* sql`SELECT state FROM resident_inbox WHERE id LIKE 'subscription-%'`
          expect(messages).toHaveLength(1)
          expect(messages[0]?.state).toBe(reject ? "operator_required" : "delivered")
        }).pipe(Effect.provide(layer(fake.factory))),
      )
    })
  }
}

test("restart delivers both CI subscribers once after prepared inbox rows are committed", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { makeSubscriptions } = await import("../../src/resident/subscriptions")
  const directory = await mkdtemp(join(tmpdir(), "workflowd-prepared-restart-"))
  const persistence = Layer.mergeAll(
    Layer.effect(CiService, makeCiStore),
    AgentRunStoreLive,
    KernelEventStoreLive,
    KernelSessionStoreLive,
  ).pipe(
    Layer.provideMerge(WorkflowStoreLive),
    Layer.provideMerge(SqliteClient.layer({ filename: join(directory, "store.sqlite") })),
  )
  const fake = fixture()
  const target = { repository: "o/r", sha: "a".repeat(40) }
  try {
    const receipts = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeResidentStore
        const subscriptions = yield* makeSubscriptions
        const ci = yield* CiService
        const ids: string[] = []
        const now = new Date()
        yield* ci.watch(target, 1, ["CI"], Date.now())
        for (const [runId, threadId] of [
          ["a", "thread-1"],
          ["b", "thread-2"],
        ] as const) {
          yield* prepareRun(now, runId)
          yield* verifyRun(now, runId, threadId)
          yield* store.attach(runId, threadId, `/work/${runId}`, null)
          yield* store.started(threadId, `dispatch:${runId}`)
          ids.push((yield* subscriptions.register(threadId, { kind: "ci", ...target })).id)
          expect(yield* store.completed(threadId, `dispatch:${runId}`)).toBe("waiting")
        }
        yield* ci.snapshot(
          target,
          [
            {
              id: 42,
              name: "CI",
              attempt: 1,
              status: "completed",
              conclusion: "success",
              failingJobs: [],
            },
          ],
          null,
          Date.now(),
        )
        yield* subscriptions.reconcile()
        expect((yield* store.pending()).map((message) => message.state)).toEqual([
          "prepared",
          "prepared",
        ])
        expect(fake.calls).toEqual([])
        return ids
      }).pipe(Effect.provide(persistence)),
    )

    // The first scope closed its SQLite connection before any app-server existed.
    // Reopen the file and let the real resident restore and flush both mailboxes.
    for (let restart = 0; restart < 2; restart++) {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* ResidentCodex
          const store = yield* makeResidentStore
          yield* store.pending().pipe(
            Effect.repeat({
              while: (messages) => messages.length > 0,
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout("3 seconds"),
          )
          yield* store
            .threads()
            .pipe(
              Effect.repeat({
                while: (threads) => threads.length > 0,
                schedule: Schedule.spaced("10 millis"),
              }),
              Effect.timeout("3 seconds"),
            )
          const sql = yield* SqlClient.SqlClient
          expect(
            yield* sql`SELECT thread_id, state FROM resident_inbox ORDER BY thread_id`,
          ).toEqual([
            { thread_id: "thread-1", state: "delivered" },
            { thread_id: "thread-2", state: "delivered" },
          ])
        }).pipe(
          Effect.provide(
            ResidentCodexLive(
              { socket: join(directory, "resident.sock"), home: directory },
              "unused",
              ciConfig,
              fake.factory,
            ).pipe(Layer.provideMerge(persistence)),
          ),
        ),
      )
    }
    const queued = fake.calls.filter((call) => call.method === "thread/queue/add")
    expect(queued).toHaveLength(2)
    expect(queued.map((call) => call.params.threadId).sort()).toEqual(["thread-1", "thread-2"])
    expect(queued.map((call) => call.params.clientUserMessageId).sort()).toEqual(receipts.sort())
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
