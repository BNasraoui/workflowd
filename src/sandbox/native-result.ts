import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { CapabilityBinding } from "../capability-gateway/store"
import { PublicationBody, PublicationMessage, PublicationTitle } from "./config"

export const NativeCompletion = Schema.Struct({
  branch: Schema.NonEmptyString.check(
    Schema.makeFilter(
      (value) =>
        value.isWellFormed() &&
        Buffer.byteLength(value) <= 1024 &&
        !value.startsWith("-") &&
        !value.endsWith(".") &&
        ![...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) &&
        !/[~^:?*[\\]/.test(value) &&
        !value.includes("..") &&
        !value.includes("@{") &&
        value
          .split("/")
          .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")),
    ),
  ),
  title: PublicationTitle,
  commitMessage: PublicationMessage,
  body: PublicationBody,
})
export const NativeResultRequest = Schema.Struct({
  revision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99 })),
  completion: NativeCompletion,
})
export const NativeFinalizationRequest = Schema.Struct({
  operation: Schema.Literal("finalize"),
  revision: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
})
const Candidate = Schema.Struct({
  channel: Schema.String,
  revision: Schema.Int,
  completion: Schema.fromJsonString(NativeCompletion),
  frozen: Schema.Int,
})

/** Candidates carry no publication authority. The controller freezes only after owned shutdown. */
export const makeNativeResultStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const read = Effect.fn("NativeResult.read")(function* (runId: string) {
    const rows =
      yield* sql`SELECT channel,revision,completion,frozen FROM sandbox_native_results WHERE run_id=${runId}`
    return rows.length === 0 ? null : yield* Schema.decodeUnknownEffect(Candidate)(rows[0])
  })
  const submit = Effect.fn("NativeResult.submit")(
    (binding: CapabilityBinding, input: typeof NativeResultRequest.Type) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* read(binding.runId)
          if (previous && (previous.channel !== binding.channel || previous.frozen)) return null
          const encoded = JSON.stringify(input.completion)
          if (
            previous?.revision === input.revision + 1 &&
            JSON.stringify(previous.completion) === encoded
          )
            return previous.revision
          if ((previous?.revision ?? 0) !== input.revision) return null
          const selected = yield* sql`SELECT 1 FROM sandbox_native_executions
            WHERE run_id=${binding.runId} AND finalize_revision IS NOT NULL`
          if (selected.length) return null
          const revision = input.revision + 1
          yield* sql`INSERT INTO sandbox_native_results(run_id,channel,revision,completion)
        VALUES(${binding.runId},${binding.channel},${revision},${encoded})
        ON CONFLICT(run_id) DO UPDATE SET revision=excluded.revision,completion=excluded.completion`
          return revision
        }),
      ),
  )
  return { read, submit }
})
