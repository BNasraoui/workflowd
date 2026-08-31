import { expect, test } from "bun:test"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import {
  RemoteCoordinatorStore,
  RemoteCoordinatorStoreLive,
} from "../../src/remote/coordinator-store"
import { RemoteRunnerStore, RemoteRunnerStoreLive } from "../../src/remote/runner-store"
import { arrangeJob, now, runKernel } from "../kernel/job-store-harness"

test("coordinator recovery reports malformed durable dispatch data as a typed error", async () => {
  const result = await runKernel(
    ":memory:",
    Effect.gen(function* () {
      const remote = yield* RemoteCoordinatorStore
      const sql = yield* SqlClient.SqlClient
      yield* arrangeJob("corrupt-dispatch", { kind: "remote_probe", hostId: "host-a" })
      yield* remote.prepareNext({
        commandId: "corrupt-command",
        workerId: "coordinator",
        now,
        leaseDurationMs: 60_000,
        ttlMsForKind: () => 60_000,
      })
      yield* sql`UPDATE kernel_remote_dispatches SET issued_at = 'not-a-timestamp'
        WHERE command_id = 'corrupt-command'`
      return yield* remote.pendingDispatches().pipe(Effect.result)
    }).pipe(Effect.provide(RemoteCoordinatorStoreLive)),
  )

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "RemoteCoordinatorDataError", key: "corrupt-command" },
  })
})

test("runner recovery reports malformed durable envelope data as a typed error", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* RemoteRunnerStore
      const sql = yield* SqlClient.SqlClient
      const command = {
        version: 1 as const,
        commandId: "corrupt-runner-command",
        jobId: "corrupt-runner-job",
        attempt: 1,
        generation: 1,
        hostId: "host-a",
        kind: "probe" as const,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }
      yield* store.recordBatch(
        "host-a",
        [
          {
            deliveryId: "commands:corrupt-fence",
            data: new TextEncoder().encode(
              JSON.stringify({
                version: 1,
                kind: "fence",
                jobId: command.jobId,
                generation: command.generation,
                hostId: command.hostId,
                disposition: "current",
                issuedAt: now.toISOString(),
              }),
            ),
            message: {
              version: 1,
              kind: "fence",
              jobId: command.jobId,
              generation: command.generation,
              hostId: command.hostId,
              disposition: "current",
              issuedAt: now.toISOString(),
            } as const,
          },
          {
            deliveryId: "commands:corrupt",
            data: new TextEncoder().encode(JSON.stringify(command)),
            message: command,
          },
        ],
        now,
      )
      yield* sql`UPDATE remote_runner_inbox SET envelope_json = '{'
        WHERE command_id = 'corrupt-runner-command'`
      return yield* store.recoverReceived().pipe(Effect.result)
    }).pipe(
      Effect.provide(RemoteRunnerStoreLive),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  )

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "RemoteRunnerDataError", key: "inbox" },
  })
})

test("runner store enables SQLite foreign-key enforcement", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* RemoteRunnerStore
      const sql = yield* SqlClient.SqlClient
      return yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`
    }).pipe(
      Effect.provide(RemoteRunnerStoreLive),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  )

  expect(result).toEqual([{ foreign_keys: 1 }])
})
