import { expect, spyOn, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { CiService } from "../../src/ci/service"
import { makeCiStore } from "../../src/ci/store"
import { WorkflowStoreLive } from "../../src/store"
import { makeResidentStore } from "../../src/resident/store"
import { makeSubscriptions } from "../../src/resident/subscriptions"

import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"

const layer = Layer.mergeAll(
  KernelSessionStoreLive,
  KernelEventStoreLive,
  AgentRunStoreLive,
  Layer.effect(CiService, makeCiStore),
).pipe(
  Layer.provideMerge(WorkflowStoreLive),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
)
const target = { repository: "o/r", sha: "a".repeat(40) }
for (const alreadyFinished of [false, true]) {
  test(`CI subscription delivers once, including replay and late registration (${alreadyFinished})`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeResidentStore
        const ci = yield* CiService
        const subscriptions = yield* makeSubscriptions
        yield* store.attach("run", "thread", "/work", null)
        yield* store.started("thread", "turn")
        yield* ci.watch(target, 1, ["CI"], Date.now())
        const complete = ci.snapshot(
          target,
          [
            {
              id: 42,
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
        if (alreadyFinished) yield* complete
        yield* store.attach("other-run", "other-thread", "/other-work", null)
        yield* store.started("other-thread", "other-turn")
        const selector = { kind: "ci" as const, ...target }
        const receipt = yield* subscriptions.register("thread", selector)
        expect((yield* subscriptions.register("thread", selector)).id).toBe(receipt.id)
        const otherReceipt = yield* subscriptions.register("other-thread", selector)
        expect(otherReceipt.id).not.toBe(receipt.id)
        expect((yield* subscriptions.register("other-thread", selector)).id).toBe(otherReceipt.id)
        expect(yield* store.completed("other-thread", "other-turn")).toBe("waiting")
        expect(yield* store.completed("thread", "turn")).toBe("waiting")
        if (!alreadyFinished) {
          expect(yield* store.pending()).toHaveLength(0)
          yield* complete
        }
        yield* subscriptions.reconcile()
        const messages = yield* store.pending()
        expect(messages).toHaveLength(2)
        expect(messages.map((message) => message.thread_id).sort()).toEqual([
          "other-thread",
          "thread",
        ])
        expect(messages[0]?.prompt).toContain('"failingJobs":["lint"]')
        expect(messages[0]?.prompt).toContain("https://github.com/o/r/actions/runs/42")
        const webhook = {
          _tag: "CiCompletion" as const,
          ...target,
          installationId: 1,
          source: "workflow_run" as const,
          sourceId: 42,
          conclusion: "failure",
        }
        expect(yield* ci.ingest("delivery", webhook, "{}", Date.now())).toBe("accepted")
        expect(yield* ci.ingest("delivery", webhook, "{}", Date.now())).toBe("duplicate")
        yield* store.delivered(receipt.id)
        yield* store.delivered(otherReceipt.id)
        yield* complete
        yield* subscriptions.reconcile()
        yield* subscriptions.register("thread", selector)
        yield* subscriptions.register("other-thread", selector)
        expect(yield* store.pending()).toHaveLength(0)
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT * FROM resident_inbox WHERE thread_id IS NOT NULL`).toHaveLength(2)
        expect(yield* sql`SELECT state FROM kernel_waits`).toEqual([
          { state: "consumed" },
          { state: "consumed" },
        ])
      }).pipe(Effect.provide(layer)),
    ))
}

for (const state of ["completed", "failed", "cancelled", "operator_required"] as const) {
  test(`agent run ${state} produces one mailbox message with a summary pointer`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeResidentStore
        const subscriptions = yield* makeSubscriptions
        const sql = yield* SqlClient.SqlClient
        yield* store.attach("parent", "thread", "/work", null)
        yield* store.started("thread", "turn")
        const runs = yield* AgentRunStore
        yield* runs.create({
          runId: "child",
          route: "test",
          providerId: "codex-cli",
          modelId: "m",
          agent: "build",
          repository: "o/r",
          directory: "/child",
          prompt: "task",
          promptSha256: "a".repeat(64),
          parentSessionId: null,
          resumePrompt: null,
          maxAttempts: 1,
          createdAt: new Date(),
        })
        yield* subscriptions.register("thread", { kind: "agent_run", run_id: "child" })
        expect(yield* store.pending()).toHaveLength(0)
        yield* sql`UPDATE kernel_agent_runs SET state = ${state}, native_session_id = 'child-thread' WHERE run_id = 'child'`
        yield* subscriptions.reconcile()
        yield* subscriptions.reconcile()
        const messages = yield* store.pending()
        expect(messages).toHaveLength(1)
        expect(messages[0]?.prompt).toContain(`"status":"${state}"`)
        expect(messages[0]?.prompt).toContain('"summaryPointer":"child-thread"')
        yield* store.uncertain(messages[0]!.id, "thread")
        expect(
          (yield* sql`SELECT state FROM resident_inbox WHERE thread_id IS NOT NULL`)[0]?.state,
        ).toBe("operator_required")
        yield* subscriptions.reconcile()
        expect(yield* store.pending()).toHaveLength(0)
      }).pipe(Effect.provide(layer)),
    ))
}

test("a wake turn cannot finish a worker with another outstanding subscription", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeResidentStore
      const subscriptions = yield* makeSubscriptions
      yield* store.attach("parent", "thread", "/work", null)
      yield* store.started("thread", "turn")
      yield* subscriptions.register("thread", { kind: "ci", ...target })
      yield* subscriptions.register("thread", { kind: "agent_run", run_id: "child" })
      expect(yield* store.completed("thread", "turn")).toBe("waiting")
      yield* store.started("thread", "wake-turn")
      expect(yield* store.completed("thread", "wake-turn")).toBe("waiting")
      expect((yield* store.read("thread"))?.state).toBe("waiting")
    }).pipe(Effect.provide(layer)),
  ))

test("terminal result for a gone mailbox requires an operator and never queues a retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeResidentStore
      const subscriptions = yield* makeSubscriptions
      const ci = yield* CiService
      const sql = yield* SqlClient.SqlClient
      yield* store.attach("parent", "thread", "/work", null)
      yield* store.started("thread", "turn")
      yield* ci.watch(target, 1, ["CI"], Date.now())
      yield* subscriptions.register("thread", { kind: "ci", ...target })
      yield* sql`UPDATE resident_threads SET state = 'finished' WHERE thread_id = 'thread'`
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
      expect(
        (yield* sql`SELECT state FROM resident_inbox WHERE thread_id IS NOT NULL`)[0]?.state,
      ).toBe("operator_required")
      expect(yield* store.pending()).toHaveLength(0)
    }).pipe(Effect.provide(layer)),
  ))

test("a never-final run keeps its subscription visible and pending without delivery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeResidentStore
      const subscriptions = yield* makeSubscriptions
      const sql = yield* SqlClient.SqlClient
      const runs = yield* AgentRunStore
      yield* store.attach("parent", "thread", "/work", null)
      yield* store.started("thread", "turn")
      yield* runs.create({
        runId: "child",
        route: "test",
        providerId: "codex-cli",
        modelId: "m",
        agent: "build",
        repository: "o/r",
        directory: "/child",
        prompt: "task",
        promptSha256: "a".repeat(64),
        parentSessionId: null,
        resumePrompt: null,
        maxAttempts: 1,
        createdAt: new Date(),
      })
      const receipt = yield* subscriptions.register("thread", {
        kind: "agent_run",
        run_id: "child",
      })
      expect(yield* store.completed("thread", "turn")).toBe("waiting")
      for (let pass = 0; pass < 3; pass++) yield* subscriptions.reconcile()
      expect(yield* store.deliveryState(receipt.id)).toBe("pending")
      expect(yield* store.threads()).toMatchObject([{ thread_id: "thread", state: "waiting" }])
      expect(yield* sql`SELECT state FROM kernel_waits WHERE wait_id = ${receipt.id}`).toEqual([
        { state: "pending" },
      ])
      expect(yield* sql`SELECT * FROM resident_inbox WHERE thread_id IS NOT NULL`).toHaveLength(0)
      expect(yield* store.pending()).toHaveLength(0)
    }).pipe(Effect.provide(layer)),
  ))

test("CI deadline expires once and ignores a later real result", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeResidentStore
      const subscriptions = yield* makeSubscriptions
      const ci = yield* CiService
      const sql = yield* SqlClient.SqlClient
      const runs = yield* AgentRunStore
      yield* runs.create({
        runId: "parent",
        route: "test",
        providerId: "codex-cli",
        modelId: "m",
        agent: "build",
        repository: "o/r",
        directory: "/work",
        prompt: "task",
        promptSha256: "a".repeat(64),
        parentSessionId: null,
        resumePrompt: null,
        maxAttempts: 1,
        createdAt: new Date(),
      })
      const sessions = yield* KernelSessionStore
      const now = new Date()
      yield* sessions.registerResource({
        resourceId: "resource",
        owningHostId: "host",
        absolutePath: "/work",
        kind: "worktree",
        createdAt: now,
      })
      yield* sessions.registerSession({
        sessionId: "session",
        providerKind: "codex",
        providerVersion: 1,
        providerId: "codex-cli",
        serverId: "host",
        owningHostId: "host",
        endpointAlias: "local-cli",
        endpointIdentity: "codex-cli://host",
        nativeSessionId: "thread",
        resourceId: "resource",
        createdAt: now,
      })
      yield* sql`UPDATE kernel_agent_runs SET state = 'verified', session_id = 'session', resource_id = 'resource', native_session_id = 'thread' WHERE run_id = 'parent'`
      yield* store.attach("parent", "thread", "/work", null)
      yield* store.started("thread", "turn")
      yield* ci.watch(target, 1, ["CI"], Date.now())
      const receipt = yield* subscriptions.register("thread", { kind: "ci", ...target })
      const thread = yield* store.read("thread")
      expect(thread?.wait_deadline).toBeGreaterThan(Date.now())
      expect(thread!.wait_deadline! - Date.now()).toBeLessThanOrEqual(86_400_000)
      yield* subscriptions.register("thread", { kind: "ci", ...target })
      expect((yield* store.read("thread"))?.wait_deadline).toBe(thread?.wait_deadline)
      yield* sql`UPDATE kernel_workflow_instances SET payload_json = json_set(payload_json, '$.deadline', 0) WHERE instance_id = ${receipt.id}`
      yield* subscriptions.reconcile()
      yield* subscriptions.reconcile()
      expect(yield* sql`SELECT prompt, state FROM resident_inbox WHERE id = ${receipt.id}`).toEqual(
        [
          {
            prompt: expect.stringContaining("CI result did not arrive in time"),
            state: "operator_required",
          },
        ],
      )
      expect((yield* store.read("thread"))?.state).toBe("operator_required")
      expect((yield* runs.read("parent"))?.state).toBe("operator_required")
      expect(yield* sql`SELECT state FROM kernel_waits WHERE wait_id = ${receipt.id}`).toEqual([
        { state: "consumed" },
      ])
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
      expect(yield* sql`SELECT * FROM resident_inbox WHERE thread_id IS NOT NULL`).toHaveLength(1)
      expect(yield* store.deliveryState(receipt.id)).toBe("operator_required")
    }).pipe(Effect.provide(layer)),
  ))

test("configured CI deadline backfills old waits without extending them", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeResidentStore
      const subscriptions = yield* makeSubscriptions
      const sql = yield* SqlClient.SqlClient
      yield* store.attach("parent", "thread", "/work", null)
      yield* store.started("thread", "turn")
      const before = Date.now()
      yield* subscriptions.register("thread", { kind: "ci", ...target })
      expect((yield* store.read("thread"))?.wait_deadline).toBeGreaterThanOrEqual(before + 60_000)
      expect((yield* store.read("thread"))!.wait_deadline! - Date.now()).toBeLessThanOrEqual(60_000)
      yield* sql`UPDATE kernel_workflow_instances SET payload_json = json_remove(payload_json, '$.deadline')`
      yield* sql`UPDATE kernel_workflow_instances SET created_at = '2000-01-01T00:00:00.000Z'`
      yield* subscriptions.reconcile()
      expect((yield* store.read("thread"))?.state).toBe("operator_required")
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ WORKFLOWD_CI_WAIT_TIMEOUT_MS: "60000" }),
      ),
    ),
  ))

test("CI subscriptions on one thread expire independently from their registration times", async () => {
  let now = Date.now()
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeResidentStore
        const subscriptions = yield* makeSubscriptions
        const sql = yield* SqlClient.SqlClient
        yield* store.attach("parent", "thread", "/work", null)
        yield* store.started("thread", "turn")
        const first = yield* subscriptions.register("thread", { kind: "ci", ...target })
        now += 30_000
        const second = yield* subscriptions.register("thread", {
          kind: "ci",
          repository: target.repository,
          sha: "b".repeat(40),
        })
        now += 30_001
        yield* subscriptions.reconcile()
        expect(yield* sql`SELECT state FROM kernel_waits WHERE wait_id = ${first.id}`).toEqual([
          { state: "consumed" },
        ])
        expect(yield* sql`SELECT state FROM kernel_waits WHERE wait_id = ${second.id}`).toEqual([
          { state: "pending" },
        ])
        expect(yield* sql`SELECT * FROM resident_inbox WHERE id = ${second.id}`).toHaveLength(0)
        // Reconstruct the reducer to verify deadlines survive restart and duplicate registration.
        const restarted = yield* makeSubscriptions
        expect((yield* restarted.register("thread", { kind: "ci", ...target })).status).toBe(
          "duplicate",
        )
        now += 30_000
        yield* restarted.reconcile()
        expect(yield* sql`SELECT state FROM kernel_waits WHERE wait_id = ${second.id}`).toEqual([
          { state: "consumed" },
        ])
        expect(yield* sql`SELECT id FROM resident_inbox`).toHaveLength(2)
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ WORKFLOWD_CI_WAIT_TIMEOUT_MS: "60000" }),
        ),
      ),
    )
  } finally {
    clock.mockRestore()
  }
})

for (const conclusion of ["success", "failure"] as const) {
  test(`final CI ${conclusion} wins when reconciliation runs after the deadline`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeResidentStore
        const subscriptions = yield* makeSubscriptions
        const ci = yield* CiService
        const sql = yield* SqlClient.SqlClient
        yield* store.attach("parent", "thread", "/work", null)
        yield* store.started("thread", "turn")
        yield* ci.watch(target, 1, ["CI"], Date.now())
        const receipt = yield* subscriptions.register("thread", { kind: "ci", ...target })
        yield* store.completed("thread", "turn")
        yield* sql`UPDATE kernel_workflow_instances SET payload_json = json_set(payload_json, '$.deadline', 0) WHERE instance_id = ${receipt.id}`
        yield* ci.snapshot(
          target,
          [
            {
              id: 42,
              name: "CI",
              attempt: 1,
              status: "completed",
              conclusion,
              failingJobs: conclusion === "failure" ? ["lint"] : [],
            },
          ],
          null,
          Date.now(),
        )
        yield* subscriptions.reconcile()
        yield* subscriptions.reconcile()
        const messages = yield* store.pending()
        expect(messages).toHaveLength(1)
        expect(messages[0]?.prompt).toContain(`"conclusion":"${conclusion}"`)
        expect(messages[0]?.prompt).not.toContain("did not arrive")
        expect((yield* store.read("thread"))?.state).toBe("waiting")
        expect(yield* sql`SELECT state FROM kernel_waits WHERE wait_id = ${receipt.id}`).toEqual([
          { state: "consumed" },
        ])
      }).pipe(Effect.provide(layer)),
    ))
}

const completionPayload = (prompt: string | undefined) => {
  const json = /^workflowd completion: (.*)\. Continue the task from this result\.$/s.exec(
    prompt ?? "",
  )?.[1]
  return Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  )(json)
}

for (const finalMessage of ["child summary", "x".repeat(70_000)]) {
  test(`agent run subscription carries the child's caller-mailbox message (${finalMessage.length} chars)`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeResidentStore
        const subscriptions = yield* makeSubscriptions
        const sql = yield* SqlClient.SqlClient
        const runs = yield* AgentRunStore
        yield* store.attach("parent", "thread", "/work", null)
        yield* store.started("thread", "turn")
        yield* runs.create({
          runId: "child",
          route: "test",
          providerId: "codex-cli",
          modelId: "m",
          agent: "build",
          repository: "o/r",
          directory: "/child",
          prompt: "task",
          promptSha256: "a".repeat(64),
          parentSessionId: null,
          resumePrompt: null,
          maxAttempts: 1,
          createdAt: new Date(),
        })
        yield* subscriptions.register("thread", { kind: "agent_run", run_id: "child" })
        yield* runs.fail({ runId: "child", now: new Date(), diagnostic: "boom", finalMessage })
        yield* subscriptions.reconcile()
        const [row] = yield* sql<{ prompt: string }>`SELECT prompt FROM resident_inbox
          WHERE id = 'agent-run-end-child'`
        const mailbox = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )(row?.prompt)
        const messages = yield* store.pending()
        expect(messages).toHaveLength(1)
        const payload = completionPayload(messages[0]?.prompt)
        expect(payload).toMatchObject({ kind: "agent_run", runId: "child", status: "failed" })
        expect(payload.terminal).toEqual(
          finalMessage.length < 1_000
            ? mailbox
            : { ...mailbox, final_message: null, final_message_ref: "child" },
        )
        expect(mailbox.final_message).toBe(finalMessage)
      }).pipe(Effect.provide(layer)),
    ))
}

test("agent run subscription without a caller-mailbox row carries a null terminal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* makeResidentStore
      const subscriptions = yield* makeSubscriptions
      const sql = yield* SqlClient.SqlClient
      const runs = yield* AgentRunStore
      yield* store.attach("parent", "thread", "/work", null)
      yield* store.started("thread", "turn")
      yield* runs.create({
        runId: "child",
        route: "test",
        providerId: "codex-cli",
        modelId: "m",
        agent: "build",
        repository: "o/r",
        directory: "/child",
        prompt: "task",
        promptSha256: "a".repeat(64),
        parentSessionId: null,
        resumePrompt: null,
        maxAttempts: 1,
        createdAt: new Date(),
      })
      yield* subscriptions.register("thread", { kind: "agent_run", run_id: "child" })
      yield* sql`UPDATE kernel_agent_runs SET state = 'completed' WHERE run_id = 'child'`
      yield* subscriptions.reconcile()
      const messages = yield* store.pending()
      expect(completionPayload(messages[0]?.prompt).terminal).toBeNull()
    }).pipe(Effect.provide(layer)),
  ))
