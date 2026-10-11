import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SandboxError } from "./store"

const sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const ResultMetadata = Schema.Struct({
  sourceSha: sha,
  resultSha: sha,
  branch: Schema.String,
  bundleSha256: digest,
  manifestSha256: digest,
})
export const PublicationReceipt = Schema.Struct({
  stage: Schema.Literals(["validated", "pushing", "pushed", "creating_pr", "published"]),
  pr: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  revoked: Schema.Boolean,
})
export const PublishIntent = Schema.Struct({
  run_id: Schema.String,
  actions_run_id: Schema.Int,
  attempt: Schema.Literal(1),
  metadata: Schema.fromJsonString(ResultMetadata),
  phase: Schema.Literals([
    "sealed",
    "approving",
    "approved",
    "probed",
    "published",
    "operator_required",
    "cancelled",
  ]),
  artifact_id: Schema.NullOr(Schema.Int),
  artifact_digest: Schema.NullOr(Schema.String),
  deadline: Schema.Number,
  base_ref: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(Schema.fromJsonString(PublicationReceipt)),
})
export type PublishIntent = typeof PublishIntent.Type

export const makePublishStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const read = Effect.fn("PublishStore.read")(function* (runId: string) {
    const rows = yield* sql`SELECT * FROM sandbox_publications WHERE run_id=${runId}`
    return rows.length === 0 ? null : yield* Schema.decodeUnknownEffect(PublishIntent)(rows[0])
  })
  const seal = Effect.fn("PublishStore.seal")(function* (input: {
    runId: string
    actionsRunId: number
    attempt: number
    metadata: typeof ResultMetadata.Type
    deadline: number
    baseRef: string
  }) {
    const metadata = yield* Schema.encodeEffect(Schema.fromJsonString(ResultMetadata))(
      input.metadata,
    )
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO sandbox_publications(run_id,actions_run_id,attempt,metadata,phase,deadline,base_ref)
        VALUES(${input.runId},${input.actionsRunId},${input.attempt},${metadata},'sealed',${input.deadline},${input.baseRef})
        ON CONFLICT(run_id) DO NOTHING`
        const saved = yield* read(input.runId)
        if (
          saved === null ||
          saved.actions_run_id !== input.actionsRunId ||
          saved.attempt !== input.attempt ||
          JSON.stringify(saved.metadata) !== metadata ||
          saved.deadline !== input.deadline ||
          saved.base_ref !== input.baseRef
        )
          return yield* Effect.fail(new SandboxError({ message: "Publication intent changed" }))
      }),
    )
  })
  const claimApproval = (runId: string, artifactId: number, artifactDigest: string) =>
    sql`UPDATE sandbox_publications SET phase='approving',artifact_id=${artifactId},artifact_digest=${artifactDigest}
      WHERE run_id=${runId} AND phase='sealed' AND deadline>${Date.now()} RETURNING run_id`.pipe(
      Effect.map((rows) => rows.length === 1),
    )
  const advance = (runId: string, from: PublishIntent["phase"], to: PublishIntent["phase"]) =>
    sql`UPDATE sandbox_publications SET phase=${to} WHERE run_id=${runId} AND phase=${from}`.pipe(
      Effect.asVoid,
    )
  const saveReceipt = Effect.fn("PublishStore.saveReceipt")(function* (
    runId: string,
    receipt: typeof PublicationReceipt.Type,
  ) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PublicationReceipt))(receipt)
    yield* sql`UPDATE sandbox_publications SET receipt=${encoded} WHERE run_id=${runId} AND phase='approved'
      AND (receipt IS NULL OR json_extract(receipt,'$.stage') != 'published')`
  })
  return { read, seal, claimApproval, advance, saveReceipt }
})
