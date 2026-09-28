import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { CiTarget, CiCompletion } from "./event"

export const CiRun = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  attempt: Schema.Int,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  failingJobs: Schema.Array(Schema.String),
})
export type CiRun = typeof CiRun.Type
export const CiState = Schema.Struct({
  ...CiTarget.fields,
  sequence: Schema.Int,
  conclusion: Schema.Literals(["pending", "success", "failure"]),
  failingJobs: Schema.Array(Schema.String),
  runLinks: Schema.optional(Schema.Array(Schema.String)),
})
export type CiState = typeof CiState.Type
const TargetRow = Schema.Struct({
  repository: Schema.String,
  sha: Schema.String,
  installation_id: Schema.Int,
  required_json: Schema.String,
  etag: Schema.NullOr(Schema.String),
  next_poll: Schema.Number,
  expires_at: Schema.Number,
})
const EventRow = Schema.Struct({ sequence: Schema.Int, state_json: Schema.String })
const decodeJson = <A>(schema: Schema.Codec<A, unknown>, json: string) =>
  Effect.try((): unknown => JSON.parse(json)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
  )

function aggregate(required: ReadonlyArray<string>, runs: ReadonlyArray<CiRun>) {
  const latest = required.map(
    (name) =>
      runs
        .filter((run) => run.name === name)
        .sort((a, b) => b.id - a.id || b.attempt - a.attempt)[0],
  )
  if (
    latest.some((run) => run === undefined || run.status !== "completed" || run.conclusion === null)
  ) {
    return { conclusion: "pending" as const, failingJobs: [] }
  }
  const failures = latest.filter(
    (run) => run !== undefined && !["success", "skipped", "neutral"].includes(run.conclusion!),
  )
  return {
    conclusion: failures.length === 0 ? ("success" as const) : ("failure" as const),
    failingJobs: failures.flatMap((run) =>
      run!.failingJobs.length > 0 ? run!.failingJobs : [run!.name],
    ),
  }
}

export const makeCiStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const watch = Effect.fn("CiStore.watch")(function* (
    target: CiTarget,
    installationId: number,
    required: ReadonlyArray<string>,
    now: number,
  ) {
    yield* Schema.decodeUnknownEffect(CiTarget)(target)
    if (required.length === 0)
      return yield* Effect.fail(new Error("CI requires at least one workflow name"))
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const requiredJson = JSON.stringify(required)
        const changed =
          yield* sql`UPDATE ci_targets SET required_json = ${requiredJson}, installation_id = ${installationId}, etag = NULL, next_poll = ${now}
        WHERE repository = ${target.repository} AND sha = ${target.sha}
          AND (required_json != ${requiredJson} OR installation_id != ${installationId}) RETURNING sha`
        if (changed.length > 0) {
          const pending = {
            repository: target.repository,
            sha: target.sha,
            sequence: 0,
            conclusion: "pending",
            failingJobs: [],
          }
          yield* sql`INSERT INTO ci_events(repository,sha,state_json) VALUES(${target.repository},${target.sha},${JSON.stringify(pending)})`
        }
        yield* sql`INSERT INTO ci_targets (repository, sha, installation_id, required_json, next_poll, expires_at)
        VALUES (${target.repository}, ${target.sha}, ${installationId}, ${requiredJson}, ${now}, ${now + 86400000})
        ON CONFLICT(repository, sha) DO UPDATE SET expires_at = excluded.expires_at`
      }),
    )
  })
  const ingest = Effect.fn("CiStore.ingest")(function* (
    deliveryId: string,
    event: CiCompletion,
    payload: string,
    now: number,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows =
          yield* sql`INSERT INTO webhook_deliveries (delivery_id,event,action,payload,received_at)
        VALUES (${deliveryId},${event.source},'completed',${payload},${new Date(now).toISOString()})
        ON CONFLICT DO NOTHING RETURNING delivery_id`
        if (rows.length === 0) return "duplicate" as const
        yield* sql`INSERT INTO ci_deliveries (delivery_id, repository, sha, event_json)
        VALUES (${deliveryId},${event.repository},${event.sha},${JSON.stringify(event)})`
        yield* sql`UPDATE ci_targets SET next_poll = MIN(next_poll, ${now}), etag = NULL
        WHERE repository = ${event.repository} AND sha = ${event.sha}`
        return "accepted" as const
      }),
    )
  })
  const events = Effect.fn("CiStore.events")(function* (target: CiTarget, after: number) {
    const rows = yield* sql`SELECT sequence, state_json FROM ci_events
      WHERE repository = ${target.repository} AND sha = ${target.sha} AND sequence > ${after}
      ORDER BY sequence LIMIT 100`
    return yield* Effect.forEach(rows, (row) =>
      Schema.decodeUnknownEffect(EventRow)(row).pipe(
        Effect.flatMap((row) =>
          decodeJson(CiState, row.state_json).pipe(
            Effect.map((state) => ({ ...state, sequence: row.sequence })),
          ),
        ),
      ),
    )
  })
  const read = Effect.fn("CiStore.read")(function* (target: CiTarget) {
    const rows = yield* sql`SELECT sequence, state_json FROM ci_events
      WHERE repository = ${target.repository} AND sha = ${target.sha} ORDER BY sequence DESC LIMIT 1`
    if (rows.length === 0) return null
    const row = yield* Schema.decodeUnknownEffect(EventRow)(rows[0])
    return { ...(yield* decodeJson(CiState, row.state_json)), sequence: row.sequence }
  })
  const snapshot = Effect.fn("CiStore.snapshot")(function* (
    target: CiTarget,
    runs: ReadonlyArray<CiRun>,
    etag: string | null,
    now: number,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT * FROM ci_targets WHERE repository = ${target.repository} AND sha = ${target.sha}`
        const row = yield* Schema.decodeUnknownEffect(TargetRow)(rows[0])
        const required = yield* decodeJson(Schema.Array(Schema.String), row.required_json)
        const result = {
          repository: target.repository,
          sha: target.sha,
          sequence: 0,
          ...aggregate(required, runs),
          runLinks: runs
            .filter((run) => required.includes(run.name))
            .map((run) => `https://github.com/${target.repository}/actions/runs/${run.id}`),
        }
        const previous = yield* read(target)
        if (
          previous === null ||
          JSON.stringify({ ...previous, sequence: 0 }) !== JSON.stringify(result)
        ) {
          yield* sql`INSERT INTO ci_events (repository,sha,state_json) VALUES (${target.repository},${target.sha},${JSON.stringify(result)})`
        }
        yield* sql`UPDATE ci_targets SET etag = ${etag}, next_poll = ${now + 60000}
        WHERE repository = ${target.repository} AND sha = ${target.sha}`
      }),
    )
  })
  const due = Effect.fn("CiStore.due")(function* (now: number) {
    const rows =
      yield* sql`SELECT * FROM ci_targets WHERE next_poll <= ${now} AND expires_at > ${now}
      ORDER BY next_poll, repository, sha LIMIT 1`
    return yield* Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(TargetRow)(row))
  })
  const defer = Effect.fn("CiStore.defer")(function* (target: CiTarget, until: number) {
    yield* sql`UPDATE ci_targets SET next_poll = ${until} WHERE repository = ${target.repository} AND sha = ${target.sha}`
  })
  const outbox = Effect.fn("CiStore.outbox")(function* () {
    const rows =
      yield* sql`SELECT sequence, state_json FROM ci_events WHERE published = 0 ORDER BY sequence LIMIT 100`
    return yield* Effect.forEach(rows, (row) =>
      Schema.decodeUnknownEffect(EventRow)(row).pipe(
        Effect.flatMap((row) =>
          decodeJson(CiState, row.state_json).pipe(
            Effect.map((state) => ({ ...state, sequence: row.sequence })),
          ),
        ),
      ),
    )
  })
  const published = Effect.fn("CiStore.published")(function* (sequence: number) {
    yield* sql`UPDATE ci_events SET published = 1 WHERE sequence = ${sequence}`
  })
  const deliveryOutbox = Effect.fn("CiStore.deliveryOutbox")(function* () {
    const rows =
      yield* sql`SELECT delivery_id, event_json FROM ci_deliveries WHERE published = 0 ORDER BY delivery_id LIMIT 100`
    return yield* Effect.forEach(rows, (row) =>
      Schema.decodeUnknownEffect(
        Schema.Struct({ delivery_id: Schema.String, event_json: Schema.String }),
      )(row).pipe(
        Effect.flatMap((row) =>
          decodeJson(CiCompletion, row.event_json).pipe(
            Effect.map((event) => ({ deliveryId: row.delivery_id, event })),
          ),
        ),
      ),
    )
  })
  const deliveryPublished = Effect.fn("CiStore.deliveryPublished")(function* (deliveryId: string) {
    yield* sql`UPDATE ci_deliveries SET published = 1 WHERE delivery_id = ${deliveryId}`
  })
  return {
    watch,
    ingest,
    read,
    events,
    snapshot,
    due,
    defer,
    outbox,
    published,
    deliveryOutbox,
    deliveryPublished,
  }
})
type StoredCi = Effect.Success<typeof makeCiStore>
export type CiStore = Omit<StoredCi, "ingest"> & {
  readonly ingest: (
    ...args: Parameters<StoredCi["ingest"]>
  ) => Effect.Effect<
    "accepted" | "duplicate" | "ignored",
    Effect.Error<ReturnType<StoredCi["watch"]>>
  >
}
