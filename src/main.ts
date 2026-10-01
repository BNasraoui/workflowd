import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { BunRuntime } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { loadConfig } from "./config"
import { makeLiveLayer } from "./layers"
import { runHookService } from "./runtime"

export const mainProgram = (env: Record<string, string | undefined>) =>
  Effect.gen(function* () {
    const config = yield* Effect.tryPromise({
      try: () => loadConfig(env),
      catch: (cause) => new Error(`Invalid configuration: ${String(cause)}`),
    })
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(config.storage.databasePath), { recursive: true }),
      catch: (cause) => new Error(`Could not create state directory: ${String(cause)}`),
    })
    const DatabaseLive = SqliteClient.layer({
      filename: config.storage.databasePath,
    })
    if (config.mode === "execution")
      return yield* runHookService(config).pipe(
        Effect.provide(makeLiveLayer(config).pipe(Layer.provide(DatabaseLive))),
      )
    return yield* runHookService(config).pipe(
      Effect.provide(makeLiveLayer(config).pipe(Layer.provide(DatabaseLive))),
    )
  })

if (import.meta.main) BunRuntime.runMain(mainProgram(process.env))
