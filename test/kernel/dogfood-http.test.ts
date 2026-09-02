import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlError } from "effect/unstable/sql"
import { Effect, Layer } from "effect"
import { routeRequest } from "../../src/http"
import {
  DOGFOOD_ENRICHMENT_CONTRACT,
  type DogfoodEnrichmentDocument,
  type DogfoodSessionEnrichment,
  type DogfoodStorePort,
} from "../../src/kernel/dogfood-store"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignalLive } from "../../src/work-signal"
import { enrichmentHttpSuite } from "./enrichment-http-suite"

const token = "dogfood-secret"
const now = new Date("2026-08-30T09:00:00.000Z")

// A run-less session omits the run fields; the type itself keeps them optional.
const idle: DogfoodSessionEnrichment = {
  harness: "opencode",
  harness_version: 1,
  machine: "mint",
}

const document: DogfoodEnrichmentDocument = {
  contract: DOGFOOD_ENRICHMENT_CONTRACT,
  sessions: { ses_idle: idle },
}

const get = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/workflows/dogfood/sessions", { method: "GET", headers })

const ambient = Layer.merge(
  WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
  WorkSignalLive,
)

const route = (request: Request, sessions: DogfoodStorePort["sessions"]) =>
  Effect.runPromise(
    routeRequest(request, { webhookSecret: "unused", now, dogfood: { token, sessions } }).pipe(
      Effect.provide(ambient),
    ),
  )

const routeWithoutBinding = (request: Request) =>
  Effect.runPromise(
    routeRequest(request, { webhookSecret: "unused", now }).pipe(Effect.provide(ambient)),
  )

// Store faults reach the route as the plain SQL failure the store surfaces.
const storeFailure: DogfoodStorePort["sessions"] = () =>
  Effect.fail(
    new SqlError.SqlError({
      reason: new SqlError.ConnectionError({ cause: new Error("database is locked") }),
    }),
  )

enrichmentHttpSuite({
  title: "GET /workflows/dogfood/sessions",
  token,
  document,
  get,
  route,
  routeWithoutBinding,
  storeFailure,
})
