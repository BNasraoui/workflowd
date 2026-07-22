import type { SqlClient } from "@effect/sql/SqlClient"
import { Effect } from "effect"
import type { WorkflowStorePort } from "./contracts"
import type { makePullRequestTransition } from "./pull-requests"
import type { makeSharedStoreOperations } from "./shared"

type DeliveryOperations = Pick<WorkflowStorePort, "ingestPullRequest" | "recordDelivery">

export function makeDeliveryOperations(
  sql: SqlClient,
  shared: Pick<ReturnType<typeof makeSharedStoreOperations>, "insertDelivery">,
  applyTransition: ReturnType<typeof makePullRequestTransition>,
): DeliveryOperations {
  return {
    ingestPullRequest: (delivery, event) =>
      Effect.gen(function* () {
        const insertedDeliveries = yield* shared.insertDelivery(delivery)
        const insertedDelivery = insertedDeliveries[0]
        if (insertedDelivery === undefined) {
          return { status: "duplicate" } as const
        }
        return yield* applyTransition({
          appliedAt: delivery.receivedAt,
          observationSequence: insertedDelivery.observation_sequence,
          snapshot: event,
        })
      }).pipe(sql.withTransaction),
    recordDelivery: (delivery) =>
      shared
        .insertDelivery(delivery)
        .pipe(Effect.map((rows) => (rows.length === 0 ? "duplicate" : "inserted"))),
  }
}
