import { expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client/effect"
import { Effect, Logger } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import { OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "../src/agent-harness"
import { makePullRequestHarnessDefinitions, OpenCodeAutomationAdapter } from "../src/opencode"
import { makeOpenCodeSdkClient, SdkOpenCodeAdapter } from "../src/opencode/adapter"
import { startReviewAvailability } from "../src/review-availability"
import { WorkSignalLive } from "../src/work-signal"

test("an HTTP server accepting catalog reads without replying reports timeout and recovers", async () => {
  let accept!: () => void
  const accepted = new Promise<void>((resolve) => {
    accept = resolve
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      accept()
      return new Promise<Response>(() => {})
    },
  })
  const definitions = makePullRequestHarnessDefinitions({
    reviewerAgent: "pr-reviewer",
    fixerAgent: "pr-fixer",
    model: "openai/test",
    pollIntervalMs: 1,
    timeoutMs: 1000,
  })
  const client = OpenCode.make({ baseUrl: server.url.toString() }).pipe(
    Effect.provide(FetchHttpClient.layer),
  )
  const automation = new OpenCodeAutomationAdapter(
    new OpenCodeAgentHarness(
      new SdkOpenCodeAdapter(makeOpenCodeSdkClient(client)),
      new TrustedAgentHarnessCatalog([definitions.review]),
      { serverId: "test", endpointAlias: "test", pollIntervalMs: 1 },
    ),
    definitions,
  )
  let recovered = false
  const logs: unknown[] = []
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const monitor = yield* startReviewAvailability(
            Effect.suspend(() =>
              recovered ? Effect.void : automation.validateAvailability({ fixWorkEnabled: false }),
            ),
          )
          // Do not advance virtual time until the OS socket has accepted the read.
          yield* Effect.promise(() => accepted)
          yield* TestClock.adjust("10 seconds")
          expect(yield* monitor.health).toMatchObject({ status: "unreachable", reason: "timeout" })
          expect(yield* monitor.whenAvailable(Effect.succeed("claimed"))).toBe("idle")
          recovered = true
          yield* TestClock.adjust("2 seconds")
          expect(yield* monitor.health).toEqual({ status: "available" })
        }),
      ).pipe(
        Effect.provide(WorkSignalLive),
        Effect.provide(TestClock.layer()),
        Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])),
      ),
    )
    expect(JSON.stringify(logs)).toContain("timed out")
    expect(JSON.stringify(logs)).toContain("operator restart")
  } finally {
    await server.stop(true)
  }
}, 5000)
