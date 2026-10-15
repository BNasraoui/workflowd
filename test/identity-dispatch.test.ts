import { expect, test } from "bun:test"
import { Deferred, Effect, Queue, Schema } from "effect"
import { TestClock } from "effect/testing"
import type { GitHubPort } from "../src/github"
import { makeIdentityCheckDispatcher } from "../src/github/identity-dispatch"

const unused = () => Effect.die("Unexpected GitHub operation")
const github: GitHubPort = {
  publishReview: unused,
  fetchPullRequestSnapshot: unused,
  collectHeadEvidence: unused,
  checkAgentGitIdentity: unused,
}

test("recovery preserves an admitted webhook scan for the same target", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const recover = yield* Deferred.make<void>()
      const recovered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const started: string[] = []
      const completed: string[] = []
      const dispatch = yield* makeIdentityCheckDispatcher({
        ...github,
        identityCheckJobs: (_event, payload) =>
          Effect.gen(function* () {
            const source = yield* Schema.decodeUnknownEffect(Schema.String)(payload)
            return [
              {
                key: "owner/repo/7/head",
                run: Effect.gen(function* () {
                  started.push(source)
                  yield* Deferred.await(release)
                  completed.push(source)
                }),
              },
            ]
          }),
        recoverIdentityChecks: (_repos, submit) =>
          Effect.gen(function* () {
            yield* Deferred.await(recover)
            yield* submit("check_run", "recovery")
            yield* Deferred.succeed(recovered, undefined)
          }).pipe(Effect.orDie),
      })
      if (dispatch === undefined) throw new Error("dispatcher unavailable")
      yield* dispatch("pull_request", "webhook")
      yield* TestClock.adjust("1 millis")
      expect(started).toEqual(["webhook"])
      yield* Deferred.succeed(recover, undefined)
      yield* Deferred.await(recovered)
      yield* TestClock.adjust("1 millis")
      yield* Deferred.succeed(release, undefined)
      yield* TestClock.adjust("1 millis")
      expect(started).toEqual(["webhook"])
      expect(completed).toEqual(["webhook"])
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

test("recovery waits for capacity and eventually runs a recovered check", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const recover = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const completed: number[] = []
      const finished = yield* Queue.unbounded<number>()
      const recovered = yield* Deferred.make<void>()
      const dispatch = yield* makeIdentityCheckDispatcher({
        ...github,
        identityCheckJobs: (_event, payload) =>
          Effect.gen(function* () {
            const id = yield* Schema.decodeUnknownEffect(Schema.Number)(payload)
            return [
              {
                key: String(id),
                run: Deferred.await(release).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      completed.push(id)
                    }),
                  ),
                  Effect.andThen(Queue.offer(finished, id)),
                ),
              },
            ]
          }),
        recoverIdentityChecks: (_repos, submit) =>
          Deferred.await(recover).pipe(
            Effect.andThen(submit("check_run", 84)),
            Effect.andThen(Deferred.succeed(recovered, undefined)),
            Effect.orDie,
          ),
      })
      if (dispatch === undefined) throw new Error("dispatcher unavailable")
      for (let id = 0; id < 84; id++) yield* dispatch("pull_request", id)
      yield* Deferred.succeed(recover, undefined)
      yield* TestClock.adjust("1 millis")
      expect(completed).toEqual([])
      yield* Deferred.succeed(release, undefined)
      for (let i = 0; i < 84; i++) yield* Queue.take(finished)
      yield* TestClock.adjust("1 second")
      yield* Deferred.await(recovered)
      // A subsequent job is a barrier: recovery must have admitted its check first.
      yield* dispatch("pull_request", 85)
      while ((yield* Queue.take(finished)) !== 85) {
        /* drain */
      }
      expect(completed).toHaveLength(86)
      expect(completed).toContain(84)
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})

test("suite discovery runs one worker and retains at most 100 waiting suites", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      let started = 0
      let completed = 0
      const finished = yield* Queue.unbounded<number>()
      const dispatch = yield* makeIdentityCheckDispatcher({
        ...github,
        identityCheckJobs: (_event, payload) =>
          Effect.gen(function* () {
            const { check_suite } = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ check_suite: Schema.Struct({ id: Schema.Number }) }),
            )(payload)
            started++
            yield* Deferred.await(release)
            completed++
            yield* Queue.offer(finished, check_suite.id)
            return []
          }),
      })
      if (dispatch === undefined) throw new Error("dispatcher unavailable")
      for (let id = 0; id < 103; id++)
        yield* dispatch("check_suite", {
          repository: { full_name: "owner/repo" },
          check_suite: { id },
        })
      yield* TestClock.adjust("1 millis")
      expect(started).toBe(1)
      yield* Deferred.succeed(release, undefined)
      for (let i = 0; i < 101; i++) yield* Queue.take(finished)
      yield* dispatch("check_suite", {
        repository: { full_name: "owner/repo" },
        check_suite: { id: 103 },
      })
      while ((yield* Queue.take(finished)) !== 103) {
        /* drain */
      }
      expect(completed).toBe(102)
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})
