import { Effect, Schedule, Schema } from "effect"
import type { PrRepositories } from "../pr-automation-config"
import type { GitHubPort } from "../github"
import { makeIdentityWork } from "./identity-work"

const SuiteKey = Schema.Struct({
  repository: Schema.Struct({ full_name: Schema.String }),
  check_suite: Schema.Struct({ id: Schema.Number }),
})

// Deliveries are already stored. Resolve PR events without I/O; suite expansion
// has its own bounded worker so a flood cannot retain unbounded webhook bodies.
export const makeIdentityCheckDispatcher = Effect.fn("GitIdentity.dispatcher")(function* (
  github: GitHubPort | undefined,
  repositories: PrRepositories = [],
) {
  const check = github?.checkAgentGitIdentity
  const jobsForEvent = github?.identityCheckJobs
  if (github === undefined || check === undefined) return undefined
  const submit = yield* makeIdentityWork()
  const suites = yield* makeIdentityWork(1, 100)
  const resolve = Effect.fn(function* (event: string, payload: unknown) {
    const jobs =
      jobsForEvent === undefined
        ? [{ key: "legacy", run: check(event, payload) }]
        : yield* jobsForEvent(event, payload)
    for (const job of jobs) {
      const accepted = yield* submit({
        ...job,
        run: job.run.pipe(Effect.catch(() => Effect.logError("Git identity check unavailable"))),
      })
      if (!accepted) yield* Effect.logWarning("Git identity waiting set full; redeliver webhook")
    }
  })
  if (github.recoverIdentityChecks !== undefined && jobsForEvent !== undefined) {
    yield* github
      .recoverIdentityChecks(repositories, (event, payload) =>
        Effect.gen(function* () {
          const jobs = yield* jobsForEvent(event, payload)
          for (const job of jobs)
            yield* submit(job, false).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (accepted) => accepted,
              }),
            )
        }),
      )
      .pipe(Effect.forkScoped)
  }
  return (event: string, payload: unknown) =>
    Effect.gen(function* () {
      if (event === "check_suite") {
        const value = yield* Schema.decodeUnknownEffect(SuiteKey)(payload)
        const accepted = yield* suites({
          key: `${value.repository.full_name}/${value.check_suite.id}`,
          run: resolve(event, payload).pipe(
            Effect.catch(() => Effect.logError("Git identity suite discovery unavailable")),
          ),
        })
        if (!accepted)
          yield* Effect.logWarning("Git identity suite waiting set full; redeliver webhook")
      } else yield* resolve(event, payload)
    }).pipe(Effect.catch(() => Effect.logError("Git identity check unavailable")))
})
