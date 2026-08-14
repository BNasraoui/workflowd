import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { BunRuntime } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { loadConfig } from "./config"
import { makeLiveLayer } from "./layers"
import { runHookService } from "./runtime"

const program = Effect.gen(function* () {
  const config = yield* Effect.tryPromise({
    try: () => loadConfig(process.env),
    catch: (cause) => new Error(`Invalid configuration: ${String(cause)}`),
  })
  yield* Effect.tryPromise({
    try: () => mkdir(dirname(config.storage.databasePath), { recursive: true }),
    catch: (cause) => new Error(`Could not create state directory: ${String(cause)}`),
  })
  const DatabaseLive = SqliteClient.layer({
    filename: config.storage.databasePath,
  })
  return yield* runHookService(config).pipe(
    Effect.provide(makeLiveLayer(config).pipe(Layer.provide(DatabaseLive))),
  )
})

BunRuntime.runMain(program)
