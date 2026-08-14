import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import {
  AgentHandoffStore,
  AgentHandoffStoreLive,
  recordAgentSessionCompletion,
} from "../../src/kernel/agent-handoff-store"
import { KernelEventStore, KernelEventStoreLive } from "../../src/kernel/event-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../src/store"

const at = new Date("2026-08-14T09:00:00.000Z")
const prompt = { task: "Resume once." }
const promptText = JSON.stringify(prompt)
const workflow = {
  kind: "wait_for_agent" as const,
  childSessionId: "child-stable",
  childSessionGeneration: 1,
  parentSessionId: "parent-stable",
  resumePrompt: prompt,
  resumePromptText: promptText,
  outputContract: "test.parent-result",
  outputContractVersion: 1,
  retryPolicy: { maxAttempts: 3 },
}

const layer = (() => {
  const database = SqliteClient.layer({ filename: ":memory:" })
  const bootstrap = WorkflowStoreLive.pipe(Layer.provideMerge(database))
  const events = KernelEventStoreLive.pipe(Layer.provideMerge(bootstrap))
  const sessions = KernelSessionStoreLive.pipe(Layer.provideMerge(bootstrap))
  const handoffs = AgentHandoffStoreLive.pipe(
    Layer.provideMerge(events),
    Layer.provideMerge(bootstrap),
  )
  return Layer.mergeAll(events, sessions, handoffs)
})()

const arrangeSessions = Effect.gen(function* () {
  const sessions = yield* KernelSessionStore
  for (const name of ["child", "parent"] as const) {
    yield* sessions.registerResource({
      resourceId: `${name}-resource`,
      owningHostId: "mint",
      absolutePath: `${process.cwd()}/${name}`,
      kind: "worktree",
      createdAt: at,
    })
    yield* sessions.registerSession({
      sessionId: `${name}-stable`,
      providerKind: "opencode",
      providerVersion: 1,
      providerId: "opencode-primary",
      serverId: "server-a",
      owningHostId: "mint",
      endpointAlias: "local",
      endpointIdentity: "http://127.0.0.1:4096",
      nativeSessionId: `ses_${name}`,
      resourceId: `${name}-resource`,
      createdAt: at,
    })
  }
})

const register = Effect.gen(function* () {
  const handoffs = yield* AgentHandoffStore
  return yield* handoffs.register({
    instanceId: "handoff-parent-child",
    waitId: "await-child",
    workflow,
    baseline: { version: 1, messageFingerprints: ["old-answer"] },
    registeredAt: at,
  })
})

describe("agent handoff registration", () => {
  test("atomically persists the neutral workflow, OpenCode custody baseline, and wait", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* arrangeSessions
        const registered = yield* register
        const rows = yield* sql<
          Record<string, unknown>
        >`SELECT * FROM kernel_agent_completion_watches`
        const instances = yield* sql<
          Record<string, unknown>
        >`SELECT * FROM kernel_workflow_instances`
        const waits = yield* sql<Record<string, unknown>>`SELECT * FROM kernel_waits`
        return { registered, rows, instances, waits }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.registered.status).toBe("registered")
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      child_session_id: "child-stable",
      provider_kind: "opencode",
      native_session_id: "ses_child",
      state: "watching",
    })
    expect(String(result.instances[0]!.payload_json)).not.toContain("ses_child")
    expect(result.waits).toHaveLength(1)
  })

  test("rejects replay that changes the saved child-history baseline", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const handoffs = yield* AgentHandoffStore
        yield* arrangeSessions
        yield* register
        return yield* handoffs
          .register({
            instanceId: "handoff-parent-child",
            waitId: "await-child",
            workflow,
            baseline: { version: 1, messageFingerprints: ["different-answer"] },
            registeredAt: at,
          })
          .pipe(Effect.either)
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "AgentHandoffStoreError", operation: "validate saved watch replay" },
    })
  })

  test("rejects a resume prompt whose exact text does not match its payload", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const handoffs = yield* AgentHandoffStore
        return yield* handoffs
          .register({
            instanceId: "bad-prompt-handoff",
            waitId: "bad-prompt-wait",
            workflow: { ...workflow, resumePromptText: '{"task":"different"}' },
            baseline: { version: 1, messageFingerprints: [] },
            registeredAt: at,
          })
          .pipe(Effect.either)
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "AgentHandoffStoreError", operation: "validate exact resume prompt" },
    })
  })

  test("matches the same completion both before and after wait registration", async () => {
    for (const order of ["event-first", "wait-first"] as const) {
      const delivered = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* KernelEventStore
          const handoffs = yield* AgentHandoffStore
          yield* arrangeSessions
          if (order === "wait-first") yield* register
          if (order === "event-first") {
            yield* handoffs.prepare({
              instanceId: "handoff-parent-child",
              waitId: "await-child",
              workflow,
              registeredAt: at,
            })
          }
          yield* recordAgentSessionCompletion({
            source: "agent-provider:opencode-primary:server-a",
            sourceEventId: createHash("sha256").update(`${order}:message-7`).digest("hex"),
            childSessionId: "child-stable",
            childSessionGeneration: 1,
            completionId: "message-7",
            completedAt: at,
          })
          if (order === "event-first") yield* register
          return yield* events.readReadyDeliveries("handoff-parent-child")
        }).pipe(Effect.provide(layer)),
      )

      expect(delivered, order).toHaveLength(1)
      expect(delivered[0]!.event.payload).toMatchObject({ childSessionId: "child-stable" })
    }
  })

  test("delivers one child completion independently to every waiting parent", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* KernelSessionStore
        const handoffs = yield* AgentHandoffStore
        const events = yield* KernelEventStore
        yield* arrangeSessions
        yield* sessions.registerResource({
          resourceId: "parent-two-resource",
          owningHostId: "mint",
          absolutePath: `${process.cwd()}/test`,
          kind: "worktree",
          createdAt: at,
        })
        yield* sessions.registerSession({
          sessionId: "parent-two-stable",
          providerKind: "opencode",
          providerVersion: 1,
          providerId: "opencode-primary",
          serverId: "server-a",
          owningHostId: "mint",
          endpointAlias: "local",
          endpointIdentity: "http://127.0.0.1:4096",
          nativeSessionId: "ses_parent_two",
          resourceId: "parent-two-resource",
          createdAt: at,
        })
        yield* register
        yield* handoffs.register({
          instanceId: "handoff-parent-two-child",
          waitId: "await-child-two",
          workflow: { ...workflow, parentSessionId: "parent-two-stable" },
          baseline: { version: 1, messageFingerprints: [] },
          registeredAt: at,
        })
        yield* recordAgentSessionCompletion({
          source: "test-source",
          sourceEventId: "one-child-answer",
          childSessionId: "child-stable",
          childSessionGeneration: 1,
          completionId: "one-child-answer",
          completedAt: at,
        })
        return {
          first: yield* events.readReadyDeliveries("handoff-parent-child"),
          second: yield* events.readReadyDeliveries("handoff-parent-two-child"),
        }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.first).toHaveLength(1)
    expect(result.second).toHaveLength(1)
    expect(result.first[0]!.eventSequence).toBe(result.second[0]!.eventSequence)
  })
})
