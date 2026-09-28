import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { CiService } from "../../src/ci/service"
import { makeCiStore } from "../../src/ci/store"
import { WorkflowStoreLive } from "../../src/store"
import { makeResidentStore } from "../../src/resident/store"
import { makeSubscriptions } from "../../src/resident/subscriptions"

const layer = Layer.mergeAll(
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
        const selector = { kind: "ci" as const, ...target }
        const receipt = yield* subscriptions.register("thread", selector)
        expect((yield* subscriptions.register("thread", selector)).id).toBe(receipt.id)
        expect(yield* store.completed("thread", "turn")).toBe("waiting")
        if (!alreadyFinished) {
          expect(yield* store.pending()).toHaveLength(0)
          yield* complete
        }
        yield* subscriptions.reconcile()
        const messages = yield* store.pending()
        expect(messages).toHaveLength(1)
        expect(messages[0]?.prompt).toContain('"failingJobs":["lint"]')
        expect(messages[0]?.prompt).toContain("https://github.com/o/r/actions/runs/42")
        yield* store.delivered(receipt.id)
        yield* complete
        yield* subscriptions.reconcile()
        yield* subscriptions.register("thread", selector)
        expect(yield* store.pending()).toHaveLength(0)
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT * FROM resident_inbox`).toHaveLength(1)
        expect((yield* sql`SELECT state FROM kernel_waits`)[0]?.state).toBe("consumed")
      }).pipe(Effect.provide(layer)),
    ))
}

test("agent run final state produces one mailbox message with a summary pointer", () =>
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
      yield* sql`UPDATE kernel_agent_runs SET state = 'completed', native_session_id = 'child-thread' WHERE run_id = 'child'`
      yield* subscriptions.reconcile()
      yield* subscriptions.reconcile()
      const messages = yield* store.pending()
      expect(messages).toHaveLength(1)
      expect(messages[0]?.prompt).toContain('"status":"completed"')
      expect(messages[0]?.prompt).toContain('"summaryPointer":"child-thread"')
      yield* store.uncertain(messages[0]!.id, "thread")
      expect((yield* sql`SELECT state FROM resident_inbox`)[0]?.state).toBe("operator_required")
      yield* subscriptions.reconcile()
      expect(yield* store.pending()).toHaveLength(0)
    }).pipe(Effect.provide(layer)),
  ))
