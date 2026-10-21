import { expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client/effect"
import { Deferred, Effect, Logger } from "effect"
import { HttpClient } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import { OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "../src/agent-harness"
import { makePullRequestHarnessDefinitions, OpenCodeAutomationAdapter } from "../src/opencode"
import { makeOpenCodeSdkClient, SdkOpenCodeAdapter } from "../src/opencode/adapter"
import { startPullRequestAvailability } from "../src/pr-availability"
import { WorkflowStore } from "../src/store/contracts"
import { runJobIteration } from "../src/worker"
import { kernelLayer, stubAdapters } from "./helpers/runtime"
import { samplePullRequestEvent } from "./store/harness"

test("hung HTTP transport closes the claim path and recovery keeps the first attempt", async () => {
  const logs: unknown[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const accepted = yield* Deferred.make<void>()
        // Keep the SDK and HTTP request path, with no OS socket or real-time race.
        const client = OpenCode.make({ baseUrl: "http://reviewer.test" }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() =>
              Deferred.succeed(accepted, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          ),
        )
        const definitions = makePullRequestHarnessDefinitions({
          reviewerAgent: "pr-reviewer",
          fixerAgent: "pr-fixer",
          model: "openai/test",
          pollIntervalMs: 1,
          timeoutMs: 1000,
        })
        const automation = new OpenCodeAutomationAdapter(
          new OpenCodeAgentHarness(
            new SdkOpenCodeAdapter(makeOpenCodeSdkClient(client)),
            new TrustedAgentHarnessCatalog([definitions.review]),
            { serverId: "test", endpointAlias: "test", pollIntervalMs: 1 },
          ),
          definitions,
        )
        let recovered = false
        const monitors = yield* startPullRequestAvailability(
          {
            ...automation,
            validateAvailability: () =>
              Effect.suspend(() =>
                recovered
                  ? Effect.void
                  : automation.validateAvailability({ fixWorkEnabled: false }),
              ),
          },
          true,
          false,
        )
        const store = yield* WorkflowStore
        const now = new Date(0)
        yield* store.ingestPullRequest(
          {
            deliveryId: "hung-http",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: now,
          },
          samplePullRequestEvent,
        )
        yield* Deferred.await(accepted)
        yield* TestClock.adjust("10 seconds")
        expect(yield* monitors.review.health).toMatchObject({
          status: "unreachable",
          reason: "timeout",
        })
        expect(
          yield* runJobIteration({
            workerId: "hung-http",
            now: () => now,
            leaseDurationMs: 60000,
            maxAttempts: 3,
            timeoutMs: 1000,
            cancellationPollIntervalMs: 100,
            agentBranchPrefixes: [],
            trustedAgentUsers: [],
            fixWorkEnabled: false,
            availableJobKinds: monitors.availableJobKinds,
          }),
        ).toBe("idle")
        recovered = true
        yield* TestClock.adjust("2 seconds")
        expect(yield* monitors.review.health).toEqual({ status: "available" })
        expect(
          yield* store.claimNextJob({
            workerId: "hung-http",
            now,
            leaseDurationMs: 60000,
            kinds: yield* monitors.availableJobKinds,
          }),
        ).toMatchObject({ attempt: 1 })
      }),
    ).pipe(
      Effect.provide(kernelLayer(":memory:")),
      Effect.provide(stubAdapters()),
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])),
    ),
  )
  expect(JSON.stringify(logs)).toContain("timed out")
  expect(JSON.stringify(logs)).toContain("operator restart")
})
