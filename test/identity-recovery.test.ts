import { expect, test } from "bun:test"
import { Effect, Logger } from "effect"
import { checkName, fixture, head, payload } from "./helpers/identity"

import { makeIdentityCheckDispatcher } from "../src/github/identity-dispatch"

const own = {
  id: 12,
  name: checkName,
  app: { id: 123 },
  status: "in_progress",
  external_id: "agent-git:7",
}

test.each([false, true])(
  "recovery resumes the newest pending check across pages and supersedes older checks (newest first: %s)",
  async (newestFirst) => {
    const checks = [
      { ...own, id: 12 },
      ...Array.from({ length: 99 }, () => ({ ...own, status: "completed", id: 99 })),
      { ...own, id: 14 },
      { ...own, id: 13 },
    ]
    const f = fixture({
      suiteChecks: newestFirst ? checks.reverse() : checks,
      intercept: async (path) => {
        if (path.endsWith("/pulls")) return Response.json([{ number: 7, head: { sha: head } }])
      },
    })
    const recovered: unknown[] = []
    await Effect.runPromise(
      f.app.recoverIdentityChecks(
        [{ repository: "owner/repo", installationId: 91 }],
        (_event, payload) =>
          Effect.sync(() => {
            recovered.push(payload)
          }),
      ),
    )
    expect(recovered).toEqual([
      expect.objectContaining({ check_run: expect.objectContaining({ id: 14 }) }),
    ])
    expect(f.writes).toHaveLength(2)
    expect(
      f.writes.every((write) => write.status === "completed" && write.conclusion === "failure"),
    ).toBe(true)
    expect(f.writes.every((write) => JSON.stringify(write.output).includes("Superseded"))).toBe(
      true,
    )
    expect(
      f.requests
        .filter((r) => r.method === "PATCH")
        .map((r) => r.path)
        .sort(),
    ).toEqual(["/repos/owner/repo/check-runs/12", "/repos/owner/repo/check-runs/13"])
  },
)

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

test("a failed supersede write does not stop the newest check or later PRs recovering", async () => {
  const attempted: string[] = []
  const f = fixture({
    suiteChecks: [
      { ...own, id: 12 },
      { ...own, id: 14 },
      { ...own, id: 13 },
      { ...own, id: 20, external_id: "agent-git:8" },
    ],
    intercept: async (path, body) => {
      if (path.endsWith("/pulls"))
        return Response.json([7, 8].map((number) => ({ number, head: { sha: head } })))
      if (body.status === "completed") {
        attempted.push(path)
        return Response.json({ message: "unavailable" }, { status: 503 })
      }
    },
  })
  const recovered: unknown[] = []
  const logs: unknown[] = []
  await Effect.runPromise(
    f.app
      .recoverIdentityChecks(
        [{ repository: "owner/repo", installationId: 91 }],
        (_event, payload) =>
          Effect.sync(() => {
            recovered.push(payload)
          }),
      )
      .pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))]))),
  )
  expect(JSON.stringify(logs)).toContain('"checkId":12')
  expect(JSON.stringify(logs)).toContain('"checkId":13')
  expect(attempted).toEqual(["/repos/owner/repo/check-runs/12", "/repos/owner/repo/check-runs/13"])
  expect(recovered).toEqual([
    expect.objectContaining({ check_run: expect.objectContaining({ id: 14 }) }),
    expect.objectContaining({ check_run: expect.objectContaining({ id: 20 }) }),
  ])
})

test("scope closure leaves a real scanning check in progress and restart recovery reruns it", async () => {
  const scanning = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let scans = 0
  let status = "in_progress"
  const f = fixture({
    intercept: async (path, body, _signal, url) => {
      if (path.endsWith("/pulls")) return Response.json([{ number: 7, head: { sha: head } }])
      if (path.includes(`/commits/${head}/check-runs`)) {
        const response = Response.json({ total_count: 1, check_runs: [{ ...own, status }] })
        Object.defineProperty(response, "url", { value: url.toString() })
        return response
      }
      if (typeof body.status === "string") status = body.status
      if (path.includes("/compare/") && ++scans === 1) {
        scanning.resolve()
        await release.promise
      }
    },
  })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const dispatch = yield* makeIdentityCheckDispatcher(f.app)
        if (dispatch === undefined) throw new Error("dispatcher unavailable")
        yield* dispatch("pull_request", payload())
        yield* Effect.promise(() => scanning.promise)
      }).pipe(Effect.scoped),
    )
    expect(status).toBe("in_progress")
    expect(f.writes).toHaveLength(1)
    await Effect.runPromise(
      f.app.recoverIdentityChecks(
        [{ repository: "owner/repo", installationId: 91 }],
        (event, value) => f.app.checkAgentGitIdentity(event, value),
      ),
    )
    expect(scans).toBe(2)
    expect(f.writes.at(-1)?.conclusion).toBe("success")
  } finally {
    release.resolve()
  }
})

test("restart creates checks for heads dropped at the start cap, within the fresh budget", async () => {
  const missing = Array.from({ length: 30 }, (_, i) => ({
    number: 100 + ((i + 25) % 30),
    user: { login: "fork-author" },
    head: { sha: head },
  }))
  const options = {
    suiteChecks: [
      { ...own, status: "completed" },
      { ...own, app: { id: 999 }, external_id: "agent-git:100" },
    ],
    intercept: async (path: string) => {
      if (path.endsWith("/pulls"))
        return Response.json([
          { number: 7, user: { login: "existing" }, head: { sha: head } },
          ...missing,
          { number: 200, user: { login: "maintainer" }, head: { sha: head } },
        ])
    },
  }
  const before = fixture(options)
  for (let i = 0; i < 26; i++)
    await before.run("pull_request", {
      ...payload(),
      pull_request: { number: 100 + i, user: { login: "fork-author" }, head: { sha: head } },
    })
  expect(before.writes.filter((w) => w.status === "in_progress")).toHaveLength(25)
  const restarted = fixture(options)
  await Effect.runPromise(
    restarted.app.recoverIdentityChecks(
      [{ repository: "owner/repo", installationId: 91 }],
      (event, value) => restarted.app.checkAgentGitIdentity(event, value),
    ),
  )
  const starts = restarted.writes.filter((w) => w.status === "in_progress")
  expect(starts).toHaveLength(26)
  expect(starts.some((w) => w.external_id === "agent-git:7")).toBe(false)
  expect(starts.some((w) => w.external_id === "agent-git:125")).toBe(true)
  expect(starts.some((w) => w.external_id === "agent-git:124")).toBe(false)
  expect(starts.at(-1)?.external_id).toBe("agent-git:200")
  expect(restarted.writes.at(-1)?.conclusion).toBe("success")
})
