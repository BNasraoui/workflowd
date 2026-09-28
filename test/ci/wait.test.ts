import { expect, test } from "bun:test"
import { waitCi } from "../../src/ci/wait"
const target = { repository: "owner/repo", sha: "a".repeat(40) }
test("wait reads durable state first and replays from its sequence", async () => {
  const paths: string[] = []
  const result = await waitCi(
    { ...target, baseUrl: "http://localhost", token: "test", timeoutMs: 1000 },
    {
      fetch: async (url) => {
        paths.push(String(url))
        return Response.json(
          paths.length === 1
            ? { ...target, sequence: 41, conclusion: "pending", failingJobs: [] }
            : [{ ...target, sequence: 42, conclusion: "failure", failingJobs: ["lint"] }],
        )
      },
      heartbeat: () => {},
    },
  )
  expect(result.conclusion).toBe("failure")
  expect(result.failingJobs).toEqual(["lint"])
  expect(paths[0]).toContain("/ci/state?")
  expect(paths[1]).toContain("after=41")
})
test("terminal state avoids subscription; mismatched target is refused", async () => {
  let calls = 0
  const fetch = async () => {
    calls++
    return Response.json({ ...target, sequence: 1, conclusion: "success", failingJobs: [] })
  }
  expect(
    (
      await waitCi(
        { ...target, baseUrl: "http://localhost", token: "test", timeoutMs: 1000 },
        { fetch, heartbeat: () => {} },
      )
    ).conclusion,
  ).toBe("success")
  expect(calls).toBe(1)
  await expect(
    waitCi(
      { ...target, baseUrl: "http://localhost", token: "test", timeoutMs: 1000 },
      {
        fetch: async () =>
          Response.json({
            ...target,
            sha: "b".repeat(40),
            sequence: 1,
            conclusion: "success",
            failingJobs: [],
          }),
        heartbeat: () => {},
      },
    ),
  ).rejects.toThrow("target")
})
test("safe deadline aborts a silent subscription", async () => {
  await expect(
    waitCi(
      { ...target, baseUrl: "http://localhost", token: "test", timeoutMs: 10 },
      {
        fetch: async (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
              once: true,
            }),
          ),
        heartbeat: () => {},
      },
    ),
  ).rejects.toThrow("timeout")
})
