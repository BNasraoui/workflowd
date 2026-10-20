import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { BunRuntime } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { AgentRunDispatchSettings, startConfigReload } from "./config-reload"
import { makeLiveLayer } from "./layers"
import { runHookService } from "./runtime"

export const mainProgram = (env: Record<string, string | undefined>) =>
  Effect.gen(function* () {
    const reload = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => startConfigReload(env, (line) => console.info(line)),
        catch: (cause) => new Error(`Invalid configuration: ${String(cause)}`),
      }),
      (resource) =>
        Effect.tryPromise({
          try: () => resource.close(),
          catch: () => new Error("Configuration reload cleanup failed"),
        }).pipe(Effect.orDie),
    )
    const config = reload.config
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(config.storage.databasePath), { recursive: true }),
      catch: (cause) => new Error(`Could not create state directory: ${String(cause)}`),
    })
    const DatabaseLive = SqliteClient.layer({
      filename: config.storage.databasePath,
    })
    if (config.mode === "execution")
      return yield* runHookService(config).pipe(
        Effect.provide(
          makeLiveLayer(config).pipe(
            Layer.provide(DatabaseLive),
            Layer.provide(Layer.succeed(AgentRunDispatchSettings, reload.dispatchSettings)),
          ),
        ),
      )
    return yield* runHookService(config).pipe(
      Effect.provide(
        makeLiveLayer(config).pipe(
          Layer.provide(DatabaseLive),
          Layer.provide(Layer.succeed(AgentRunDispatchSettings, reload.dispatchSettings)),
        ),
      ),
    )
  }).pipe(Effect.scoped)

if (import.meta.main) BunRuntime.runMain(mainProgram(process.env))
