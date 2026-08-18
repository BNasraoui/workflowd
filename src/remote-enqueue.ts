import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { BunRuntime } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { KernelEventStoreLive } from "./kernel/event-store"
import { KernelJobStoreLive } from "./kernel/job-store"
import { RemoteProbeProducer, RemoteProbeProducerLive } from "./remote/probe-producer"
import { WorkflowStoreLive } from "./store"

type RemoteEnqueueProcessOptions = {
  readonly argv?: ReadonlyArray<string>
  readonly env?: Record<string, string | undefined>
  readonly runMain?: (program: Effect.Effect<void, Error, never>) => void
}

const argument = (argv: ReadonlyArray<string>, name: string) => {
  const index = argv.indexOf(name)
  const value = index < 0 ? undefined : argv[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} is required`)
  return value
}

const program = (argv: ReadonlyArray<string>, env: Record<string, string | undefined>) =>
  Effect.gen(function* () {
    const probeId = yield* Effect.try({
      try: () => argument(argv, "--probe"),
      catch: (cause) => new Error(String(cause)),
    })
    const hostId = yield* Effect.try({
      try: () => argument(argv, "--host"),
      catch: (cause) => new Error(String(cause)),
    })
    const filename =
      env.WORKFLOWD_DATABASE_PATH ?? join(homedir(), ".local/state/workflowd/workflowd.db")
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(filename), { recursive: true }),
      catch: (cause) => new Error(`Could not create state directory: ${String(cause)}`),
    })
    const database = SqliteClient.layer({ filename })
    const bootstrap = WorkflowStoreLive.pipe(Layer.provideMerge(database))
    const kernel = Layer.merge(KernelEventStoreLive, KernelJobStoreLive).pipe(
      Layer.provideMerge(bootstrap),
    )
    const producer = RemoteProbeProducerLive.pipe(Layer.provideMerge(kernel))
    const result = yield* Effect.gen(function* () {
      const probes = yield* RemoteProbeProducer
      return yield* probes.enqueue({ probeId, hostId }, new Date())
    }).pipe(Effect.provide(producer))
    yield* Effect.logInfo(`${result.status} remote probe ${result.jobId} for ${hostId}`)
  })

export const runRemoteEnqueueProcess = (options: RemoteEnqueueProcessOptions = {}) =>
  (options.runMain ?? BunRuntime.runMain)(
    program(options.argv ?? process.argv, options.env ?? process.env).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error
          ? cause
          : new Error(JSON.stringify(cause) ?? "Remote enqueue failed"),
      ),
    ),
  )

if (import.meta.main) runRemoteEnqueueProcess()
