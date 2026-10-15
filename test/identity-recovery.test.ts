import { expect, test } from "bun:test"
import { Effect } from "effect"
import { checkName, fixture, head } from "./helpers/identity"

const own = {
  id: 12,
  name: checkName,
  app: { id: 123 },
  status: "in_progress",
  external_id: "agent-git:7",
}

test("startup paginates open PRs and checks, recovering only this App's pending identity checks", async () => {
  let pages = 0
  const f = fixture({
    suiteChecks: [
      { ...own, app: { id: 999 } },
      { ...own, name: "Other" },
      { ...own, status: "completed" },
      { ...own, external_id: "other:7" },
      { ...own, external_id: "agent-git:8" },
      ...Array.from({ length: 95 }, () => ({ ...own, status: "queued" })),
      own,
    ],
    intercept: async (path, _body, _signal, url) => {
      if (!path.endsWith("/pulls")) return
      pages++
      // A closed PR has an otherwise recoverable check too. Honour the API query
      // so broadening discovery to all PRs produces an extra recovery.
      const pulls = pages === 1 ? [] : [{ number: 7, head: { sha: head } }]
      if (url.searchParams.get("state") !== "open")
        pulls.push({ number: 8, head: { sha: "c".repeat(40) } })
      const response = Response.json(pulls, {
        headers:
          pages === 1
            ? {
                link: '<https://api.github.com/repos/owner/repo/pulls?state=open&per_page=100&page=2>; rel="next"',
              }
            : {},
      })
      Object.defineProperty(response, "url", {
        value: "https://api.github.com/repos/owner/repo/pulls",
      })
      return response
    },
  })
  const recovered: unknown[] = []
  await Effect.runPromise(
    f.app.recoverIdentityChecks(
      [{ repository: "owner/repo", installationId: 91 }],
      (event, payload) =>
        Effect.sync(() => {
          recovered.push({ event, payload })
        }),
    ),
  )
  expect(pages).toBe(2)
  expect(
    f.requests.filter((r) => r.method === "GET" && r.path.includes("check-runs")),
  ).toHaveLength(2)
  expect(recovered).toEqual([
    {
      event: "check_run",
      payload: {
        action: "rerequested",
        installation: { id: 91 },
        repository: { full_name: "owner/repo" },
        check_run: {
          id: 12,
          name: checkName,
          app: { id: 123 },
          external_id: "agent-git:7",
          head_sha: head,
        },
      },
    },
  ])
})

test("a failed repository does not prevent startup recovery in the next configured repository", async () => {
  const f = fixture({
    suiteChecks: [own],
    intercept: async (path) => {
      if (path.startsWith("/repos/broken/repo")) return Response.json({}, { status: 503 })
      if (path.endsWith("/pulls")) return Response.json([{ number: 7, head: { sha: head } }])
    },
  })
  const recovered: unknown[] = []
  await Effect.runPromise(
    f.app.recoverIdentityChecks(
      [
        { repository: "broken/repo", installationId: 90 },
        { repository: "owner/repo", installationId: 91 },
      ],
      (_event, payload) =>
        Effect.sync(() => {
          recovered.push(payload)
        }),
    ),
  )
  expect(recovered).toHaveLength(1)
})
