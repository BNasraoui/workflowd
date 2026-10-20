import { BunRuntime } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { startConfigReload } from "../../src/config-reload"
import { makeLiveLayer } from "../../src/layers"
import { runHookService } from "../../src/runtime"

// Use an OS-assigned port without loosening the production environment parser.
BunRuntime.runMain(
  Effect.gen(function* () {
    const reload = yield* Effect.acquireRelease(
      Effect.tryPromise(() => startConfigReload(process.env, console.info)),
      (owner) => Effect.promise(() => owner.close()),
    )
    const config = { ...reload.config, http: { ...reload.config.http, port: 0 } }
    return yield* runHookService(config).pipe(
      Effect.provide(
        makeLiveLayer(config).pipe(
          Layer.provide(SqliteClient.layer({ filename: config.storage.databasePath })),
        ),
      ),
    )
  }).pipe(Effect.scoped),
)
