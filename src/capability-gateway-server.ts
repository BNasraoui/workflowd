import { BunRuntime } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { loadCapabilityGatewayConfig } from "./config"
import { makeCapabilityGateway } from "./capability-gateway/service"
import { capabilityApi, capabilityHttpServer } from "./capability-gateway/http"
import type { ClaudeUpstream } from "./capability-gateway/claude"
import type { githubJobKeys } from "./sandbox/bootstrap"
import { runStoreMigrations } from "./store/migrations"

export interface CapabilityGatewayServerOptions {
  readonly upstream?: ClaudeUpstream
  readonly keys?: typeof githubJobKeys
}

/**
 * The capability gateway as its own process. It shares workflowd's SQLite store (WAL, busy
 * timeout), so a run's binding, tokens and revocation survive a restart of either process.
 */
export const serveCapabilityGateway = (
  env: Record<string, string | undefined>,
  options: CapabilityGatewayServerOptions = {},
) =>
  Effect.gen(function* () {
    const { gateway: config, databasePath } = yield* Effect.try(() =>
      loadCapabilityGatewayConfig(env),
    )
    const context = yield* Layer.build(SqliteClient.layer({ filename: databasePath }))
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`PRAGMA foreign_keys = ON`
      yield* sql`PRAGMA busy_timeout = 5000`
      yield* runStoreMigrations
      const gateway = yield* makeCapabilityGateway(
        config,
        options.upstream,
        undefined,
        options.keys,
      )
      const { server, close } = capabilityHttpServer(capabilityApi(gateway), true)
      yield* Effect.acquireRelease(
        Effect.tryPromise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.once("error", reject)
              server.listen(config.listen.port, config.listen.host, () => resolve())
            }),
        ),
        () => Effect.tryPromise(close).pipe(Effect.orDie),
      )
      const address = server.address()
      if (address === null || typeof address === "string")
        return yield* Effect.fail(new Error("capability gateway listener unavailable"))
      return { host: config.listen.host, port: address.port }
    }).pipe(Effect.provide(context))
  })

/** Process entry: serve until stopped, and name the bound port on standard output. */
export const runCapabilityGatewayServer = (
  env: Record<string, string | undefined>,
  options: CapabilityGatewayServerOptions = {},
) =>
  serveCapabilityGateway(env, options).pipe(
    Effect.tap(({ port }) => Effect.sync(() => process.stdout.write(`listening ${port}\n`))),
    Effect.andThen(Effect.never),
    Effect.scoped,
  )

if (import.meta.main) BunRuntime.runMain(runCapabilityGatewayServer(process.env))
