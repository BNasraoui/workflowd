import type { SqlClient } from "@effect/sql/SqlClient"
import type { WorkState } from "../domain/work-state"
import { claimableWorkStates } from "../domain/work-state"

/**
 * The SQL half of the durable Work State policy.
 *
 * `src/domain/work-state.ts` owns the vocabulary and the state groupings; this
 * module renders them into the fragments every durable queue shares, so a
 * lifecycle change means editing the domain module and this rendering rather
 * than every statement that spells out a state or a lease.
 *
 * The one place these fragments are deliberately not used is
 * `src/store/migrations.ts`: an applied migration is history and must keep
 * emitting the DDL it emitted when it ran. `test/store/work-state-policy.test.ts`
 * checks the schema's CHECK constraints against this vocabulary instead.
 */
/**
 * Every durable queue governed by this policy, named by its table. They share
 * the same lifecycle columns — `state`, `attempts`, `max_attempts`, `run_at`,
 * `lease_owner`, `lease_until`, `last_error`, `updated_at` — which is what lets
 * the lease queue and operational status treat them uniformly.
 */
export const durableWorkQueues = ["jobs", "publications", "commands", "reconciliations"] as const

export type DurableWorkQueue = (typeof durableWorkQueues)[number]

export function makeWorkStatePolicy(sql: SqlClient) {
  const column = (name: string, alias?: string) =>
    sql.literal(alias === undefined ? name : `${alias}.${name}`)

  const stateIn = (values: ReadonlyArray<WorkState>, alias?: string) =>
    sql`${column("state", alias)} IN (${sql.literal(values.map((state) => `'${state}'`).join(", "))})`

  /** The row is still marked leased, but its lease has run out by `at`. */
  const leaseExpired = (at: string, alias?: string) => sql`
    ${column("state", alias)} = 'leased'
    AND ${column("lease_until", alias)} <= ${at}
  `

  return {
    stateIn,
    leaseExpired,

    /** Work a worker may pick up now: a claimable state, or a lease that ran out. */
    claimable: (now: string, alias?: string) => sql`(
      ${stateIn(claimableWorkStates, alias)}
      OR (${leaseExpired(now, alias)})
    )`,

    /**
     * The worker still owns the lease at `at`. Ownership authorizes mutations
     * only while the operation time is strictly before the lease expiry.
     */
    leaseHeldBy: (workerId: string, at: string, alias?: string) => sql`
      ${column("state", alias)} = 'leased'
      AND ${column("lease_owner", alias)} = ${workerId}
      AND ${column("lease_until", alias)} > ${at}
    `,

    /** Gives up lease ownership as part of an `UPDATE ... SET`. */
    releaseLease: sql.literal("lease_owner = NULL, lease_until = NULL"),
  }
}
