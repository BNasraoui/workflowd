import { Effect, Schema } from "effect"
import type { CiTarget } from "./event"
import type { CiRun } from "./store"

export type CiRequest = (
  path: string,
  etag: string | null,
) => Promise<{ readonly status: number; readonly etag: string | null; readonly data: unknown }>
const Inventory = Schema.Struct({
  total_count: Schema.Int,
  workflow_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
      run_attempt: Schema.Int,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      head_sha: Schema.String,
    }),
  ),
})
const Jobs = Schema.Struct({
  total_count: Schema.Int,
  jobs: Schema.Array(
    Schema.Struct({ name: Schema.String, conclusion: Schema.NullOr(Schema.String) }),
  ),
})
const success = (conclusion: string | null) =>
  conclusion !== null && ["success", "skipped", "neutral"].includes(conclusion)

const failingJobNames = Effect.fn("Ci.failingJobNames")(function* (
  request: CiRequest,
  path: string,
) {
  const response = yield* Effect.tryPromise(() => request(path, null))
  if (response.status !== 200) return yield* Effect.fail(new Error("CI jobs unavailable"))
  const jobs = yield* Schema.decodeUnknownEffect(Jobs)(response.data)
  if (jobs.total_count > jobs.jobs.length)
    return yield* Effect.fail(new Error("CI jobs exceed bounded page"))
  return jobs.jobs.filter((job) => !success(job.conclusion)).map((job) => job.name)
})

/** One inventory and at most ten job requests per pass. Incomplete inventories fail closed. */
export const reconcileCi = Effect.fn("Ci.reconcile")(function* (
  request: CiRequest,
  target: CiTarget,
  etag: string | null,
) {
  const base = `/repos/${target.repository}/actions/runs`
  const response = yield* Effect.tryPromise(() =>
    request(`${base}?head_sha=${target.sha}&per_page=100`, etag),
  )
  if (response.status === 304) return { status: "unchanged" as const }
  if (response.status !== 200) return yield* Effect.fail(new Error("CI inventory unavailable"))
  const inventory = yield* Schema.decodeUnknownEffect(Inventory)(response.data)
  if (inventory.total_count > inventory.workflow_runs.length)
    return yield* Effect.fail(new Error("CI inventory exceeds bounded page"))
  const latest = new Map<string, (typeof inventory.workflow_runs)[number]>()
  for (const run of inventory.workflow_runs) {
    if (run.head_sha !== target.sha)
      return yield* Effect.fail(new Error("CI inventory SHA mismatch"))
    const prior = latest.get(run.name)
    if (
      prior === undefined ||
      run.id > prior.id ||
      (run.id === prior.id && run.run_attempt > prior.run_attempt)
    )
      latest.set(run.name, run)
  }
  const failed = [...latest.values()].filter(
    (run) => run.status === "completed" && !success(run.conclusion),
  )
  if (failed.length > 10)
    return yield* Effect.fail(new Error("CI job inventory exceeds request budget"))
  const runs: CiRun[] = []
  for (const run of latest.values()) {
    const failingJobs = failed.includes(run)
      ? yield* failingJobNames(
          request,
          `${base}/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
        )
      : []
    runs.push({
      id: run.id,
      name: run.name,
      attempt: run.run_attempt,
      status: run.status,
      conclusion: run.conclusion,
      failingJobs,
    })
  }
  return { status: "snapshot" as const, runs, etag: response.etag }
})
