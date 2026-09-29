import { expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentRunIngress } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import type { CodexCliPort, CodexExecEvent } from "../../src/kernel/codex-session"
import { WorkspaceError } from "../../src/workspace/errors"
import {
  at,
  defaultState,
  makeCodexCli,
  makeLayer,
  makeProvider,
  refusalOf,
  register,
  worktrees,
} from "./agent-run-ingress-harness"

const waitForTerminal = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* AgentRunStore
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const run = yield* store.read(runId)
      if (run?.state === "completed") return run
      yield* Effect.sleep(5)
    }
    return yield* store.read(runId)
  })

test("an unavailable user systemd manager is a typed Codex-only refusal", async () => {
  const unavailable = makeCodexCli([], 0, {
    kind: "systemd_unavailable",
    detail: "user manager did not answer",
  })
  const layer = makeLayer(makeProvider(defaultState()), worktrees([]), unavailable.port)
  const refusal = await refusalOf(
    Effect.runPromise(
      register({ route: "scan", repository: "workflowd", prompt: "x" }).pipe(Effect.provide(layer)),
    ),
  )
  expect(refusal.reason).toBe("systemd_unavailable")
  expect(unavailable.state.spawned).toHaveLength(0)
})

test("a failed transient launch removes its row so an identical retry can succeed", async () => {
  const healthy = makeCodexCli([
    { type: "agent_message", text: "recovered" },
    { type: "turn.completed", outputTokens: 2 },
  ])
  let attempts = 0
  const codex: CodexCliPort = {
    ...healthy.port,
    spawn: (input) => {
      attempts += 1
      return attempts === 1
        ? Effect.fail(
            new WorkspaceError({
              operation: "launch codex transient unit",
              cause: new Error("systemd-run failed"),
            }),
          )
        : healthy.port.spawn(input)
    },
  }
  const layer = makeLayer(makeProvider(defaultState()), worktrees([]), codex)
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* register({
        route: "scan",
        repository: "workflowd",
        prompt: "retry me",
        idempotencyKey: "launch-retry",
      }).pipe(Effect.result)
      const second = yield* register({
        route: "scan",
        repository: "workflowd",
        prompt: "retry me",
        idempotencyKey: "launch-retry",
      })
      return { first, second, row: yield* waitForTerminal(second.runId) }
    }).pipe(Effect.provide(layer)),
  )
  expect(result.first._tag).toBe("Failure")
  expect(result.second.status).toBe("dispatched")
  expect(result.row?.state).toBe("completed")
  expect(attempts).toBe(2)
})

test("explicit Codex cancellation records cancelled only after the owned unit stops", async () => {
  let stopped = false
  const events: AsyncIterable<CodexExecEvent> = {
    async *[Symbol.asyncIterator]() {
      yield { type: "thread.started", threadId: "cancel-thread" }
      yield { type: "agent_message", text: "started" }
      await new Promise(() => {})
    },
  }
  const layer = makeLayer(makeProvider(defaultState()), worktrees([]), {
    ownership: "transient-exec",
    preflight: Effect.void,
    spawn: () =>
      Effect.succeed({
        executionId: "owned.service",
        events,
        exited: Effect.never,
        cancel: Effect.sync(() => {
          stopped = true
        }),
      }),
    attach: () =>
      Effect.succeed({
        executionId: "owned.service",
        events,
        exited: Effect.never,
        cancel: Effect.sync(() => {
          stopped = true
        }),
      }),
  })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const ingress = yield* AgentRunIngress
      const receipt = yield* ingress.register(
        { route: "scan", repository: "workflowd", prompt: "cancel me" },
        at,
      )
      yield* ingress.cancel(receipt.runId, at)
      const store = yield* AgentRunStore
      return yield* store.read(receipt.runId)
    }).pipe(Effect.provide(layer)),
  )
  expect(stopped).toBe(true)
  expect(result?.state).toBe("cancelled")
})
