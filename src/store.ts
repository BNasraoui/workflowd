import { SqlClient } from "@effect/sql"
import { Effect, Layer } from "effect"
import { SqlCommandStore } from "./store/commands"
import { WorkflowStore } from "./store/contracts"
import { makeDeliveryOperations } from "./store/deliveries"
import { makeJobOperations } from "./store/jobs"
import { runStoreMigrations } from "./store/migrations"
import { makePublicationOperations } from "./store/publications"
import { makePullRequestTransition } from "./store/pull-requests"
import { makeReconciliationOperations } from "./store/reconciliations"
import { makeSharedStoreOperations } from "./store/shared"

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`PRAGMA foreign_keys = ON`
  yield* sql`PRAGMA busy_timeout = 5000`
  yield* runStoreMigrations

  const shared = makeSharedStoreOperations(sql)
  const applyPullRequestTransition = makePullRequestTransition(sql, shared)
  return WorkflowStore.of({
    ...new SqlCommandStore(sql, shared),
    ...makeDeliveryOperations(sql, shared, applyPullRequestTransition),
    ...makeJobOperations(sql, shared),
    ...makePublicationOperations(sql),
    ...makeReconciliationOperations(sql, applyPullRequestTransition),
  })
})

export const WorkflowStoreLive = Layer.effect(WorkflowStore, make)
