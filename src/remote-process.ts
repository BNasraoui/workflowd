import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { BunRuntime } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { makeClaudeCli } from "./kernel/claude-session"
import { ClaudeResumeExecutor, makeClaudeResumeExecutor } from "./remote/claude-resume-executor"
import { loadRemoteProcessConfig } from "./remote/config"
import { runRemoteRunnerLoop } from "./remote/runner"
import { RemoteRunnerStoreLive } from "./remote/runner-store"
import { RemoteTransportLive } from "./remote/transport"
import { DirectoryResponderLive } from "./directory/responder"
import { DirectoryStoreLive } from "./directory/store"
import { RunnerDiscoveryLive } from "./directory/runner-discovery"
import { WorkflowStoreLive } from "./store"

type RemoteRunnerProcessOptions = {
  readonly env?: Record<string, string | undefined>
  readonly runMain?: (program: Effect.Effect<void, Error, never>) => void
}

export const runRemoteRunnerProcess = (options: RemoteRunnerProcessOptions = {}) => {
  const program = Effect.gen(function* () {
    const config = yield* Effect.tryPromise({
      try: () => loadRemoteProcessConfig(options.env ?? process.env),
      catch: (cause) => new Error(`Invalid remote configuration: ${String(cause)}`),
    })
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(config.databasePath), { recursive: true }),
      catch: (cause) => new Error(`Could not create remote state directory: ${String(cause)}`),
    })
    const database = SqliteClient.layer({ filename: config.databasePath })
    const executor = Layer.succeed(
      ClaudeResumeExecutor,
      makeClaudeResumeExecutor({
        cli: makeClaudeCli({ binary: config.claudeBinary }),
        allowedDirectories: config.claudeDirectories,
      }),
    )
    const runner = RemoteRunnerStoreLive.pipe(Layer.provide(database), Layer.provide(executor))
    const transport = RemoteTransportLive({ servers: config.servers, auth: config.auth })
    const directory =
      config.directory === undefined
        ? Layer.empty
        : DirectoryResponderLive(config.hostId, config.directory).pipe(
            Layer.provide(
              DirectoryStoreLive.pipe(
                Layer.provide(WorkflowStoreLive.pipe(Layer.provideMerge(database))),
              ),
            ),
            Layer.provide(
              RunnerDiscoveryLive(
                config.hostId,
                config.directory,
                config.claudeDirectories.length > 0,
              ),
            ),
            Layer.provide(transport),
            Layer.provide(database),
          )
    return yield* runRemoteRunnerLoop(config.hostId).pipe(
      Effect.provide(Layer.mergeAll(runner, transport, directory)),
    )
  })
  ;(options.runMain ?? BunRuntime.runMain)(
    Effect.scoped(program).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(JSON.stringify(cause) ?? "Remote runner failed"),
      ),
    ),
  )
}

if (import.meta.main) runRemoteRunnerProcess()
