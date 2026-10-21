import { expect, test } from "bun:test"
import { Agent, Model, OpenCode, Provider } from "@opencode-ai/client/effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Clock, Effect, Fiber, Layer, Logger } from "effect"
import { TestClock } from "effect/testing"
import { OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "../src/agent-harness"
import { loadConfig } from "../src/config"
import { TestJobCanaryLive } from "../src/kernel/test-job-canary"
import {
  Automation,
  makePullRequestHarnessDefinitions,
  OpenCodeAutomationAdapter,
} from "../src/opencode"
import { makeOpenCodeSdkClient, SdkOpenCodeAdapter } from "../src/opencode/adapter"
import { startHookService } from "../src/runtime"
import { agentGitTestEnvironment } from "./helpers/agent-git-config"
import { kernelLayer, stubAdapters } from "./helpers/runtime"
import { pullRequestPayload, signedRequest } from "./github-webhook"
import { WorkflowStore } from "../src/store/contracts"

for (const missingAgent of [false, true]) {
  test(`cold review catalogs do not stop serving (missing agent: ${missingAgent})`, async () => {
    let warm = false
    const paths: string[] = []
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        paths.push(path)
        const data = !warm
          ? []
          : path === "/api/agent"
            ? [Agent.Info.default(Agent.ID.make(missingAgent ? "general" : "pr-reviewer"))]
            : [
                Model.Info.default(
                  Provider.ID.make("zai-coding-plan"),
                  Model.ID.make("glm-5.3-flash"),
                ),
              ]
        return Response.json({
          data,
          location: {
            directory: "/tmp",
            project: { id: "test", directory: "/tmp", canonical: "/tmp" },
          },
        })
      },
    })
    const definitions = makePullRequestHarnessDefinitions({
      reviewerAgent: "pr-reviewer",
      fixerAgent: "pr-fixer",
      model: "zai-coding-plan/glm-5.3-flash",
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    })
    const client = OpenCode.make({ baseUrl: fake.url.toString() }).pipe(
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
    const loaded = await loadConfig(
      {
        ...agentGitTestEnvironment,
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "http://127.0.0.1:4096",
        WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
        WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
        WORKFLOWD_TEST_JOB_TOKEN: "canary-secret",
      },
      { home: "/tmp" },
    )
    const config = {
      ...loaded,
      http: { ...loaded.http, host: "127.0.0.1", port: 0 },
      worker: { ...loaded.worker, concurrency: 0, pollIntervalMs: 100 },
    }
    const database = kernelLayer(":memory:")
    const logs: unknown[] = []
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const startup = yield* startHookService(config).pipe(Effect.forkChild)
            yield* TestClock.adjust("31 seconds")
            const server = yield* Fiber.join(startup)
            const url = `http://${server.hostname}:${server.port}`
            const health = () =>
              Effect.tryPromise(() => fetch(`${url}/health`).then((r) => r.json()))
            // Advance daemon time beyond the old fatal startup deadline while the fake stays cold.
            yield* TestClock.adjust("31 seconds")
            expect(yield* health()).toMatchObject({
              status: "degraded",
              reviewAutomation: { status: "unavailable" },
            })
            const accepted = yield* Effect.tryPromise(() =>
              fetch(`${url}/workflows/test-jobs`, {
                method: "POST",
                headers: { authorization: "Bearer canary-secret" },
                body: JSON.stringify({ jobId: "during-warmup", value: "retained" }),
              }),
            )
            expect(accepted.status).toBe(202)
            const review = yield* Effect.tryPromise(() =>
              fetch(
                signedRequest(
                  "pull_request",
                  pullRequestPayload("example-owner/example"),
                  "during-warmup",
                  "secret",
                  `${url}/hooks/github`,
                ),
              ),
            )
            expect(review.status).toBe(202)
            yield* TestClock.adjust("1 second")
            warm = true
            yield* TestClock.adjust("30 seconds")
            expect(yield* health()).toMatchObject({
              reviewAutomation: { status: missingAgent ? "misconfigured" : "available" },
            })
            const status = yield* Effect.tryPromise(() =>
              fetch(`${url}/workflows/test-jobs/during-warmup`, {
                headers: { authorization: "Bearer canary-secret" },
              }).then((r) => r.json()),
            )
            expect(status).toMatchObject({
              status: "succeeded",
              result: { kind: "echo", value: "retained" },
            })
            const store = yield* WorkflowStore
            const job = yield* store.claimNextJob({
              workerId: "test",
              now: new Date(yield* Clock.currentTimeMillis),
              leaseDurationMs: 60_000,
            })
            expect(job?.repositoryFullName).toBe("example-owner/example")
          }),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              database,
              stubAdapters(),
              TestJobCanaryLive.pipe(Layer.provide(database)),
              Layer.succeed(Automation, automation),
            ),
          ),
          Effect.provide(TestClock.layer()),
          Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])),
        ),
      )
      expect(paths).toContain("/api/agent")
      expect(paths).toContain("/api/model")
      expect(
        logs.filter((entry) => JSON.stringify(entry).includes("Review automation unavailable")),
      ).toHaveLength(1)
      if (missingAgent) expect(JSON.stringify(logs)).toContain("Review automation misconfigured")
    } finally {
      await fake.stop(true)
    }
  }, 10_000)
}
