import { describe, expect, test } from "bun:test"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { AgentHandoffStoreLive } from "../../src/kernel/agent-handoff-store"
import {
  AgentWaitCustodyError,
  AgentWaitIngress,
  AgentWaitIngressLive,
  agentWakePrompt,
} from "../../src/kernel/agent-wait-ingress"
import { KernelEventStoreLive, KernelStoreConflictError } from "../../src/kernel/event-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignal, type WorkSignalPort } from "../../src/work-signal"

const at = new Date("2026-08-14T09:00:00.000Z")

const options = {
  owningHostId: "mint",
  providerId: "opencode-primary",
  serverId: "server-a",
  endpointAlias: "local",
  endpointIdentity: "http://127.0.0.1:4096",
  providerVersion: 1,
}

const signals: WorkSignalPort = {
  subscribe: () => Effect.die(new Error("unused")),
  wake: () => Effect.void,
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
  const stores = Layer.mergeAll(events, sessions, handoffs)
  return AgentWaitIngressLive(options).pipe(
    Layer.provideMerge(stores),
    Layer.provideMerge(Layer.succeed(WorkSignal, signals)),
  )
})()

const enterCustody = Effect.gen(function* () {
  const sessions = yield* KernelSessionStore
  for (const name of ["child", "parent"] as const) {
    yield* sessions.registerResource({
      resourceId: `${name}-resource`,
      owningHostId: "mint",
      absolutePath: name === "child" ? process.cwd() : `${process.cwd()}/src`,
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

const submission = {
  parentSessionId: "parent-stable",
  childSessionId: "child-stable",
  resumePrompt: "The child finished; read its result and continue.",
}

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

const custodyFailure = (error: unknown): AgentWaitCustodyError => {
  if (error instanceof AgentWaitCustodyError) return error
  throw new Error(`expected an AgentWaitCustodyError, got ${String(error)}`)
}

describe("agent wait ingress", () => {
  test("registers a durable watch and returns a receipt naming the wait", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* enterCustody
        const ingress = yield* AgentWaitIngress
        const receipt = yield* ingress.register(submission, at)
        const sql = yield* SqlClient.SqlClient
        const watches = yield* sql<{
          readonly instance_id: string
          readonly child_session_id: string
          readonly state: string
        }>`SELECT instance_id, child_session_id, state
          FROM kernel_agent_completion_watches`
        const instances = yield* sql<{
          readonly workflow_key: string
          readonly payload_json: string
        }>`SELECT workflow_key, payload_json FROM kernel_workflow_instances`
        return { receipt, watches, instances }
      }),
    )

    expect(result.receipt.status).toBe("registered")
    expect(result.receipt.waitId).toStartWith("agent-wait-")
    expect(result.watches).toHaveLength(1)
    expect(result.watches[0]!.child_session_id).toBe("child-stable")
    expect(result.watches[0]!.state).toBe("watching")
    expect(result.watches[0]!.instance_id).toBe(result.receipt.instanceId)
    // The workflow instance is keyed parent:child, and the parent is prompted
    // with the canonical JSON document, not a bare quoted string.
    expect(result.instances[0]!.workflow_key).toBe("parent-stable:child-stable")
    expect(JSON.parse(result.instances[0]!.payload_json).resumePromptText).toBe(
      '{"task":"The child finished; read its result and continue."}',
    )
  })

  test("re-registering the same handoff returns the existing watch without forking it", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* enterCustody
        const ingress = yield* AgentWaitIngress
        const first = yield* ingress.register(submission, at)
        const second = yield* ingress.register(submission, at)
        const sql = yield* SqlClient.SqlClient
        const watches = yield* sql`SELECT instance_id FROM kernel_agent_completion_watches`
        return { first, second, watchCount: watches.length }
      }),
    )

    expect(result.first.status).toBe("registered")
    expect(result.second.status).toBe("duplicate")
    expect(result.second.instanceId).toBe(result.first.instanceId)
    expect(result.second.waitId).toBe(result.first.waitId)
    expect(result.watchCount).toBe(1)
  })

  test("an explicit idempotency key pins the wait identity across replays", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* enterCustody
        const ingress = yield* AgentWaitIngress
        const keyed = { ...submission, idempotencyKey: "handoff-7" }
        const first = yield* ingress.register(keyed, at)
        const second = yield* ingress.register(keyed, at)
        const derived = yield* ingress.register(submission, at)
        return { first, second, derived }
      }),
    )

    expect(result.first.status).toBe("registered")
    expect(result.second.status).toBe("duplicate")
    expect(result.second.instanceId).toBe(result.first.instanceId)
    // A supplied key replaces the derived identity rather than adding to it.
    expect(result.derived.instanceId).not.toBe(result.first.instanceId)
  })

  test("reusing an idempotency key with a different prompt is refused, not silently rewritten", async () => {
    const failure = await run(
      Effect.gen(function* () {
        yield* enterCustody
        const ingress = yield* AgentWaitIngress
        yield* ingress.register({ ...submission, idempotencyKey: "handoff-7" }, at)
        return yield* ingress
          .register(
            { ...submission, resumePrompt: "different text", idempotencyKey: "handoff-7" },
            at,
          )
          .pipe(Effect.flip)
      }),
    )

    // The workflow instance payload is immutable, so the store refuses the
    // conflicting replay instead of overwriting the recorded prompt.
    expect(failure).toBeInstanceOf(KernelStoreConflictError)
  })

  test("generation changes conflict for a keyed retry but create a new unkeyed wait", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* enterCustody
        const ingress = yield* AgentWaitIngress
        const keyed = yield* ingress.register({ ...submission, idempotencyKey: "handoff-7" }, at)
        const unkeyed = yield* ingress.register(submission, at)
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE kernel_sessions SET revision = 2 WHERE session_id = 'child-stable'`
        const keyedRetry = yield* ingress
          .register({ ...submission, idempotencyKey: "handoff-7" }, at)
          .pipe(Effect.result)
        const nextGeneration = yield* ingress.register(submission, at)
        return { keyed, unkeyed, keyedRetry, nextGeneration }
      }),
    )

    expect(result.keyedRetry._tag).toBe("Failure")
    if (result.keyedRetry._tag === "Failure") {
      expect(result.keyedRetry.failure).toBeInstanceOf(KernelStoreConflictError)
    }
    expect(result.nextGeneration.status).toBe("registered")
    expect(result.nextGeneration.instanceId).not.toBe(result.unkeyed.instanceId)
    expect(result.nextGeneration.instanceId).not.toBe(result.keyed.instanceId)
  })

  test("refuses a child that is not in kernel custody and names the missing custody", async () => {
    const failure = await run(
      Effect.gen(function* () {
        yield* enterCustody
        const ingress = yield* AgentWaitIngress
        return yield* ingress
          .register({ ...submission, childSessionId: "ghost-child" }, at)
          .pipe(Effect.flip)
      }),
    )

    const custody = custodyFailure(failure)
    expect(custody.role).toBe("child")
    expect(custody.sessionId).toBe("ghost-child")
    expect(custody.reason).toBe("not_in_kernel_custody")
    expect(custody.explanation).toContain("kernel_sessions")
    expect(custody.explanation).toContain("registerSession")
  })

  test("refuses a parent that is not in kernel custody without writing a watch", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* enterCustody
        const ingress = yield* AgentWaitIngress
        const failure = yield* ingress
          .register({ ...submission, parentSessionId: "ghost-parent" }, at)
          .pipe(Effect.flip)
        const sql = yield* SqlClient.SqlClient
        const watches = yield* sql`SELECT instance_id FROM kernel_agent_completion_watches`
        const instances = yield* sql`SELECT instance_id FROM kernel_workflow_instances`
        return { failure, watchCount: watches.length, instanceCount: instances.length }
      }),
    )

    expect(custodyFailure(result.failure).role).toBe("parent")
    // Fail closed: custody is checked before anything durable is written.
    expect(result.watchCount).toBe(0)
    expect(result.instanceCount).toBe(0)
  })

  test("refuses a session whose custody state is not ready or active", async () => {
    const failure = await run(
      Effect.gen(function* () {
        yield* enterCustody
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE kernel_sessions SET state = 'missing' WHERE session_id = 'child-stable'`
        const ingress = yield* AgentWaitIngress
        return yield* ingress.register(submission, at).pipe(Effect.flip)
      }),
    )

    expect(custodyFailure(failure).reason).toBe("session_not_ready")
    expect(custodyFailure(failure).explanation).toContain("'missing'")
  })
})

describe("agent wake prompt", () => {
  test("wraps the caller's text so the parent receives no stray quote artifacts", () => {
    const wrapped = agentWakePrompt('say "hello"')

    expect(wrapped.resumePrompt).toEqual({ task: 'say "hello"' })
    expect(wrapped.resumePromptText).toBe('{"task":"say \\"hello\\""}')
    expect(JSON.parse(wrapped.resumePromptText).task).toBe('say "hello"')
  })
})
