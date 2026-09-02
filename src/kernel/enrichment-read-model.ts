import { Effect, Schema } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"

/**
 * Shared mechanism behind workflowd's read-only enrichment read models
 * (dogfood, agent-runs): one SQL query's rows are decoded against a row
 * schema and shaped as a single contract-versioned JSON document keyed by
 * native session id.
 *
 * Parameterized by the contract string, the row schema, the omit-vs-null
 * session builder, and the store's own data-error constructor, so each
 * consumer stays a pure contract definition while decoding, keying, and
 * document assembly live here exactly once.
 */
export type EnrichmentDocument<Session, Contract extends string> = {
  readonly contract: Contract
  readonly sessions: Readonly<Record<string, Session>>
}

/** Omit-vs-null policy atom: a null column drops its key; a value passes through. */
export const omitNull = <K extends string, V>(key: K, value: V | null): { [P in K]+?: V } => {
  const partial: { [P in K]+?: V } = {}
  if (value !== null) partial[key] = value
  return partial
}

export const enrichmentDocument =
  <
    Row extends { readonly native_session_id: string },
    Session,
    Contract extends string,
    DataError,
  >(model: {
    /** The consumer's wire-contract string, serialized verbatim. */
    readonly contract: Contract
    /** Row schema; `native_session_id` is the document's session-map key. */
    readonly row: Schema.ConstraintDecoder<Row, never>
    /** Omit-vs-null policy: builds one session payload from a decoded row. */
    readonly toEnrichment: (row: Row) => Session
    /** Wraps schema failures in the store's own data error. */
    readonly dataError: (message: string) => DataError
  }) =>
  (
    rows: Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError>,
  ): Effect.Effect<EnrichmentDocument<Session, Contract>, SqlError | DataError> =>
    Effect.flatMap(rows, (rawRows) =>
      Effect.forEach(rawRows, (rawRow) =>
        Schema.decodeUnknownEffect(model.row)(rawRow).pipe(
          Effect.mapError((error) => model.dataError(String(error))),
        ),
      ).pipe(
        Effect.map((decodedRows) => ({
          contract: model.contract,
          sessions: Object.fromEntries(
            decodedRows.map((row) => [row.native_session_id, model.toEnrichment(row)]),
          ),
        })),
      ),
    )
