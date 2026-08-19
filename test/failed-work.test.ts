import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { WorkflowStoreLive } from "../src/store"
import { WorkflowStore } from "../src/store/contracts"
import { samplePullRequestEvent } from "./store/harness"

/**
 * The operator workflow the README documents, run the way an operator runs it:
 * a real database file, the shipped command, and its exit codes.
 */

const repositoryRoot = join(import.meta.dir, "..")
let directory = ""
let databasePath = ""
let jobId = 0

const failedWork = (...argv: ReadonlyArray<string>) => {
  const process = Bun.spawnSync(["bun", "scripts/failed-work.ts", ...argv], {
    cwd: repositoryRoot,
    env: { ...Bun.env, WORKFLOWD_DATABASE_PATH: databasePath },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: process.exitCode,
    stdout: process.stdout.toString(),
    stderr: process.stderr.toString(),
  }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "workflowd-failed-work-"))
  databasePath = join(directory, "workflowd.db")
  jobId = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* WorkflowStore
      yield* store.ingestPullRequest(
        {
          deliveryId: "delivery-operator-workflow",
          event: "pull_request",
          action: "opened",
          payload: "{}",
          receivedAt: new Date("2026-07-19T12:00:00.000Z"),
        },
        samplePullRequestEvent,
      )
      const job = yield* store.claimNextJob({
        workerId: "worker-1",
        now: new Date("2026-07-19T12:01:00.000Z"),
        leaseDurationMs: 600_000,
      })
      if (job === null) throw new Error("expected queued Review Work")
      yield* store.rescheduleJob({
        jobId: job.id,
        workerId: "worker-1",
        failedAt: new Date("2026-07-19T12:02:00.000Z"),
        runAt: new Date("2026-07-19T12:03:00.000Z"),
        error: "GitHub was unreachable",
        maxAttempts: 1,
      })
      return Number(job.id)
    }).pipe(
      Effect.provide(
        WorkflowStoreLive.pipe(Layer.provide(SqliteClient.layer({ filename: databasePath }))),
      ),
    ),
  )
})

afterAll(async () => {
  if (directory !== "") await rm(directory, { recursive: true, force: true })
})

describe("failed-work command", () => {
  test("lists terminally failed work with the counts readiness reports", () => {
    const listed = failedWork("list")

    expect(listed.exitCode).toBe(0)
    const report: unknown = JSON.parse(listed.stdout)
    expect(report).toMatchObject({
      queues: expect.arrayContaining([
        { queue: "jobs", failed: 1, quarantined: 0, oldestFailureAt: expect.any(String) },
      ]),
      agentSessionsAwaitingOperator: 0,
      work: {
        jobs: [
          expect.objectContaining({
            id: jobId,
            state: "failed",
            lastError: "GitHub was unreachable",
            eligibility: "eligible",
          }),
        ],
        publications: [],
        commands: [],
        reconciliations: [],
      },
    })
  })

  test("narrows the listing to one queue", () => {
    const listed = failedWork("list", "publications")

    expect(listed.exitCode).toBe(0)
    expect(JSON.parse(listed.stdout)).toMatchObject({ work: { publications: [] } })
  })

  test("retries eligible work once and then reports it is no longer failed", () => {
    const first = failedWork("retry", "jobs", String(jobId))
    const second = failedWork("retry", "jobs", String(jobId))

    expect(first.exitCode).toBe(0)
    expect(JSON.parse(first.stdout)).toEqual({
      queue: "jobs",
      id: jobId,
      disposition: "requeued",
    })
    expect(second.exitCode).toBe(1)
    expect(JSON.parse(second.stdout)).toMatchObject({ disposition: "not_failed" })
  })

  test("rejects an unknown queue with usage", () => {
    const rejected = failedWork("retry", "widgets", "1")

    expect(rejected.exitCode).toBe(2)
    expect(rejected.stderr).toContain("unknown queue widgets")
    expect(rejected.stderr).toContain("bun scripts/failed-work.ts list")
  })

  test("is reachable by the commands the README documents", async () => {
    const [readme, manifest] = await Promise.all([
      Bun.file(join(repositoryRoot, "README.md")).text(),
      Bun.file(join(repositoryRoot, "package.json")).json(),
    ])

    expect(manifest.scripts["failed-work"]).toBe("bun scripts/failed-work.ts")
    expect(readme).toContain("bun run failed-work list")
    expect(readme).toContain("bun run failed-work retry jobs")
    expect(readme).toContain("WORKFLOWD_DATABASE_PATH")
  })

  test("refuses to invent a database that is not there", () => {
    const missing = Bun.spawnSync(["bun", "scripts/failed-work.ts", "list"], {
      cwd: repositoryRoot,
      env: { ...Bun.env, WORKFLOWD_DATABASE_PATH: join(directory, "absent.db") },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(missing.exitCode).toBe(2)
    expect(missing.stderr.toString()).toContain("no workflowd database at")
  })
})
