import { expect, test } from "bun:test"
import { Effect, Fiber, Layer, Schedule, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { AgentRunReceipt, type AgentRunSubmission } from "../../src/agent-run-contract"
import { routeRequest } from "../../src/http"
import { AgentRunIngress, AgentRunIngressLive } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { CodexCli } from "../../src/kernel/codex-session"
import { ResidentCodex, ResidentCodexLive } from "../../src/resident/service"
import { makeResidentStore } from "../../src/resident/store"
import { RpcClient } from "../../src/resident/rpc"
import type { startAppServer } from "../../src/resident/process"
import { CiService } from "../../src/ci/service"
import { makeCiStore } from "../../src/ci/store"
import {
  at,
  defaultState,
  makeLayer,
  makeProvider,
  worktrees,
} from "../kernel/agent-run-ingress-harness"

const Frame = Schema.Struct({
  id: Schema.Number,
  method: Schema.String,
  params: Schema.Record(Schema.String, Schema.Unknown),
})
const Refusal = Schema.Struct({ reason: Schema.String, detail: Schema.String })
const input: AgentRunSubmission = {
  route: "native",
  repository: "workflowd",
  prompt: "inert pending turn",
  idempotencyKey: "resident-verification",
}
const options = (root: string) => ({
  routes: [],
  codexRoutes: [{ name: "native", modelID: "native" }],
  claudeRoutes: [],
  repositories: [{ name: "workflowd", directory: root }],
  agent: "build",
  worktreeRoot: root,
  verifyTimeoutMs: 10,
  verifyPollIntervalMs: 2,
  progressWindowMs: 1000,
  maxAttempts: 3,
  claudeHosts: [],
  identity: {
    owningHostId: "mint",
    providerId: "opencode-primary",
    serverId: "opencode-primary",
    endpointAlias: "local",
    endpointIdentity: "http://127.0.0.1:4096",
    providerVersion: 1,
  },
})
function fixture(output = false) {
  const children: ReturnType<typeof Bun.spawn>[] = []
  const calls: Array<typeof Frame.Type> = []
  const queued = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let mode: "healthy" | "fail" | "hold" = "healthy"
  let native: ReturnType<typeof Bun.spawn> | undefined
  let closeAttempts = 0
  const factory: typeof startAppServer = (_options, notify) => {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    children.push(child)
    let clientId: unknown
    const rpc = new RpcClient((line) => {
      const frame = Schema.decodeUnknownSync(Frame)(JSON.parse(line))
      calls.push(frame)
      let result: unknown = {}
      if (frame.method === "thread/start") {
        native = child
        result = {
          thread: { id: "fixture-thread" },
          model: frame.params.model ?? "native",
          modelProvider: "native-provider",
          reasoningEffort: null,
        }
      }
      if (frame.method === "thread/queue/add") clientId = frame.params.clientUserMessageId
      if (frame.method === "thread/queue/list") result = { data: [], nextCursor: null }
      if (frame.method === "thread/read")
        result = {
          thread: {
            turns: [
              {
                id: "fixture-turn",
                status: "inProgress",
                items: clientId === undefined ? [] : [{ type: "userMessage", clientId }],
              },
            ],
          },
        }
      rpc.receive(JSON.stringify({ id: frame.id, result }))
      if (frame.method === "thread/queue/add") {
        queued.resolve()
        notify({
          method: "turn/started",
          params: {
            threadId: "fixture-thread",
            turn: { id: "fixture-turn", status: "inProgress" },
          },
        })
        if (output)
          notify({
            method: "item/completed",
            params: {
              threadId: "fixture-thread",
              item: { type: "agentMessage", text: "inert output" },
            },
          })
      }
    }, notify)
    return {
      pid: child.pid,
      rpc,
      initialize: async () => {},
      close: async () => {
        if (native === child) {
          closeAttempts++
          closing.resolve()
          if (mode === "fail") throw new Error("fixture resident closure unavailable")
          if (mode === "hold") await release.promise
        }
        rpc.close()
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await child.exited
      },
    }
  }
  return {
    factory,
    calls,
    queued,
    closing,
    release,
    setMode: (value: typeof mode) => {
      mode = value
    },
    alive: () => native !== undefined && native.exitCode === null && native.signalCode === null,
    attempts: () => closeAttempts,
    cleanup: async () => {
      mode = "healthy"
      release.resolve()
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await child.exited
      }
    },
  }
}
const call = (method: "POST" | "DELETE", runId?: string) =>
  Effect.gen(function* () {
    const ingress = yield* AgentRunIngress
    return yield* routeRequest(
      new Request(`http://fixture/workflows/agent-runs${runId === undefined ? "" : "/" + runId}`, {
        method,
        headers: { authorization: "Bearer secret" },
        ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
      }),
      { webhookSecret: "", now: at, agentRuns: { token: "secret", ...ingress } },
    )
  })
const refused = (response: Response) =>
  Effect.promise(() => response.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Refusal)))
const runId = Effect.gen(function* () {
  const row = yield* (yield* makeResidentStore).read("fixture-thread")
  if (row === null) throw new Error("No durable resident custody")
  return row.run_id
})
const configured = (
  config: ReturnType<typeof options>,
  fake: ReturnType<typeof fixture>,
  suffix = "",
) => {
  const resident = ResidentCodexLive(
    { socket: join(config.worktreeRoot, `resident${suffix}.sock`), home: config.worktreeRoot },
    "inert",
    { token: "fixture", repositories: [], servers: [], auth: { mode: "token", token: "fixture" } },
    fake.factory,
  ).pipe(Layer.provideMerge(Layer.effect(CiService, makeCiStore)))
  return AgentRunIngressLive(config).pipe(
    Layer.provideMerge(
      Layer.effect(
        CodexCli,
        Effect.map(ResidentCodex, (r) => r.cli),
      ).pipe(Layer.provideMerge(resident)),
    ),
  )
}
async function scenario(
  output: boolean,
  body: (
    fake: ReturnType<typeof fixture>,
    reload: ReturnType<typeof configured>,
  ) => Effect.Effect<
    void,
    unknown,
    | Effect.Services<ReturnType<typeof call>>
    | Effect.Services<typeof runId>
    | Effect.Services<typeof AgentRunStore>
    | Layer.Services<ReturnType<typeof configured>>
  >,
) {
  const root = await mkdtemp("/tmp/workflowd-resident-custody-")
  const fake = fixture(output)
  const config = options(root)
  const ingress = configured(config, fake)
  try {
    await Effect.runPromise(
      body(fake, configured(config, fake, "-reload")).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            fake.setMode("healthy")
            fake.release.resolve()
          }),
        ),
        Effect.provide(ingress),
        Effect.provide(makeLayer(makeProvider(defaultState()), worktrees([]), undefined, config)),
      ),
    )
  } finally {
    await fake.cleanup()
    await rm(root, { recursive: true, force: true })
  }
}
const interruptDispatch = (fake: ReturnType<typeof fixture>) =>
  Effect.gen(function* () {
    const pending = yield* call("POST").pipe(Effect.forkChild)
    yield* Effect.promise(() => fake.queued.promise)
    yield* Fiber.interrupt(pending)
  })
const fenced = (fake: ReturnType<typeof fixture>) =>
  Effect.gen(function* () {
    expect((yield* call("POST")).status).toBe(409)
    expect(fake.calls.filter((c) => c.method === "thread/start")).toHaveLength(1)
    expect(fake.calls.filter((c) => c.method === "thread/queue/add")).toHaveLength(1)
  })

test("resident timeout records failed only after the owned pre-verification process closes", () =>
  scenario(false, (fake) =>
    Effect.gen(function* () {
      const response = yield* call("POST")
      expect(response.status).toBe(409)
      expect((yield* refused(response)).reason).toBe("no_first_token")
      const store = yield* AgentRunStore
      expect((yield* store.read(yield* runId))?.state).toBe("failed")
      expect(fake.alive()).toBe(false)
      expect(fake.attempts()).toBe(1)
      yield* fenced(fake)
    }),
  ))

for (const stage of ["timeout", "interruption"] as const)
  test(`resident ${stage} failed closure retains typed custody and later cancellation closes the same execution`, () =>
    scenario(false, (fake) =>
      Effect.gen(function* () {
        fake.setMode("fail")
        if (stage === "timeout") {
          const response = yield* call("POST")
          expect(response.status).toBe(409)
          expect((yield* refused(response)).detail).toContain(
            "fixture resident closure unavailable",
          )
        } else yield* interruptDispatch(fake)
        const id = yield* runId
        const store = yield* AgentRunStore
        expect((yield* store.read(id))?.state).toBe(
          stage === "timeout" ? "operator_required" : "spawning",
        )
        expect((yield* store.read(id))?.nativeSessionId).toBeNull()
        expect(fake.alive()).toBe(true)
        const failed = yield* call("DELETE", id)
        expect(failed.status).toBe(409)
        expect(yield* refused(failed)).toMatchObject({
          reason: "run_conflict",
          detail: expect.stringContaining("fixture resident closure unavailable"),
        })
        expect((yield* store.read(id))?.state).toBe("operator_required")
        expect((yield* store.read(id))?.diagnostic).toContain(
          "fixture resident closure unavailable",
        )
        expect(fake.alive()).toBe(true)
        yield* fenced(fake)
        fake.setMode("healthy")
        expect((yield* call("DELETE", id)).status).toBe(204)
        expect((yield* store.read(id))?.state).toBe("cancelled")
        expect(fake.alive()).toBe(false)
        yield* fenced(fake)
      }),
    ))

for (const stage of ["interruption", "verified"] as const)
  test(`resident ${stage} cancellation awaits closure before returning terminal success`, () =>
    scenario(stage === "verified", (fake) =>
      Effect.gen(function* () {
        if (stage === "interruption") yield* interruptDispatch(fake)
        else {
          const response = yield* call("POST")
          expect(response.status).toBe(202)
          yield* Effect.promise(() => response.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(AgentRunReceipt)),
          )
        }
        const store = yield* AgentRunStore
        const id = yield* runId
        fake.setMode("hold")
        const pending = yield* call("DELETE", id).pipe(Effect.forkChild)
        yield* Effect.promise(() => fake.closing.promise).pipe(Effect.timeout("2 seconds"))
        expect(fake.alive()).toBe(true)
        expect((yield* store.read(id))?.state).toBe(stage === "verified" ? "verified" : "spawning")
        expect(pending.pollUnsafe()).toBeUndefined()
        fake.release.resolve()
        expect((yield* Fiber.join(pending)).status).toBe(204)
        expect(fake.alive()).toBe(false)
        expect((yield* store.read(id))?.state).toBe("cancelled")
        yield* fenced(fake)
      }),
    ))

test("background operator cleanup uses resident run ownership before generic session verification", () =>
  scenario(false, (fake) =>
    Effect.gen(function* () {
      yield* interruptDispatch(fake)
      const id = yield* runId
      const store = yield* AgentRunStore
      yield* store.operatorRequired({ runId: id, diagnostic: "fixture operator cleanup", now: at })
      yield* Effect.promise(() => fake.closing.promise).pipe(Effect.timeout("2 seconds"))
      yield* Effect.sync(() => fake.alive()).pipe(
        Effect.repeat({ while: (alive) => alive, schedule: Schedule.spaced(5) }),
        Effect.timeout("2 seconds"),
      )
      expect(fake.alive()).toBe(false)
      expect((yield* store.read(id))?.nativeSessionId).toBeNull()
      expect((yield* call("DELETE", id)).status).toBe(204)
      expect((yield* store.read(id))?.state).toBe("cancelled")
      yield* fenced(fake)
    }),
  ))

test("resident cancellation after reacquisition refuses unproven old custody without starting another process", () =>
  scenario(false, (_fake, reload) =>
    Effect.gen(function* () {
      const store = yield* AgentRunStore
      const resident = yield* makeResidentStore
      yield* store.create({
        runId: "agent-run-" + "a".repeat(64),
        route: "old",
        providerId: "codex-cli",
        executorKind: "codex",
        modelId: "native",
        agent: "build",
        repository: "workflowd",
        directory: "/old",
        prompt: "old",
        promptSha256: "a".repeat(64),
        parentSessionId: null,
        resumePrompt: null,
        maxAttempts: 3,
        createdAt: at,
      })
      yield* store.claimSpawn({ runId: "agent-run-" + "a".repeat(64), now: at })
      yield* resident.attach("agent-run-" + "a".repeat(64), "old-thread", "/old", "native")
      const response = yield* call("DELETE", "agent-run-" + "a".repeat(64)).pipe(
        Effect.provide(reload),
      )
      expect(response.status).toBe(409)
      expect(yield* refused(response)).toMatchObject({
        reason: "run_conflict",
        detail: expect.stringContaining("closure cannot be confirmed"),
      })
      expect((yield* store.read("agent-run-" + "a".repeat(64)))?.state).toBe("operator_required")
      expect((yield* resident.read("old-thread"))?.state).toBe("operator_required")
      expect(
        _fake.calls.filter((c) => c.method === "thread/start" || c.method === "thread/queue/add"),
      ).toHaveLength(0)
    }),
  ))

test("resident closure proof survives reacquisition and permits cancellation without another queue or launch", () =>
  scenario(false, (fake, reload) =>
    Effect.gen(function* () {
      yield* interruptDispatch(fake)
      const id = yield* runId
      const store = yield* AgentRunStore
      yield* store.operatorRequired({ runId: id, diagnostic: "fixture operator cleanup", now: at })
      yield* Effect.promise(() => fake.closing.promise).pipe(Effect.timeout("2 seconds"))
      yield* Effect.sync(() => fake.alive()).pipe(
        Effect.repeat({ while: (alive) => alive, schedule: Schedule.spaced(5) }),
        Effect.timeout("2 seconds"),
      )
      expect((yield* call("DELETE", id).pipe(Effect.provide(reload))).status).toBe(204)
      expect((yield* store.read(id))?.state).toBe("cancelled")
      expect(fake.alive()).toBe(false)
      yield* fenced(fake)
    }),
  ))
