import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { BunRuntime } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { loadRemoteProcessConfig } from "./remote/config"
import { runRemoteRunnerLoop } from "./remote/runner"
import { RemoteRunnerStoreLive } from "./remote/runner-store"
import { RemoteTransportLive } from "./remote/transport"

export const runRemoteRunnerProcess = () => {
  const program = Effect.gen(function* () {
    const config = yield* Effect.tryPromise({
      try: () => loadRemoteProcessConfig(process.env),
      catch: (cause) => new Error(`Invalid remote configuration: ${String(cause)}`),
    })
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(config.databasePath), { recursive: true }),
      catch: (cause) => new Error(`Could not create remote state directory: ${String(cause)}`),
    })
    const database = SqliteClient.layer({ filename: config.databasePath })
    const runner = RemoteRunnerStoreLive.pipe(Layer.provide(database))
    const transport = RemoteTransportLive({ servers: config.servers, token: config.token })
    return yield* runRemoteRunnerLoop(config.hostId).pipe(
      Effect.provide(Layer.merge(runner, transport)),
    )
  })
  BunRuntime.runMain(Effect.scoped(program))
}
