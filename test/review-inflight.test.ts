import { expect, test } from "bun:test"
import { Clock, Deferred, Effect, Fiber, Logger, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  AgentHarness,
  OpenCodeAgentHarness,
  TrustedAgentHarnessCatalog,
} from "../src/agent-harness"
import { GitHub } from "../src/github"
import {
  Automation,
  makePullRequestHarnessDefinitions,
  OpenCodeAutomationAdapter,
} from "../src/opencode"
import { SdkOpenCodeAdapter } from "../src/opencode/adapter"
import { startPullRequestAvailability } from "../src/pr-availability"
import { WorkflowStore } from "../src/store/contracts"
import { runJobIteration } from "../src/worker"
import { Workspace } from "../src/workspace"
import { WorkSignalLive } from "../src/work-signal"
import { catalogClient } from "./helpers/opencode-catalog"
import { changesRequestedReview, makeStoreLayer, samplePullRequestEvent } from "./store/harness"

const definitions = makePullRequestHarnessDefinitions({
  reviewerAgent: "pr-reviewer",
  fixerAgent: "pr-fixer",
  model: "openai/test",
  pollIntervalMs: 1,
  timeoutMs: 1000,
})

for (const kind of ["review", "fix"] as const) {
  test.each(["timeout", "transport", "abort", "output", "healthy"] as const)(
    `${kind} in flight: %s restores the last attempt only when the check closes the gate`,
    async (failure) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* WorkflowStore
            const clock = yield* Clock.Clock
            const now = () => new Date(clock.currentTimeMillisUnsafe())
            const claim = { workerId: "inflight", now: now(), leaseDurationMs: 60000 }
            yield* store.ingestPullRequest(
              {
                deliveryId: "inflight",
                event: "pull_request",
                action: "opened",
                payload: "{}",
                receivedAt: now(),
              },
              samplePullRequestEvent,
            )
            if (kind === "fix") {
              const review = yield* store.claimNextJob(claim)
              if (review === null) return yield* Effect.die("Review job is missing")
              yield* store.completeReviewJob({
                jobId: review.id,
                workerId: claim.workerId,
                completedAt: now(),
                review: changesRequestedReview,
                autoFix: true,
              })
              const publication = yield* store.claimNextPublication(claim)
              if (publication === null) return yield* Effect.die("Publication is missing")
              yield* store.completePublication({
                publicationId: publication.id,
                workerId: claim.workerId,
                completedAt: now(),
                outcome: "published",
              })
            }
            // Use the first two attempts before the reviewer stops while attempt 3 runs.
            for (let i = 0; i < 2; i++) {
              const work = yield* store.claimNextJob({ ...claim, kinds: [kind] })
              if (work === null) return yield* Effect.die("Job is missing")
              yield* store.rescheduleJob({
                jobId: work.id,
                workerId: claim.workerId,
                failedAt: now(),
                runAt: now(),
                maxAttempts: 3,
                error: "Earlier job failure",
              })
            }
            const started = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            let hung = false
            let probes = 0
            const sdk = {
              ...catalogClient(["pr-reviewer", "pr-fixer"], [{ providerID: "openai", id: "test" }]),
              listAgents: () =>
                Effect.suspend(() => {
                  probes++
                  return hung ? Effect.never : Effect.succeed(["pr-reviewer", "pr-fixer"])
                }),
              createSession: () => Effect.succeed({ id: "ses_inflight" }),
              setSessionEnvironment: () => Effect.void,
              promptSession: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    failure === "timeout" || failure === "abort"
                      ? Effect.never
                      : failure === "output"
                        ? Effect.void
                        : Effect.fail(new Error("fetch failed: ECONNRESET")),
                  ),
                ),
              subscribeEvents: () => Stream.never,
              activeSessions: () => Effect.succeed([]),
              sessionOutcome: () => Effect.succeed({ id: "ses_inflight", idle: true }),
              listMessages: () =>
                Effect.succeed([
                  { role: "assistant" as const, time: { created: 1, completed: 2 } },
                ]),
              generateText: () =>
                Effect.succeed(
                  JSON.stringify({ verdict: "timeout", summary: "Invalid verdict", findings: [] }),
                ),
              interruptSession: () =>
                Effect.suspend(() =>
                  failure === "abort" && hung
                    ? Effect.fail(new Error("fetch failed"))
                    : Effect.succeed(true),
                ),
            }
            const harness = new OpenCodeAgentHarness(
              new SdkOpenCodeAdapter(sdk),
              new TrustedAgentHarnessCatalog(Object.values(definitions)),
              { serverId: "test", endpointAlias: "test", pollIntervalMs: 1 },
            )
            const automation = new OpenCodeAutomationAdapter(harness, definitions)
            const monitors = yield* startPullRequestAvailability(automation, true, true)
            yield* TestClock.adjust(0)
            expect(yield* monitors.availableJobKinds).toEqual(["review", "fix"])
            const workspace = {
              directory: "/tmp/inflight",
              recovery: "none" as const,
              markCompleted: () => {},
            }
            const options = {
              ...claim,
              now,
              maxAttempts: 3,
              timeoutMs: 20000,
              cancellationPollIntervalMs: 100,
              agentBranchPrefixes: ["opencode/"],
              trustedAgentUsers: ["opencode-agent"],
              fixWorkEnabled: true,
              availableJobKinds: monitors.availableJobKinds,
              recheckAvailability: monitors.recheckAvailability,
            }
            const iteration = (availableJobKinds = monitors.availableJobKinds) =>
              runJobIteration({ ...options, availableJobKinds }).pipe(
                Effect.provideService(Automation, automation),
                Effect.provideService(AgentHarness, harness),
                Effect.provideService(Workspace, {
                  prepareReview: () => Effect.succeed(workspace),
                  prepareFix: () => Effect.succeed(workspace),
                  publishFix: () => Effect.die("Unexpected publish"),
                }),
                Effect.provideService(GitHub, {
                  fetchPullRequestSnapshot: () => Effect.die("Unexpected snapshot"),
                  publishReview: () => Effect.die("Unexpected publication"),
                  collectHeadEvidence: ({ target }) =>
                    Effect.succeed({
                      headSha: target.headSha,
                      ci: { state: "available", checks: [] },
                      sonar: {
                        state: "pass",
                        headSha: target.headSha,
                        unresolvedIssueCount: 0,
                        duplicatedNewLinesPercent: 0,
                        findings: [],
                      },
                      mergeability: { state: "mergeable" },
                    }),
                }),
              )
            const worker = yield* iteration().pipe(Effect.forkScoped)
            yield* Deferred.await(started)
            const before = probes
            hung = failure !== "healthy"
            yield* Deferred.succeed(release, undefined)
            yield* TestClock.adjust("16 seconds")
            const outage = failure === "timeout" || failure === "transport" || failure === "abort"
            expect(yield* Fiber.join(worker)).toBe(outage ? "retry" : "failed")
            expect(probes - before).toBe(failure === "output" ? 0 : 1)
            if (outage) {
              expect(yield* monitors.availableJobKinds).not.toContain(kind)
              expect(yield* iteration()).toBe("idle")
              hung = false
              yield* TestClock.adjust("3 minutes")
              if (failure === "abort")
                expect(
                  yield* store.claimNextJob({ ...claim, now: now(), kinds: [kind] }),
                ).toBeNull()
              expect(yield* iteration(Effect.succeed([]))).toBe("idle")
              const retried = yield* store.claimNextJob({ ...claim, now: now(), kinds: [kind] })
              expect(retried).toMatchObject({ attempt: 3 })
            } else {
              expect(yield* store.claimNextJob({ ...claim, now: now(), kinds: [kind] })).toBeNull()
            }
          }),
        ).pipe(
          Effect.provide(makeStoreLayer()),
          Effect.provide(WorkSignalLive),
          Effect.provide(TestClock.layer()),
          Effect.provide(Logger.layer([])),
        ),
      )
    },
  )
}
