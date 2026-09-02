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
import { enrichmentHttpSuite } from "./enrichment-http-suite"

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

const routeWithoutBinding = (request: Request) =>
  Effect.runPromise(
    routeRequest(request, { webhookSecret: "unused", now }).pipe(Effect.provide(ambient)),
  )

// Store faults reach the route as the plain SQL failure the store surfaces.
const storeFailure: AgentRunsEnrichmentStorePort["sessions"] = () =>
  Effect.fail(
    new SqlError.SqlError({
      reason: new SqlError.ConnectionError({ cause: new Error("database is locked") }),
    }),
  )

enrichmentHttpSuite({
  title: "GET /workflows/agent-runs",
  token,
  document,
  get,
  route,
  routeWithoutBinding,
  storeFailure,
})
