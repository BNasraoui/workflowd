import { expect, test } from "bun:test"
import { Effect } from "effect"
import { decodeGitHubEvent } from "../../src/github-event"

const repository = { id: 1, full_name: "owner/repo", name: "repo", owner: { login: "owner" } }
for (const kind of ["workflow_run", "check_suite"] as const) {
  test(`decodes ${kind} completions with exact repository and SHA`, async () => {
    const result = await Effect.runPromise(
      decodeGitHubEvent(kind, {
        action: "completed",
        installation: { id: 2 },
        repository,
        [kind]: {
          id: 3,
          head_sha: "a".repeat(40),
          conclusion: "failure",
          name: "CI",
          run_attempt: 2,
          updated_at: "2026-09-28T00:00:00Z",
        },
      }),
    )
    expect(result).toMatchObject({
      _tag: "CiCompletion",
      repository: "owner/repo",
      sha: "a".repeat(40),
      installationId: 2,
      source: kind,
      sourceId: 3,
      conclusion: "failure",
    })
  })
}
test("rejects malformed completion SHA", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      decodeGitHubEvent("workflow_run", {
        action: "completed",
        installation: { id: 2 },
        repository,
        workflow_run: {
          id: 3,
          head_sha: "wrong",
          conclusion: "success",
          name: "CI",
          run_attempt: 1,
          updated_at: "2026-09-28T00:00:00Z",
        },
      }),
    ),
  )
  expect(result._tag).toBe("Failure")
})
