import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { makeIdentityCheckDispatcher } from "../src/github/identity-dispatch"
import { fixture, payload, head, base, checkName, commit, blocked } from "./helpers/identity"

const rerun = {
  ...payload("rerequested"),
  check_run: {
    id: 12,
    name: checkName,
    app: { id: 123 },
    external_id: "agent-git:7",
    head_sha: head,
  },
}

test.each([false, true])(
  "late success cannot overwrite a newer rerun failure (dispatcher: %s)",
  async (dispatch) => {
    const late = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<void>()
    const writes: string[] = []
    let retargeted = false
    let snapshots = 0
    const f = fixture({
      baseSha: () => (retargeted ? "d".repeat(40) : base),
      afterSnapshot: async () => {
        if (++snapshots === 2) {
          late.resolve()
          await release.promise
        }
      },
      intercept: async (path, body) => {
        if (path.includes("/compare/") && retargeted)
          return Response.json({ total_commits: 1, commits: [commit(head, blocked)] })
        if (path.includes("/check-runs")) {
          writes.push(String(body.conclusion ?? body.status))
          if (body.conclusion === "failure") failed.resolve()
          return Response.json({ id: 12 })
        }
      },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const submit = dispatch ? yield* makeIdentityCheckDispatcher(f.app) : undefined
        const run = () =>
          submit ? submit("check_run", rerun) : f.app.checkAgentGitIdentity("check_run", rerun)
        const a = yield* run().pipe(Effect.forkChild)
        yield* Effect.promise(() => late.promise)
        retargeted = true
        const b = yield* run().pipe(Effect.forkChild)
        // Let B reach the old completion boundary; releasing A must never leave success last.
        if (!dispatch) yield* Effect.promise(() => failed.promise).pipe(Effect.timeout("1 second"))
        else yield* Effect.yieldNow
        release.resolve()
        yield* Effect.promise(() => failed.promise).pipe(Effect.timeout("1 second"))
        yield* Effect.promise(() => Promise.resolve())
        yield* Fiber.await(a)
        expect(writes.at(-1)).toBe("failure")
        expect(writes).not.toContain("success")
        yield* Effect.asVoid(Effect.all([Fiber.await(a), Fiber.await(b)]))
      }).pipe(Effect.scoped),
    )
  },
)

test("superseded snapshot cannot complete a check run another PR scan has started", async () => {
  const snapshot = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let reads = 0
  const f = fixture({
    intercept: async (path) => {
      if (path.endsWith("/pulls/7") && ++reads === 2) {
        snapshot.resolve()
        await release.promise
      }
      return undefined
    },
  })
  const old = Effect.runFork(f.app.checkAgentGitIdentity("check_run", rerun))
  await snapshot.promise
  // A shared check id must be fenced even across distinct queue keys.
  await f.run("check_run", {
    ...rerun,
    check_run: { ...rerun.check_run, external_id: "agent-git:8" },
  })
  const completed = f.writes.filter((w) => w.status === "completed").length
  release.resolve()
  await Effect.runPromise(Fiber.await(old))
  expect(f.writes.filter((w) => w.status === "completed")).toHaveLength(completed)
})

test.each([false, true])(
  "drains an already-issued write even when the client ignores abort (dispatcher: %s)",
  async (dispatch) => {
    const late = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const writes: string[] = []
    let retargeted = false
    const f = fixture({
      baseSha: () => (retargeted ? "d".repeat(40) : base),
      intercept: async (path, body, signal) => {
        if (path.includes("/compare/") && retargeted)
          return Response.json({ total_commits: 1, commits: [commit(head, blocked)] })
        if (!path.includes("/check-runs")) return
        if (body.conclusion === "success") {
          signal?.addEventListener("abort", () => cancelled.resolve(), { once: true })
          late.resolve()
          await release.promise
        }
        writes.push(String(body.conclusion ?? body.status))
        if (body.conclusion === "failure") failed.resolve()
        return Response.json({ id: 12 })
      },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const submit = dispatch ? yield* makeIdentityCheckDispatcher(f.app) : undefined
        const run = () =>
          submit ? submit("check_run", rerun) : f.app.checkAgentGitIdentity("check_run", rerun)
        yield* run().pipe(Effect.forkChild)
        yield* Effect.promise(() => late.promise)
        retargeted = true
        yield* run().pipe(Effect.forkChild)
        yield* Effect.promise(() => cancelled.promise)
        yield* TestClock.adjust("1 millis")
        try {
          expect(writes).toEqual(["in_progress"])
        } finally {
          release.resolve()
        }
        yield* Effect.promise(() => failed.promise)
        expect(writes.at(-1)).toBe("failure")
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    )
  },
)
