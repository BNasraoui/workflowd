import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { McpQueries, McpQueriesLive } from "../../src/mcp/queries"
import { KernelJobStoreLive } from "../../src/kernel/job-store"
import {
  at,
  defaultState,
  makeLayer,
  makeProvider,
  register,
  submission,
  worktrees,
} from "./agent-run-ingress-harness"

test("dispatch preserves the original idempotency key in the durable run summary", async () => {
  const layer = McpQueriesLive.pipe(
    Layer.provide(KernelJobStoreLive),
    Layer.provideMerge(makeLayer(makeProvider(defaultState()), worktrees([]))),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* register({ ...submission, idempotencyKey: "rpi-ticket-questions-1" })
      yield* register({ ...submission, idempotencyKey: "rpi-ticket-questions-1" })
      const queries = yield* McpQueries
      const runs = yield* queries.listAgentRuns({ limit: 20 })
      return { first, runs }
    }).pipe(Effect.provide(layer)),
  )
  expect(result.runs).toHaveLength(1)
  expect(result.runs[0]).toMatchObject({
    run_id: result.first.runId,
    idempotency_key: "rpi-ticket-questions-1",
    started_at: at.toISOString(),
    status: "verified",
    ended_at: null,
  })
})
