import type { SqlClient } from "@effect/sql/SqlClient"
import type { SqlError } from "@effect/sql/SqlError"
import type { Fragment } from "@effect/sql/Statement"
import { Effect, Either } from "effect"
import type { StoreDataError } from "./errors"
import type { LeaseClaim } from "./model"
type LeaseTable = "commands" | "jobs" | "publications" | "reconciliations"
type LeaseQueueConfig<Value> = {
  readonly table: LeaseTable
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
  constructor(
    private readonly sql: SqlClient,
    private readonly config: LeaseQueueConfig<Value>,
  ) {}
  claim(input: LeaseClaim): Effect.Effect<Value | null, SqlError> {
    const { claimedAt, leaseUntil } = durableLeasePolicy.claim(input)
    const { table } = this.config
    return Effect.gen(this, function* () {
      yield* this.sql`
        UPDATE ${this.sql(table)}
        SET
          state = 'failed',
          lease_owner = NULL,
          lease_until = NULL,
          last_error = 'maximum attempts reached after lease expiry',
          updated_at = ${claimedAt}
        WHERE state = 'leased'
        AND lease_until <= ${claimedAt}
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
            lease_owner = NULL,
            lease_until = NULL,
            last_error = ${decoded.left.message},
            updated_at = ${claimedAt}
          WHERE id = ${decoded.left.recordId}
          AND state = 'leased'
          AND lease_owner = ${input.workerId}
          AND lease_until > ${claimedAt}
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
        lease_owner = NULL,
        lease_until = NULL,
        last_error = ${input.error},
        updated_at = ${input.failedAt.toISOString()}
      WHERE id = ${input.id}
      AND state = 'leased'
      AND lease_owner = ${input.workerId}
      AND lease_until > ${input.failedAt.toISOString()}
      RETURNING state
    `.pipe(Effect.map((rows) => durableLeasePolicy.retry(rows[0]?.state)))
  }
}
