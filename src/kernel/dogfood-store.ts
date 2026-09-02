import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { enrichmentDocument, omitNull, type EnrichmentDocument } from "./enrichment-read-model"

/**
 * Read-only provenance dogfood enrichment.
 *
 * The provenance CLI's `dogfood report` collects agent pain-point notes that
 * carry only a harness-native session id; this store is workflowd's session
 * ground truth those notes join against. Provenance never depends on
 * workflowd — the only coupling is the `provenance-dogfood-enrichment/v1`
 * JSON document produced here and served at GET /workflows/dogfood/sessions.
 *
 * Field names are snake_case on purpose: they are the contract's JSON keys,
 * serialized verbatim, so consumers pass values through untouched.
 */
export const DOGFOOD_ENRICHMENT_CONTRACT = "provenance-dogfood-enrichment/v1"

export type DogfoodSessionEnrichment = {
  readonly harness: string
  readonly harness_version: number
  readonly machine: string
  readonly model?: string
  readonly agent?: string
  readonly repository?: string
}

export type DogfoodEnrichmentDocument = EnrichmentDocument<
  DogfoodSessionEnrichment,
  typeof DOGFOOD_ENRICHMENT_CONTRACT
>

export class DogfoodStoreDataError extends Data.TaggedError("DogfoodStoreDataError")<{
  readonly message: string
}> {}

export type DogfoodStoreError = SqlError | DogfoodStoreDataError

export type DogfoodStorePort = {
  /** A fresh read-only snapshot; the query never writes to the store. */
  readonly sessions: () => Effect.Effect<DogfoodEnrichmentDocument, DogfoodStoreError>
}

export const DogfoodStore = Context.Service<DogfoodStorePort>("workflowd/kernel/DogfoodStore")

const EnrichmentRow = Schema.Struct({
  native_session_id: Schema.String,
  harness: Schema.String,
  harness_version: Schema.Int,
  machine: Schema.String,
  model: Schema.NullOr(Schema.String),
  agent: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
})

/** A session with no agent run omits the run fields — never emits nulls. */
const toEnrichment = (row: Schema.Schema.Type<typeof EnrichmentRow>): DogfoodSessionEnrichment => ({
  harness: row.harness,
  harness_version: row.harness_version,
  machine: row.machine,
  ...omitNull("model", row.model),
  ...omitNull("agent", row.agent),
  ...omitNull("repository", row.repository),
})

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const sessions: DogfoodStorePort["sessions"] = () =>
    enrichmentDocument({
      contract: DOGFOOD_ENRICHMENT_CONTRACT,
      row: EnrichmentRow,
      toEnrichment,
      dataError: (message) => new DogfoodStoreDataError({ message }),
    })(sql`
      SELECT s.native_session_id,
        s.provider_kind AS harness,
        s.provider_version AS harness_version,
        s.owning_host_id AS machine,
        r.model_id AS model,
        r.agent AS agent,
        r.repository AS repository
      FROM kernel_sessions s
      LEFT JOIN kernel_agent_runs r ON r.run_id = (
        SELECT r2.run_id FROM kernel_agent_runs r2
        WHERE r2.session_id = s.session_id
        ORDER BY r2.updated_at DESC, r2.run_id DESC
        LIMIT 1
      )
      WHERE s.native_session_id IS NOT NULL AND s.native_session_id <> ''
      ORDER BY s.native_session_id
    `)

  return DogfoodStore.of({ sessions })
})

export const DogfoodStoreLive = Layer.effect(DogfoodStore, make)
