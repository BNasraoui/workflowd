import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Schema } from "effect"
import { routeRequest } from "../../src/http"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignalLive } from "../../src/work-signal"
import {
  AgentWaitCustodyError,
  type AgentWaitIngressPort,
  type AgentWaitReceipt,
} from "../../src/kernel/agent-wait-ingress"
import { KernelStoreConflictError } from "../../src/kernel/event-store"

const token = "agent-wait-secret"
const now = new Date("2026-08-14T09:00:00.000Z")

const body = {
  parentSessionId: "parent-stable",
  childSessionId: "child-stable",
  resumePrompt: "The child finished; read its result and continue.",
}

const post = (input: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/workflows/agent-waits", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof input === "string" ? input : JSON.stringify(input),
  })

const authorization = { authorization: `Bearer ${token}` }

// The route never touches the store or the signal hub, but routeRequest
// declares them, so they are provided rather than asserted away.
const ambient = Layer.merge(
  WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
  WorkSignalLive,
)

const route = (request: Request, register: AgentWaitIngressPort["register"]) =>
  Effect.runPromise(
    routeRequest(request, {
      webhookSecret: "unused",
      now,
      agentWaits: { token, register },
    }).pipe(Effect.provide(ambient)),
  )

const accepting =
  (receipt: AgentWaitReceipt): AgentWaitIngressPort["register"] =>
  () =>
    Effect.succeed(receipt)

const receipt: AgentWaitReceipt = {
  waitId: "agent-wait-abc",
  instanceId: "agent-wait-instance-abc",
  status: "registered",
}

describe("POST /workflows/agent-waits", () => {
  test("accepts an authorized registration and returns the receipt", async () => {
    let seen: unknown
    const response = await route(post(body, authorization), (input, at) => {
      seen = { input, at }
      return Effect.succeed(receipt)
    })

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual(receipt)
    expect(seen).toEqual({ input: body, at: now })
  })

  test("reports a duplicate registration as an accepted receipt", async () => {
    const response = await route(
      post({ ...body, idempotencyKey: "handoff-7" }, authorization),
      accepting({ ...receipt, status: "duplicate" }),
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ status: "duplicate" })
  })

  test("refuses an unauthenticated request without consulting the ingress", async () => {
    let called = false
    const response = await route(post(body), () => {
      called = true
      return Effect.succeed(receipt)
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "unauthorized" })
    expect(called).toBe(false)
  })

  test("refuses a wrong bearer token", async () => {
    const response = await route(
      post(body, { authorization: "Bearer not-the-token" }),
      accepting(receipt),
    )

    expect(response.status).toBe(401)
  })

  test("returns 404 when the endpoint is not enabled", async () => {
    const response = await Effect.runPromise(
      routeRequest(post(body, authorization), {
        webhookSecret: "unused",
        now,
      }).pipe(Effect.provide(ambient)),
    )

    expect(response.status).toBe(404)
  })

  test("rejects a malformed payload before touching the ingress", async () => {
    let called = false
    const response = await route(post({ parentSessionId: "only-one" }, authorization), () => {
      called = true
      return Effect.succeed(receipt)
    })

    expect(response.status).toBe(400)
    expect(called).toBe(false)
  })

  test("rejects invalid JSON", async () => {
    const response = await route(post("{not json", authorization), accepting(receipt))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid JSON" })
  })

  test("surfaces a custody refusal as 409 naming the missing custody", async () => {
    const response = await route(post(body, authorization), () =>
      Effect.fail(
        new AgentWaitCustodyError({
          role: "child",
          sessionId: "child-stable",
          reason: "not_in_kernel_custody",
          observed: null,
        }),
      ),
    )

    expect(response.status).toBe(409)
    const payload = Schema.decodeUnknownSync(
      Schema.Struct({
        error: Schema.String,
        reason: Schema.String,
        detail: Schema.String,
      }),
    )(await response.json())
    expect(payload.reason).toBe("not_in_kernel_custody")
    expect(payload.detail).toContain("child session child-stable")
    expect(payload.detail).toContain("kernel_sessions")
  })

  test("surfaces immutable idempotency conflicts as an opaque caller conflict", async () => {
    const response = await route(post(body, authorization), () =>
      Effect.fail(
        new KernelStoreConflictError({ record: "instance", key: "secret", instanceId: "secret" }),
      ),
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "conflict",
      reason: "idempotency_conflict",
    })
  })
})
