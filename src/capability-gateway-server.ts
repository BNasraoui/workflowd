import { BunRuntime } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { loadCapabilityGatewayConfig } from "./config"
import { makeCapabilityGateway } from "./capability-gateway/service"
import { capabilityApi, capabilityHttpServer } from "./capability-gateway/http"
import type { ClaudeUpstream } from "./capability-gateway/claude"
import type { githubJobKeys } from "./sandbox/bootstrap"
import { gatewayMigrationsTable, runGatewayMigrations } from "./capability-gateway/migrations"
import { serveControl } from "./capability-gateway/control"

export interface CapabilityGatewayServerOptions {
  readonly upstream?: ClaudeUpstream
  readonly keys?: typeof githubJobKeys
}

/**
 * The capability gateway as its own process, with its own SQLite store: its grants, bindings and
 * tokens survive a restart. workflowd reaches it only on the control socket. A store that holds
 * any table but the gateway's (workflowd's, for one) is refused before anything is written.
 */
export const serveCapabilityGateway = (
  env: Record<string, string | undefined>,
  options: CapabilityGatewayServerOptions = {},
) =>
  Effect.gen(function* () {
    const config = yield* Effect.try(() => loadCapabilityGatewayConfig(env))
    const context = yield* Layer.build(SqliteClient.layer({ filename: config.storePath }))
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{
        readonly name: string
      }>`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
      const own = new Set([
        gatewayMigrationsTable,
        "capability_grants",
        "capability_bindings",
        "capability_tokens",
        "capability_proofs",
      ])
      if (tables.some(({ name }) => !own.has(name)))
        return yield* Effect.fail(new Error("the gateway's store holds tables of another store"))
      yield* sql`PRAGMA foreign_keys = ON`
      yield* sql`PRAGMA busy_timeout = 5000`
      yield* runGatewayMigrations
      const gateway = yield* makeCapabilityGateway(
        config,
        options.upstream,
        undefined,
        options.keys,
      )
      yield* serveControl({
        socket: config.controlSocket,
        daemon: config.daemon,
        target: gateway.control,
      })
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
