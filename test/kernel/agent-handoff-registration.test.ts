import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { SqlClient } from "effect/unstable/sql"
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
const completionSource = {
  owningHostId: "mint",
  providerId: "opencode-primary",
  serverId: "server-a",
  endpointAlias: "local",
  endpointIdentity: "http://127.0.0.1:4096",
  providerVersion: 1,
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
    completionSource,
    registeredAt: at,
  })
})

describe("agent handoff registration", () => {
  test("atomically persists the neutral workflow, completion watch, and wait", async () => {
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

  test("accepts an exact replay without recapturing mutable provider history", async () => {
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
            completionSource,
            registeredAt: at,
          })
          .pipe(Effect.result)
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toMatchObject({ right: { status: "duplicate" } })
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
            completionSource,
            registeredAt: at,
          })
          .pipe(Effect.result)
      }).pipe(Effect.provide(layer)),
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      left: { _tag: "AgentHandoffStoreError", operation: "validate exact resume prompt" },
    })
  })

  test("revalidates reserved resources and provider custody inside registration", async () => {
    for (const invalidation of [
      "child-resource",
      "parent-provider",
      "child-provider",
      "child-source",
    ] as const) {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const handoffs = yield* AgentHandoffStore
          yield* arrangeSessions
          if (invalidation === "child-resource") {
            yield* sql`UPDATE kernel_working_resources SET state = 'cleaned'
              WHERE resource_id = 'child-resource'`
          } else if (invalidation !== "child-source") {
            const sessionId = invalidation === "parent-provider" ? "parent-stable" : "child-stable"
            yield* sql`UPDATE kernel_sessions SET provider_kind = 'codex'
              WHERE session_id = ${sessionId}`
          } else {
            yield* sql`UPDATE kernel_sessions SET provider_id = 'different-source'
              WHERE session_id = 'child-stable'`
          }
          const attempted = yield* handoffs
            .register({
              instanceId: `invalid-${invalidation}`,
              waitId: `invalid-wait-${invalidation}`,
              workflow,
              completionSource,
              registeredAt: at,
            })
            .pipe(Effect.result)
          const instances = yield* sql`SELECT instance_id FROM kernel_workflow_instances
            WHERE instance_id = ${`invalid-${invalidation}`}`
          return { attempted, instances }
        }).pipe(Effect.provide(layer)),
      )
      expect(result.attempted._tag, invalidation).toBe("Failure")
      expect(result.instances, invalidation).toHaveLength(0)
    }
  })

  test("matches a completion after atomic wait registration", async () => {
    for (const order of ["wait-first"] as const) {
      const delivered = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* KernelEventStore
          yield* arrangeSessions
          yield* register
          yield* recordAgentSessionCompletion({
            source: "agent-provider:opencode-primary:server-a",
            sourceEventId: createHash("sha256").update(`${order}:message-7`).digest("hex"),
            childSessionId: "child-stable",
            childSessionGeneration: 1,
            completionId: "message-7",
            completedAt: at,
          })
          return yield* events.readReadyDeliveries("handoff-parent-child")
        }).pipe(Effect.provide(layer)),
      )

      expect(delivered, order).toHaveLength(1)
      expect(delivered[0]!.event.payload).toMatchObject({ childSessionId: "child-stable" })
    }
  })

  test("returns duplicate when an exact lost-ack retry arrives after child completion", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* arrangeSessions
        yield* register
        yield* recordAgentSessionCompletion({
          source: "test-source",
          sourceEventId: "completed-before-retry",
          childSessionId: "child-stable",
          childSessionGeneration: 1,
          completionId: "completed-before-retry",
          completedAt: new Date(at.getTime() + 1_000),
        })
        return yield* register
      }).pipe(Effect.provide(layer)),
    )

    expect(result.status).toBe("duplicate")
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
          completionSource,
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
