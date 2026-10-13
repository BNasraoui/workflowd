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

test("an uncertain transient launch retains its row and fences an identical retry", async () => {
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
      }).pipe(Effect.result)
      const store = yield* AgentRunStore
      const rows = yield* store.listActiveByExecutor("codex")
      return { first, second, rows }
    }).pipe(Effect.provide(layer)),
  )
  expect(result.first._tag).toBe("Failure")
  expect(result.second._tag).toBe("Failure")
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0]?.state).toBe("spawning")
  expect(attempts).toBe(1)
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

test("a Codex route using the CLI default model persists a valid run", async () => {
  const codex = makeCodexCli([
    { type: "agent_message", text: "default model" },
    { type: "turn.completed", outputTokens: 2 },
  ])
  const layer = makeLayer(makeProvider(defaultState()), worktrees([]), codex.port, {
    codexRoutes: [{ name: "scan", modelID: null }],
  })
  const receipt = await Effect.runPromise(
    register({ route: "scan", repository: "workflowd", prompt: "default" }).pipe(
      Effect.provide(layer),
    ),
  )
  expect(receipt.modelId).toBe("<cli-default>")
  expect(codex.state.spawned[0]?.model).toBeNull()
})

for (const message of [
  "HTTP 503: Selected model is at capacity. Please try a different model.",
  "HTTP 429: Rate limit exceeded. Please retry later.",
])
  test(`provider refusal retains its typed reason and message: ${message}`, async () => {
    const codex = makeCodexCli([{ type: "turn.failed", message }], 1)
    const layer = makeLayer(makeProvider(defaultState()), worktrees([]), codex.port)
    const refusal = await refusalOf(
      Effect.runPromise(
        register({ route: "scan", repository: "workflowd", prompt: "x" }).pipe(
          Effect.provide(layer),
        ),
      ),
    )
    expect(refusal.reason).toBe(
      message.startsWith("HTTP 503") ? "model_at_capacity" : "provider_rate_limited",
    )
    expect(refusal.detail).toBe(message)
  })

test("one-shot terminal mailbox preserves the provider error after model output", async () => {
  const { SqlClient } = await import("effect/unstable/sql")
  const { Schedule } = await import("effect")
  const message = "Try later.\nAuthorization: Bearer sk-private-token\n" + "😀".repeat(1000)
  const codex = makeCodexCli(
    [
      { type: "agent_message", text: "Working..." },
      { type: "turn.failed", message, codexErrorInfo: "serverOverloaded" },
    ],
    1,
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const receipt = yield* register({ route: "scan", repository: "workflowd", prompt: "x" })
      const store = yield* AgentRunStore
      const run = yield* store.read(receipt.runId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced(10),
          until: (run) => run?.state === "operator_required",
        }),
        Effect.timeout(2000),
      )
      expect(run?.diagnostic).toStartWith("model_at_capacity: Try later.")
      expect(run?.diagnostic).not.toContain("sk-private-token")
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{
        prompt: string
      }>`SELECT prompt FROM resident_inbox WHERE id = ${"agent-run-end-" + receipt.runId}`
      const finalMessage = JSON.parse(rows[0]!.prompt).final_message
      expect(finalMessage).toStartWith("Try later.")
      expect(finalMessage).not.toContain("sk-private-token")
      expect(Buffer.byteLength(JSON.stringify(finalMessage)) - 2).toBeLessThanOrEqual(512)
    }).pipe(Effect.provide(makeLayer(makeProvider(defaultState()), worktrees([]), codex.port))),
  )
})

for (const output of [false, true])
  test(`stderr cannot become a provider final message: output=${output}`, async () => {
    const codex = makeCodexCli(
      output ? [{ type: "agent_message", text: "Working..." }] : [],
      1,
      undefined,
      undefined,
      "HTTP 429 Authorization: Bearer sk-stderr-private",
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* register({
          route: "scan",
          repository: "workflowd",
          prompt: "stderr",
        }).pipe(Effect.result)
        if (!output) {
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure")
            expect(result.failure).toMatchObject({ reason: "no_first_token" })
        }
        const store = yield* AgentRunStore
        const { SqlClient } = yield* Effect.promise(() => import("effect/unstable/sql"))
        const { Schedule } = yield* Effect.promise(() => import("effect"))
        if (result._tag === "Success")
          yield* store
            .read(result.success.runId)
            .pipe(
              Effect.repeat({
                schedule: Schedule.spaced(10),
                until: (run) => run?.state === "operator_required",
              }),
              Effect.timeout(2000),
            )
        const rows = yield* SqlClient.SqlClient.pipe(
          Effect.flatMap(
            (sql) =>
              sql<{
                prompt: string
              }>`SELECT prompt FROM resident_inbox WHERE id LIKE 'agent-run-end-%'`,
          ),
        )
        expect(rows).toHaveLength(1)
        expect(JSON.parse(rows[0]!.prompt).final_message).toBe(output ? "Working..." : null)
      }).pipe(Effect.provide(makeLayer(makeProvider(defaultState()), worktrees([]), codex.port))),
    )
  })
