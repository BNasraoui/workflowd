import { expect, test } from "bun:test"
import { Effect } from "effect"
import { checkName, fixture, head, payload } from "./helpers/identity"

test.each([{ association: "MEMBER" }, { headRepository: "owner/repo" }])(
  "reruns derive trust from the PR API (%j)",
  async (trust) => {
    const f = fixture({ author: () => "maintainer", ...trust })
    for (let number = 1; number <= 30; number++)
      await f.run("check_run", {
        ...payload("rerequested"),
        check_run: {
          id: number,
          name: checkName,
          app: { id: 123 },
          external_id: `agent-git:${number}`,
          head_sha: head,
        },
      })
    expect(f.writes.filter((w) => w.conclusion === "success")).toHaveLength(30)
  },
)

test("client-supplied trusted flags cannot exempt fork authors", async () => {
  const f = fixture()
  for (let number = 1; number <= 30; number++)
    await f.run("pull_request", {
      ...payload(),
      trusted: true,
      pull_request: { ...payload().pull_request, number, trusted: true },
    })
  expect(f.writes.filter((w) => w.status === "in_progress")).toHaveLength(25)
})

test.each([
  { author_association: "OWNER", head: { sha: head } },
  { author_association: "NONE", head: { sha: head, repo: { full_name: "owner/repo" } } },
])("recovery lists all trusted PR checks beyond the author read share (%j)", async (trust) => {
  const pulls = Array.from({ length: 150 }, (_, i) => ({
    number: i + 1,
    user: { login: "maintainer" },
    ...trust,
  }))
  const f = fixture({
    suiteChecks: [],
    intercept: async (path) => {
      if (path.endsWith("/pulls")) return Response.json(pulls)
    },
  })
  let recovered = 0
  await Effect.runPromise(
    f.app.recoverIdentityChecks([{ repository: "owner/repo", installationId: 91 }], () =>
      Effect.sync(() => {
        recovered++
      }),
    ),
  )
  expect(recovered).toBe(150)
})
