import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { gatewayMigrationsTable } from "../capability-control/protocol"
import { storeTables } from "../capability-control/store-tables"

/**
 * workflowd's database at `filename`. A file that holds the capability gateway's migrations table
 * is the gateway's store: workflowd reads it read only and refuses it before it opens the file for
 * writing.
 */
export const workflowdDatabase = (filename: string) =>
  Layer.unwrap(
    Effect.tryPromise({
      try: () => storeTables(filename),
      catch: (cause) => new Error(`workflowd cannot read its database: ${String(cause)}`),
    }).pipe(
      Effect.flatMap((tables) =>
        tables?.includes(gatewayMigrationsTable)
          ? Effect.fail(
              new Error("the database is the capability gateway's store; workflowd refuses it"),
            )
          : Effect.succeed(SqliteClient.layer({ filename })),
      ),
    ),
  )
