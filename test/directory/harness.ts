import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { loadConfig } from "../../src/config"
import { makeLiveLayer } from "../../src/layers"
import { startHookService } from "../../src/runtime"

export async function startDirectoryDaemon(
  hostId: string,
  database: string,
  env: Record<string, string> = {},
) {
  const config = await loadConfig({
    WORKFLOWD_MODE: "execution",
    WORKFLOWD_HOST_ID: hostId,
    WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN: "directory-secret",
    WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "false",
    ...env,
  })
  if (config.mode !== "execution") throw new Error("Fixture requires execution mode")
  const runtime = ManagedRuntime.make(
    makeLiveLayer(config).pipe(Layer.provide(SqliteClient.layer({ filename: database }))),
  )
  const scope = Effect.runSync(Scope.make())
  try {
    const server = await runtime.runPromise(
      startHookService({ ...config, http: { ...config.http, port: 0 } }).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    )
    return {
      runtime,
      url: server.url,
      request: (path: string, options: RequestInit = {}) =>
        fetch(new URL(path, server.url), {
          ...options,
          headers: { authorization: "Bearer directory-secret", ...options.headers },
        }),
      stop: async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void))
        await runtime.dispose()
      },
    }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await runtime.dispose()
    throw error
  }
}
