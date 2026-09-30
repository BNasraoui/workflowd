import { expect, test } from "bun:test"
import { Effect } from "effect"
import { reconcileCi } from "../../src/ci/reconcile"

test("bounds reconciliation and uses conditional inventory requests", async () => {
  const requests: unknown[] = []
  const request = async (path: string, etag: string | null) => {
    requests.push([path, etag])
    return { status: 304, etag: "cached", data: null }
  }
  expect(
    await Effect.runPromise(
      reconcileCi(request, { repository: "o/r", sha: "a".repeat(40) }, "cached"),
    ),
  ).toEqual({ status: "unchanged" })
  expect(requests).toHaveLength(1)
  expect(requests[0]).toEqual([
    `/repos/o/r/actions/runs?head_sha=${"a".repeat(40)}&per_page=100`,
    "cached",
  ])
})
test("reads failed job names and never accepts a truncated inventory", async () => {
  const request = async (path: string) => ({
    status: 200,
    etag: "new",
    data: path.includes("/jobs")
      ? { total_count: 1, jobs: [{ name: "TypeScript", conclusion: "failure" }] }
      : {
          total_count: 1,
          workflow_runs: [
            {
              id: 5,
              name: "CI",
              run_attempt: 1,
              status: "completed",
              conclusion: "failure",
              head_sha: "a".repeat(40),
            },
          ],
        },
  })
  const result = await Effect.runPromise(
    reconcileCi(request, { repository: "o/r", sha: "a".repeat(40) }, null),
  )
  expect(result).toMatchObject({ status: "snapshot", runs: [{ failingJobs: ["TypeScript"] }] })
  const overflow = await Effect.runPromise(
    Effect.result(
      reconcileCi(
        async () => ({ status: 200, etag: null, data: { total_count: 101, workflow_runs: [] } }),
        { repository: "o/r", sha: "a".repeat(40) },
        null,
      ),
    ),
  )
  expect(overflow._tag).toBe("Failure")
})
