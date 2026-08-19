import { existsSync } from "node:fs"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { resolveDatabasePath } from "../src/config"
import { WorkflowStoreLive } from "../src/store"
import { WorkflowStore } from "../src/store/contracts"
import { durableWorkQueues, type DurableWorkQueue } from "../src/store/work-state"

/**
 * Inspect and retry terminally failed work.
 *
 * `/ready` counts what has piled up; this command says what it is and puts back
 * the part that can safely go back. It reads the same database the controller
 * writes, so it may be run while the service is up. A requeued record returns
 * to `ready`, and the worker picks it up on its next poll.
 */

const usage = `usage:
  bun scripts/failed-work.ts list [<queue>] [--limit <count>]
  bun scripts/failed-work.ts retry <queue> <id>

queues: ${durableWorkQueues.join(", ")}
database: WORKFLOWD_DATABASE_PATH, or WORKFLOWD_STATE_DIR/workflowd.db`

class UsageError extends Error {}

function parseQueue(value: string | undefined): DurableWorkQueue {
  const queue = durableWorkQueues.find((candidate) => candidate === value)
  if (queue === undefined) {
    throw new UsageError(`unknown queue ${String(value)}`)
  }
  return queue
}

function parseLimit(argv: ReadonlyArray<string>): number {
  const flag = argv.indexOf("--limit")
  if (flag === -1) return 50
  const limit = Number(argv[flag + 1])
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new UsageError(`--limit needs a positive whole number`)
  }
  return limit
}

function parsePositionalId(value: string | undefined): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new UsageError(`expected a record id, got ${String(value)}`)
  }
  return id
}

type Command =
  | {
      readonly _tag: "List"
      readonly queues: ReadonlyArray<DurableWorkQueue>
      readonly limit: number
    }
  | { readonly _tag: "Retry"; readonly queue: DurableWorkQueue; readonly id: number }

function parseCommand(argv: ReadonlyArray<string>): Command {
  const [command, ...rest] = argv
  if (command === "list") {
    const queue = rest[0]
    return {
      _tag: "List",
      queues:
        queue === undefined || queue.startsWith("--") ? durableWorkQueues : [parseQueue(queue)],
      limit: parseLimit(rest),
    }
  }
  if (command === "retry") {
    return { _tag: "Retry", queue: parseQueue(rest[0]), id: parsePositionalId(rest[1]) }
  }
  throw new UsageError(`unknown command ${String(command)}`)
}

function run(command: Command) {
  return Effect.gen(function* () {
    const store = yield* WorkflowStore
    if (command._tag === "Retry") {
      const disposition = yield* store.requeueFailedWork({
        queue: command.queue,
        id: command.id,
        now: new Date(),
      })
      return {
        report: { queue: command.queue, id: command.id, disposition },
        requeued: disposition === "requeued",
      }
    }
    const summary = yield* store.summarizeTerminalFailures()
    const listings = yield* Effect.forEach(command.queues, (queue) =>
      store
        .listFailedWork({ queue, limit: command.limit })
        .pipe(Effect.map((work) => [queue, work] as const)),
    )
    return {
      report: { ...summary, work: Object.fromEntries(listings) },
      requeued: true,
    }
  })
}

let command: Command
try {
  command = parseCommand(process.argv.slice(2))
} catch (cause) {
  console.error(cause instanceof UsageError ? `${cause.message}\n\n${usage}` : String(cause))
  process.exit(2)
}

const databasePath = resolveDatabasePath(process.env)
if (!existsSync(databasePath)) {
  console.error(`no workflowd database at ${databasePath}`)
  process.exit(2)
}

const outcome = await Effect.runPromise(
  run(command).pipe(
    Effect.provide(
      WorkflowStoreLive.pipe(Layer.provide(SqliteClient.layer({ filename: databasePath }))),
    ),
  ),
)

console.log(JSON.stringify(outcome.report, null, 2))
if (!outcome.requeued) process.exit(1)
