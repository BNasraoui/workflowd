import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Logger } from "effect"
import { TestClock } from "effect/testing"
import { createHmac } from "node:crypto"
import { loadConfig } from "../src/config"
import { InstallationGuard } from "../src/installation-guard"
import { runKernelJobIteration } from "../src/kernel/job-runner"
import { KernelJobStore } from "../src/kernel/job-store"
import { TestJobCanary } from "../src/kernel/test-job-canary"
import { OpenCodeAutomationError } from "../src/opencode"
import {
  WorkflowStart,
  WorkflowStartValidationError,
  closedWorkflowStart,
} from "../src/qrspi/workflow-start"
import { RemoteCoordinator } from "../src/remote/coordinator"
import { startHookService } from "../src/runtime"
import { WorkflowStore } from "../src/store/contracts"
import { pullRequestPayload, signedRequest } from "./github-webhook"
import { agentGitTestEnvironment } from "./helpers/agent-git-config"
import { arrangeDelivery } from "./kernel/job-store-harness"

import { automationStub, kernelLayer, qrspiDefinition, stubAdapters } from "./helpers/runtime"
describe("runHookService startup", () => {
  test("applies the configured PR repository allowlist to signed webhooks", async () => {
    const loaded = await loadConfig(
      {
        ...agentGitTestEnvironment,
        GITHUB_APP_ID: "123",
        WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
        WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
      },
      { home: "/tmp" },
    )
    const config = {
      ...loaded,
      http: { ...loaded.http, host: "127.0.0.1", port: 0 },
      worker: { ...loaded.worker, concurrency: 0, pollIntervalMs: 60_000 },
      workerIdentity: {
        directory: "/tmp/worker-identities",
        socket: "/tmp/worker.sock",
        policies: [
          {
            name: "worker",
            repository: "worker/repo",
            installationId: 92,
            permissions: { contents: "read" as const },
          },
        ],
      },
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startHookService(config)
          const url = `http://${server.hostname}:${server.port}/hooks/github`
          for (const [repository, expected] of [
            ["example-owner/example", { status: "enqueued", generation: 1 }],
            ["foreign/repository", { status: "ignored", reason: "repository-not-configured" }],
          ] as const) {
            const response = yield* Effect.tryPromise(() =>
              fetch(
                signedRequest(
                  "pull_request",
                  pullRequestPayload(repository),
                  repository,
                  "secret",
                  url,
                ),
              ),
            )
            expect(response.status).toBe(202)
            expect(yield* Effect.tryPromise(() => response.json())).toEqual(expected)
          }

          for (const [id, reason] of [
            [92, "installation-not-configured"],
            [999, "installation-not-configured"],
          ] as const) {
            const response = yield* Effect.tryPromise(() =>
              fetch(
                signedRequest(
                  "push",
                  JSON.stringify({ installation: { id } }),
                  `push-${id}`,
                  "secret",
                  url,
                ),
              ),
            )
            expect(response.status).toBe(202)
            expect(yield* Effect.tryPromise(() => response.json())).toEqual({
              status: "ignored",
              reason,
            })
          }
          const store = yield* WorkflowStore
          const claim = { workerId: "test", now: new Date(), leaseDurationMs: 60_000 }
          const job = yield* store.claimNextJob(claim)
          expect(job?.repositoryFullName).toBe("example-owner/example")
          expect(yield* store.claimNextJob(claim)).toBeNull()
        }),
      ).pipe(Effect.provide(Layer.merge(kernelLayer(":memory:"), stubAdapters()))),
    )
  })

  test("starts local HTTP while remote coordination is unavailable and recovers later", async () => {
    let guardPasses = 0
    let guardEvents = 0
    const loaded = await loadConfig(
      {
        ...agentGitTestEnvironment,
        GITHUB_APP_ID: "123",
        WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
        WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
        WORKFLOWD_REMOTE_COORDINATOR_ENABLED: "true",
        WORKFLOWD_NATS_SERVERS: "nats://127.0.0.1:1",
        WORKFLOWD_NATS_TOKEN: "test-token",
      },
      { home: "/tmp" },
    )
    const config = {
      ...loaded,
      http: { ...loaded.http, port: 0 },
      worker: { ...loaded.worker, concurrency: 0, pollIntervalMs: 60_000 },
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const brokerAvailable = yield* Deferred.make<void>()
          const allowGuard = yield* Deferred.make<void>()
          const guardReconciled = yield* Deferred.make<void>()
          const recovered = yield* Deferred.make<void>()
          const coordinator = {
            ensure: Deferred.await(brokerAvailable),
            dispatchIteration: Deferred.succeed(recovered, undefined).pipe(
              Effect.as("idle" as const),
            ),
            resultIteration: Effect.succeed("idle" as const),
          }
          const adapters = Layer.mergeAll(
            Logger.layer([Logger.make(() => undefined)]),
            stubAdapters(),
            Layer.succeed(RemoteCoordinator, coordinator),
            Layer.succeed(InstallationGuard, {
              reconcile: () =>
                Deferred.await(allowGuard).pipe(
                  Effect.map(() => {
                    guardPasses++
                    return true
                  }),
                  Effect.tap(() => Deferred.succeed(guardReconciled, undefined)),
                ),
              runWebhooks: Effect.never,
              health: () =>
                Effect.succeed({
                  lastSuccessfulReconciliationAt: null,
                  undecodableInstallations: 0,
                  status: "degraded",
                }),
              handle: () =>
                Effect.sync(() => {
                  guardEvents++
                  return "accepted" as const
                }),
            }),
          )
          const started = yield* startHookService(config).pipe(
            Effect.provide(Layer.merge(kernelLayer(":memory:"), adapters)),
          )
          const health = yield* Effect.tryPromise(() =>
            fetch(`http://${started.hostname}:${started.port}/health`),
          )
          // HTTP responds while the guard is held; waiting for reconciliation would time out.
          expect(health.status).toBe(200)
          expect(guardPasses).toBe(0)
          yield* Deferred.succeed(allowGuard, undefined)
          yield* Deferred.await(guardReconciled)
          expect(guardPasses).toBe(1)
          const body = JSON.stringify({ action: "created" })
          const guarded = yield* Effect.tryPromise(() =>
            fetch(`http://${started.hostname}:${started.port}/hooks/github`, {
              method: "POST",
              body,
              headers: {
                "x-github-delivery": "guard-runtime",
                "x-github-event": "installation",
                "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`,
              },
            }),
          )
          expect(guarded.status).toBe(202)
          expect(guardEvents).toBe(1)
          yield* Deferred.succeed(brokerAvailable, undefined)
          yield* Deferred.await(recovered)
        }),
      ),
    )
  })

  test("starts one kernel job supervisor and immediately processes ready work", async () => {
    let kernelIterations = 0
    const loaded = await loadConfig(
      {
        ...agentGitTestEnvironment,
        GITHUB_APP_ID: "123",
        WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
        WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
      },
      { home: "/tmp" },
    )
    const config = {
      ...loaded,
      http: { ...loaded.http, port: 0 },
      worker: { ...loaded.worker, concurrency: 3, pollIntervalMs: 60_000 },
    }
    const TestAdapters = stubAdapters()

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* KernelJobStore
          const delivery = yield* arrangeDelivery("startup-kernel-job", {
            kind: "echo",
            value: "ready",
          })
          yield* jobs.enqueueFromDelivery({ ...delivery, runAt: new Date(0) })
          const waiting = yield* Deferred.make<void>()
          yield* startHookService(config, (worker) => {
            if (worker !== "kernel-job") return Effect.void
            kernelIterations += 1
            return kernelIterations === 2 ? Deferred.succeed(waiting, undefined) : Effect.void
          })
          yield* Deferred.await(waiting)
          yield* Effect.sleep(10)
          return yield* jobs.readJob("startup-kernel-job")
        }),
      ).pipe(Effect.provide(Layer.merge(kernelLayer(":memory:"), TestAdapters))),
    )

    expect(result?.state).toBe("succeeded")
    expect(kernelIterations).toBe(2)
  })

  test("kernel supervisor polls a scheduled transient retry on the worker interval", async () => {
    const loaded = await loadConfig(
      {
        ...agentGitTestEnvironment,
        GITHUB_APP_ID: "123",
        WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
        WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
      },
      { home: "/tmp" },
    )
    const config = {
      ...loaded,
      http: { ...loaded.http, port: 0 },
      worker: { ...loaded.worker, concurrency: 1, pollIntervalMs: 10 },
    }
    const TestAdapters = stubAdapters()

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* KernelJobStore
          const delivery = yield* arrangeDelivery("supervised-kernel-retry", {
            kind: "echo",
            value: "eventual",
          })
          yield* jobs.enqueueFromDelivery({ ...delivery, runAt: new Date(0) })
          const failedAt = new Date()
          yield* runKernelJobIteration({
            workerId: "failing-worker",
            now: () => failedAt,
            leaseDurationMs: 60_000,
            retryDelayMs: 50,
            execute: () => Effect.fail(new Error("injected transient failure")),
          })
          const succeeded = yield* Deferred.make<void>()
          yield* startHookService(config)
          const waiter = yield* jobs.readJob("supervised-kernel-retry").pipe(
            Effect.flatMap((job) =>
              job?.state === "succeeded" ? Deferred.succeed(succeeded, undefined) : Effect.void,
            ),
            Effect.andThen(Effect.sleep(1)),
            Effect.forever,
            Effect.forkScoped,
          )
          yield* Effect.race(
            Deferred.await(succeeded),
            Effect.sleep(500).pipe(Effect.as("timeout")),
          )
          yield* Fiber.interrupt(waiter)
          return yield* jobs.readJob("supervised-kernel-retry")
        }),
      ).pipe(Effect.provide(Layer.merge(kernelLayer(":memory:"), TestAdapters))),
    )

    expect(outcome?.state).toBe("succeeded")
  })

  test("keeps serving when review configuration is invalid", async () => {
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
      },
      { home: "/tmp" },
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startHookService({ ...loaded, http: { ...loaded.http, port: 0 } })
          yield* TestClock.adjust("1 second")
          const health = yield* Effect.tryPromise(() =>
            fetch(`http://${server.hostname}:${server.port}/health`).then((r) => r.json()),
          )
          expect(health).toMatchObject({ reviewAutomation: { status: "misconfigured" } })
        }),
      ).pipe(
        Effect.provide(
          Layer.merge(
            kernelLayer(":memory:"),
            stubAdapters(
              automationStub(() =>
                Effect.fail(
                  new OpenCodeAutomationError({
                    operation: "validate OpenCode availability",
                    cause: new Error("missing fixer agent"),
                    retryable: false,
                  }),
                ),
              ),
            ),
          ),
        ),
        Effect.provide(TestClock.layer()),
        Effect.provide(Logger.layer([])),
      ),
    )
  })

  test.each([0, 1])("starts after %i unavailable checks", async (failures) => {
    let validations = 0
    const observedWorkers = new Set<string>()
    const loaded = await loadConfig(
      {
        ...agentGitTestEnvironment,
        GITHUB_APP_ID: "123",
        WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
        WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
        WORKFLOWD_TEST_JOB_TOKEN: "test-job-secret",
        WORKFLOWD_QRSPI_TOKEN: "kickoff-secret",
        WORKFLOWD_QRSPI_INSTALLATION_ID: "91",
        WORKFLOWD_QRSPI_REPOSITORY_ID: "42",
        WORKFLOWD_QRSPI_REPOSITORY: "example-owner/example",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID: "workspace-42",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE: "/tmp",
        WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify(qrspiDefinition),
      },
      { home: "/tmp" },
    )
    const config = {
      ...loaded,
      http: { ...loaded.http, port: 0 },
      worker: { ...loaded.worker, pollIntervalMs: 60_000 },
    }
    const TestAdapters = Layer.mergeAll(
      stubAdapters(
        automationStub(() =>
          Effect.suspend(() => {
            validations += 1
            return validations <= failures
              ? Effect.fail(
                  new OpenCodeAutomationError({
                    operation: "validate OpenCode availability",
                    cause: new Error(
                      "Unavailable OpenCode integration: agent pr-reviewer, model zai-coding-plan/glm-5.3-flash",
                    ),
                    retryable: true,
                  }),
                )
              : Effect.void
          }),
        ),
      ),
      Layer.succeed(
        WorkflowStart,
        closedWorkflowStart(
          new WorkflowStartValidationError({
            phase: "availability",
            reason: "unavailable_agent_model",
          }),
        ),
      ),
      Layer.succeed(TestJobCanary, {
        submit: (input) =>
          Effect.succeed({ jobId: input.jobId, status: "pending", newlyEnqueued: true }),
        status: (jobId) => Effect.succeed({ jobId, status: "pending" }),
      }),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const allWorkersObserved = yield* Deferred.make<void>()
          const startup = yield* startHookService(config, (worker) =>
            Effect.gen(function* () {
              observedWorkers.add(worker)
              if (observedWorkers.size === 5) {
                yield* Deferred.succeed(allWorkersObserved, undefined)
              }
            }),
          ).pipe(Effect.forkChild)
          yield* TestClock.adjust("2 seconds")
          const server = yield* Fiber.join(startup)
          yield* Deferred.await(allWorkersObserved)
          const response = yield* Effect.tryPromise(() =>
            fetch(`http://${server.hostname}:${server.port}/health`),
          )
          const qrspiResponse = yield* Effect.tryPromise(() =>
            fetch(`http://${server.hostname}:${server.port}/workflows/qrspi`, {
              method: "POST",
              body: "{}",
              headers: { authorization: "Bearer kickoff-secret" },
            }),
          )
          const testJobResponse = yield* Effect.tryPromise(() =>
            fetch(`http://${server.hostname}:${server.port}/workflows/test-jobs`, {
              method: "POST",
              body: '{"jobId":"runtime-canary","value":true}',
              headers: { authorization: "Bearer test-job-secret" },
            }),
          )
          return {
            health: {
              status: response.status,
              body: yield* Effect.promise(() => response.json()),
            },
            qrspi: {
              status: qrspiResponse.status,
              body: yield* Effect.promise(() => qrspiResponse.json()),
            },
            testJob: {
              status: testJobResponse.status,
              body: yield* Effect.promise(() => testJobResponse.json()),
            },
          }
        }),
      ).pipe(
        Effect.provide(Layer.merge(kernelLayer(":memory:"), TestAdapters)),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(validations).toBe(failures + 1)
    expect(observedWorkers).toEqual(
      new Set(["job", "kernel-job", "publication", "reconciliation", "command"]),
    )
    expect(result).toEqual({
      health: {
        status: 200,
        body: {
          status: "degraded",
          reviewAutomation: { status: "available" },
          installationGuard: {
            lastSuccessfulReconciliationAt: null,
            undecodableInstallations: 0,
            status: "degraded",
          },
        },
      },
      qrspi: { status: 503, body: { error: "WorkflowStartValidationError" } },
      testJob: { status: 202, body: { jobId: "runtime-canary", status: "pending" } },
    })
  })
})
