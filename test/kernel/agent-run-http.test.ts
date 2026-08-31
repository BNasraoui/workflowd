import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Schema } from "effect"
import { routeRequest } from "../../src/http"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignalLive } from "../../src/work-signal"
import type { AgentRunReceipt } from "../../src/agent-run-contract"
import { AgentRunRefusalError, type AgentRunIngressPort } from "../../src/kernel/agent-run-ingress"
import { AgentRunStoreConflictError } from "../../src/kernel/agent-run-store"

const token = "agent-run-secret"
const now = new Date("2026-08-30T09:00:00.000Z")

const body = {
  route: "implement",
  repository: "workflowd",
  prompt: "Fix the flaky retry test and push the branch.",
}

const post = (input: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/workflows/agent-runs", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof input === "string" ? input : JSON.stringify(input),
  })

const authorization = { authorization: `Bearer ${token}` }

const ambient = Layer.merge(
  WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
  WorkSignalLive,
)

const route = (request: Request, register: AgentRunIngressPort["register"]) =>
  Effect.runPromise(
    routeRequest(request, {
      webhookSecret: "unused",
      now,
      agentRuns: { token, register },
    }).pipe(Effect.provide(ambient)),
  )

const receipt: AgentRunReceipt = {
  runId: "agent-run-abc",
  sessionId: "opencode-session-ses_child",
  nativeSessionId: "ses_child",
  providerId: "zai-coding-plan",
  modelId: "glm-5.3-flash",
  outputTokens: 7,
  status: "dispatched",
}

describe("POST /workflows/agent-runs", () => {
  test("accepts an authorized dispatch and returns the verified receipt", async () => {
    let seen: unknown
    const response = await route(post(body, authorization), (input, at) => {
      seen = { input, at }
      return Effect.succeed(receipt)
    })

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual(receipt)
    expect(seen).toEqual({ input: body, at: now })
  })

  test("refuses an unauthenticated request without consulting the ingress", async () => {
    let called = false
    const response = await route(post(body), () => {
      called = true
      return Effect.succeed(receipt)
    })

    expect(response.status).toBe(401)
    expect(called).toBe(false)
  })

  test("returns 404 when the endpoint is not enabled", async () => {
    const response = await Effect.runPromise(
      routeRequest(post(body, authorization), { webhookSecret: "unused", now }).pipe(
        Effect.provide(ambient),
      ),
    )

    expect(response.status).toBe(404)
  })

  test("rejects a malformed payload before touching the ingress", async () => {
    let called = false
    const response = await route(post({ route: "implement" }, authorization), () => {
      called = true
      return Effect.succeed(receipt)
    })

    expect(response.status).toBe(400)
    expect(called).toBe(false)
  })

  test("surfaces a refusal as 409 with the machine-readable reason", async () => {
    const response = await route(post(body, authorization), () =>
      Effect.fail(
        new AgentRunRefusalError({
          reason: "provider_not_authenticated",
          detail: "route implement resolves to provider zai-coding-plan, which has no credentials",
        }),
      ),
    )

    expect(response.status).toBe(409)
    const payload = Schema.decodeUnknownSync(
      Schema.Struct({ error: Schema.String, reason: Schema.String, detail: Schema.String }),
    )(await response.json())
    expect(payload.error).toBe("refused")
    expect(payload.reason).toBe("provider_not_authenticated")
    expect(payload.detail).toContain("zai-coding-plan")
  })

  test("surfaces run-identity conflicts as an opaque caller conflict", async () => {
    const response = await route(post(body, authorization), () =>
      Effect.fail(new AgentRunStoreConflictError({ runId: "agent-run-abc", detail: "secret" })),
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "conflict", reason: "idempotency_conflict" })
  })
})
