import type { SqlClient } from "@effect/sql/SqlClient"
import type { SqlError } from "@effect/sql/SqlError"
import type { Fragment } from "@effect/sql/Statement"
import { Effect, Either } from "effect"
import type { StoreDataError } from "./errors"
import type { LeaseClaim } from "./model"
import { makeWorkStatePolicy, type DurableWorkQueue } from "./work-state"
type LeaseQueueConfig<Value> = {
  readonly table: DurableWorkQueue
  readonly beforeClaim?: (claimedAt: string) => Effect.Effect<void, SqlError>
  readonly claimableId: (now: string) => Fragment
  readonly returning: Fragment
  readonly decode: (row: unknown) => Effect.Effect<Value, StoreDataError>
}
type RescheduleInput = {
  readonly id: number
  readonly workerId: string
  readonly failedAt: Date
  readonly runAt: Date
  readonly error: string
  readonly maxAttempts: number
}
const durableLeasePolicy = {
  claim: (input: LeaseClaim) => ({
    claimedAt: input.now.toISOString(),
    leaseUntil: new Date(input.now.getTime() + input.leaseDurationMs).toISOString(),
  }),
  retry: (state: "failed" | "retry_scheduled" | undefined) =>
    state === undefined ? "stale" : state === "failed" ? "failed" : "retry",
} as const
export class SqlLeaseQueue<Value> {
  private readonly workState: ReturnType<typeof makeWorkStatePolicy>
  constructor(
    private readonly sql: SqlClient,
    private readonly config: LeaseQueueConfig<Value>,
  ) {
    this.workState = makeWorkStatePolicy(sql)
  }
  claim(input: LeaseClaim): Effect.Effect<Value | null, SqlError> {
    const { claimedAt, leaseUntil } = durableLeasePolicy.claim(input)
    const { table } = this.config
    return Effect.gen(this, function* () {
      if (this.config.beforeClaim !== undefined) {
        yield* this.config.beforeClaim(claimedAt)
      }
      yield* this.sql`
        UPDATE ${this.sql(table)}
        SET
          state = 'failed',
          ${this.workState.releaseLease},
          last_error = 'maximum attempts reached after lease expiry',
          updated_at = ${claimedAt}
        WHERE ${this.workState.leaseExpired(claimedAt)}
        AND attempts >= max_attempts
      `
      while (true) {
        const rows = yield* this.sql<object>`
          UPDATE ${this.sql(table)}
          SET
            state = 'leased',
            attempts = attempts + 1,
            lease_owner = ${input.workerId},
            lease_until = ${leaseUntil},
            last_error = NULL,
            updated_at = ${claimedAt}
          WHERE id = (${this.config.claimableId(claimedAt)})
          RETURNING ${this.config.returning}
        `
        const row = rows[0]
        if (row === undefined) return null
        const decoded = yield* Effect.either(this.config.decode(row))
        if (Either.isRight(decoded)) return decoded.right
        yield* this.sql`
          UPDATE ${this.sql(table)}
          SET
            state = 'data_error',
            ${this.workState.releaseLease},
            last_error = ${decoded.left.message},
            updated_at = ${claimedAt}
          WHERE id = ${decoded.left.recordId}
          AND ${this.workState.leaseHeldBy(input.workerId, claimedAt)}
        `
      }
    }).pipe(this.sql.withTransaction)
  }
  reschedule(input: RescheduleInput): Effect.Effect<"retry" | "failed" | "stale", SqlError> {
    const { table } = this.config
    return this.sql<{ readonly state: "retry_scheduled" | "failed" }>`
      UPDATE ${this.sql(table)}
      SET
        state = CASE
          WHEN attempts >= ${input.maxAttempts} THEN 'failed'
          ELSE 'retry_scheduled'
        END,
        max_attempts = MAX(attempts, ${input.maxAttempts}),
        run_at = ${input.runAt.toISOString()},
        ${this.workState.releaseLease},
        last_error = ${input.error},
        updated_at = ${input.failedAt.toISOString()}
      WHERE id = ${input.id}
      AND ${this.workState.leaseHeldBy(input.workerId, input.failedAt.toISOString())}
      RETURNING state
    `.pipe(Effect.map((rows) => durableLeasePolicy.retry(rows[0]?.state)))
  }
}
