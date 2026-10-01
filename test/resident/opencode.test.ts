import { OpenCodeAdapterError } from "../../src/opencode/adapter"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { CiService } from "../../src/ci/service"
import { makeCiStore } from "../../src/ci/store"
import { WorkflowStoreLive } from "../../src/store"
import { makeResidentStore } from "../../src/resident/store"
import { makeOpenCodeMailbox, type OpenCodeMailboxProvider } from "../../src/resident/opencode"

const identity = {
  owningHostId: "test",
  providerId: "test-server",
  serverId: "test-server",
  endpointAlias: "fixture",
  endpointIdentity: "fixture://opencode",
  providerVersion: 1,
}
const options = {
  ...identity,
  socket: "/unused-test.sock",
  repositories: [{ repository: "o/r", installationId: 1, workflows: ["CI"] }],
}
const target = { kind: "ci" as const, repository: "o/r", sha: "a".repeat(40) }
const layer = (filename = ":memory:") =>
  Layer.mergeAll(
    KernelEventStoreLive,
    AgentRunStoreLive,
    KernelSessionStoreLive,
    Layer.effect(CiService, makeCiStore),
  ).pipe(
    Layer.provideMerge(WorkflowStoreLive),
    Layer.provideMerge(SqliteClient.layer({ filename })),
  )
const seed = (id: string) =>
  Effect.gen(function* () {
    const runs = yield* AgentRunStore
    const sessions = yield* KernelSessionStore
    const now = new Date()
    yield* sessions.registerResource({
      resourceId: id,
      owningHostId: "test",
      absolutePath: `/fixture/${id}`,
      kind: "worktree",
      createdAt: now,
    })
    yield* sessions.registerSession({
      ...identity,
      sessionId: id,
      nativeSessionId: `ses_${id}`,
      resourceId: id,
      providerKind: "opencode",
      createdAt: now,
    })
    yield* runs.create({
      runId: id,
      route: "test",
      providerId: "provider",
      modelId: "model",
      agent: "build",
      repository: "o/r",
      directory: `/fixture/${id}`,
      prompt: "task",
      promptSha256: "a".repeat(64),
      parentSessionId: null,
      resumePrompt: null,
      maxAttempts: 1,
      createdAt: now,
    })
    yield* runs.claimSpawn({ runId: id, now })
    yield* runs.markSpawned({
      runId: id,
      resourceId: id,
      sessionId: id,
      nativeSessionId: `ses_${id}`,
      now,
    })
  })
const complete = Effect.gen(function* () {
  const ci = yield* CiService
  yield* ci.watch(target, 1, ["CI"], Date.now())
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
})
function fixture() {
  const environments = new Map<string, Readonly<Record<string, string>>>()
  const prompts: Array<{ sessionID: string; text: string }> = []
  let exists = true
  let failure: "refused" | "offline" | undefined
  const provider: OpenCodeMailboxProvider = {
    sessionExists: () =>
      failure === "offline"
        ? Effect.fail(new OpenCodeAdapterError({ operation: "probe", cause: new Error("offline") }))
        : Effect.succeed(exists),
    promptSession: (input) =>
      failure === "refused"
        ? Effect.fail(
            new OpenCodeAdapterError({ operation: "prompt", cause: new Error("refused") }),
          )
        : Effect.sync(() => {
            prompts.push(input)
          }),
    setSessionEnvironment: (input) =>
      Effect.sync(() => {
        environments.set(input.sessionID, input.variables)
      }),
  }
  return {
    provider,
    environments,
    prompts,
    fail: (mode: "refused" | "offline") => {
      failure = mode
    },
    gone: () => {
      exists = false
    },
  }
}
const request = (
  env: Readonly<Record<string, string>>,
  selector: unknown = target,
  runId = env.WORKFLOWD_RUN_ID,
) =>
  new Request("http://fixture/subscriptions", {
    method: "POST",
    body: JSON.stringify({ runId, capability: env.WORKFLOWD_SUBSCRIPTION_CAPABILITY, selector }),
  })

for (const late of [false, true])
  test(`OpenCode delivers once to two run-bound subscribers (late=${late})`, () => {
    const fake = fixture()
    return Effect.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* makeOpenCodeMailbox(options, fake.provider)
        const runs = yield* AgentRunStore
        const inbox = yield* makeResidentStore
        for (const id of ["one", "two"]) {
          yield* seed(id)
          yield* mailbox.prepare(id)
          yield* runs.markVerified({ runId: id, outputTokens: 1, now: new Date() })
        }
        if (late) yield* complete
        for (const id of ["one", "two"]) {
          const env = fake.environments.get(`ses_${id}`)!
          expect(
            (yield* mailbox.route(
              request(env, { ...target, repository: "O/R", sha: target.sha.toUpperCase() }),
            )).status,
          ).toBe(202)
          expect((yield* mailbox.route(request(env))).status).toBe(202)
        }
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT repository FROM ci_targets`).toEqual([{ repository: "o/r" }])
        if (!late) {
          expect(fake.prompts).toHaveLength(0)
          expect(
            yield* runs.nextWatchable({
              now: new Date(),
              staleAfterMs: 1000,
              unsupervisedExecutorKinds: [],
            }),
          ).toBeNull()
          yield* complete
        }
        yield* mailbox.tick
        yield* complete
        yield* mailbox.tick
        expect(fake.prompts.map((p) => p.sessionID).sort()).toEqual(["ses_one", "ses_two"])
        expect(fake.prompts[0]?.text).toContain('"conclusion":"success"')
        expect(yield* inbox.pending("opencode")).toHaveLength(0)
        expect(yield* inbox.threads()).toHaveLength(0)
        expect(yield* sql`SELECT state FROM resident_inbox`).toEqual([
          { state: "delivered" },
          { state: "delivered" },
        ])
        const stolen = fake.environments.get("ses_one")!
        expect((yield* mailbox.route(request(stolen, target, "two"))).status).toBe(403)
        expect(
          (yield* mailbox.route(request(stolen, { ...target, threadId: "ses_two" }))).status,
        ).toBe(409)
        expect(
          (yield* mailbox.route(request(stolen, { ...target, repository: "other/repo" }))).status,
        ).toBe(403)
      }).pipe(Effect.provide(layer())),
    )
  })

for (const sending of [false, true])
  test(`OpenCode restart recovers persisted delivery (sending=${sending})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "workflowd-opencode-inbox-"))
    const filename = join(directory, "test.sqlite")
    const fake = fixture()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* makeOpenCodeMailbox(options, fake.provider)
          yield* seed("one")
          yield* mailbox.prepare("one")
          const runs = yield* AgentRunStore
          yield* runs.markVerified({ runId: "one", outputTokens: 1, now: new Date() })
          expect((yield* mailbox.route(request(fake.environments.get("ses_one")!))).status).toBe(
            202,
          )
          yield* complete
          const { makeSubscriptions } = yield* Effect.promise(
            () => import("../../src/resident/subscriptions"),
          )
          yield* (yield* makeSubscriptions).reconcile()
          const inbox = yield* makeResidentStore
          if (sending) yield* inbox.sending((yield* inbox.pending("opencode"))[0]!.id)
        }).pipe(Effect.provide(layer(filename))),
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* makeOpenCodeMailbox(options, fake.provider)
          yield* mailbox.tick
          yield* mailbox.tick
          expect(fake.prompts).toHaveLength(sending ? 0 : 1)
          const sql = yield* SqlClient.SqlClient
          expect(yield* sql`SELECT state FROM resident_inbox`).toEqual([
            { state: sending ? "operator_required" : "delivered" },
          ])
        }).pipe(Effect.provide(layer(filename))),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

for (const mode of ["gone", "refused", "offline"] as const)
  test(`OpenCode ${mode} makes the subscription and run operator-required`, () => {
    const fake = fixture()
    return Effect.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* makeOpenCodeMailbox(options, fake.provider)
        yield* seed("one")
        yield* mailbox.prepare("one")
        const runs = yield* AgentRunStore
        yield* runs.markVerified({ runId: "one", outputTokens: 1, now: new Date() })
        yield* mailbox.route(request(fake.environments.get("ses_one")!))
        if (mode === "gone") fake.gone()
        else fake.fail(mode)
        yield* complete
        yield* mailbox.tick
        yield* mailbox.tick
        expect(fake.prompts).toHaveLength(0)
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT state FROM resident_inbox`).toEqual([
          { state: "operator_required" },
        ])
        expect((yield* runs.read("one"))?.state).toBe("operator_required")
      }).pipe(Effect.provide(layer())),
    )
  })

test("OpenCode agent-run completion crosses the run-bound subscription socket", async () => {
  const { OpenCodeMailbox, OpenCodeMailboxLive } = await import("../../src/resident/opencode")
  const { subscribeToEvent } = await import("../../src/resident/subscribe")
  const directory = await mkdtemp(join(tmpdir(), "workflowd-opencode-socket-"))
  const fake = fixture()
  try {
    const live = OpenCodeMailboxLive(
      { ...options, socket: join(directory, "mailbox.sock") },
      fake.provider,
    ).pipe(Layer.provideMerge(layer()))
    await Effect.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* OpenCodeMailbox
        const runs = yield* AgentRunStore
        yield* seed("parent")
        yield* seed("child")
        yield* mailbox.prepare("parent")
        yield* runs.markVerified({ runId: "parent", outputTokens: 1, now: new Date() })
        yield* runs.markVerified({ runId: "child", outputTokens: 1, now: new Date() })
        const env = fake.environments.get("ses_parent")!
        const receipt = yield* Effect.tryPromise(() =>
          subscribeToEvent({ kind: "agent_run", run_id: "child" }, env),
        )
        expect(receipt.deliveryState).toBe("pending")
        yield* runs.complete({ runId: "child", now: new Date() })
        yield* mailbox.tick
        yield* mailbox.tick
        expect(fake.prompts).toHaveLength(1)
        expect(fake.prompts[0]?.text).toContain('"summaryPointer":"ses_child"')
        expect(fake.prompts[0]?.text).toContain('"status":"completed"')
        const duplicate = yield* Effect.tryPromise(() =>
          subscribeToEvent({ kind: "agent_run", run_id: "child" }, env),
        )
        expect(duplicate.id).toBe(receipt.id)
        expect(duplicate.deliveryState).toBe("delivered")
      }).pipe(Effect.provide(live)),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
