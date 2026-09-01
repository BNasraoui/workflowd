import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlError } from "effect/unstable/sql"
import { Effect, Layer } from "effect"
import { routeRequest } from "../../src/http"
import {
  AGENT_RUNS_ENRICHMENT_CONTRACT,
  type AgentRunEnrichment,
  type AgentRunsEnrichmentDocument,
  type AgentRunsEnrichmentStorePort,
} from "../../src/kernel/agent-runs-enrichment-store"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignalLive } from "../../src/work-signal"

const token = "agent-runs-secret"
const now = new Date("2026-08-30T09:00:00.000Z")

// A run-less session omits the run fields; the type itself keeps them optional.
const idle: AgentRunEnrichment = {}

const document: AgentRunsEnrichmentDocument = {
  contract: AGENT_RUNS_ENRICHMENT_CONTRACT,
  sessions: { ses_idle: idle },
}

const get = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/workflows/agent-runs", { method: "GET", headers })

const ambient = Layer.merge(
  WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
  WorkSignalLive,
)

const route = (request: Request, sessions: AgentRunsEnrichmentStorePort["sessions"]) =>
  Effect.runPromise(
    routeRequest(request, {
      webhookSecret: "unused",
      now,
      agentRunsEnrichment: { token, sessions },
    }).pipe(Effect.provide(ambient)),
  )

describe("GET /workflows/agent-runs", () => {
  test("serves the enrichment document to an authorized reader", async () => {
    let called = 0
    const response = await route(get({ authorization: `Bearer ${token}` }), () => {
      called += 1
      return Effect.succeed(document)
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(document)
    expect(called).toBe(1)
  })

  test("rejects a missing or wrong bearer token without consulting the store", async () => {
    let called = 0
    const sessions: AgentRunsEnrichmentStorePort["sessions"] = () => {
      called += 1
      return Effect.succeed(document)
    }
    const missing = await route(get(), sessions)
    const wrong = await route(get({ authorization: "Bearer nope" }), sessions)

    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(called).toBe(0)
  })

  test("keeps the route absent when agent-runs enrichment is not configured", async () => {
    const response = await Effect.runPromise(
      routeRequest(get({ authorization: `Bearer ${token}` }), {
        webhookSecret: "unused",
        now,
      }).pipe(Effect.provide(ambient)),
    )

    expect(response.status).toBe(404)
  })

  test("surfaces store failures as an opaque 500", async () => {
    const response = await route(get({ authorization: `Bearer ${token}` }), () =>
      Effect.fail(
        new SqlError.SqlError({
          reason: new SqlError.ConnectionError({ cause: new Error("database is locked") }),
        }),
      ),
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "internal server error" })
  })
})
