import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { AgentHarness } from "../src/agent-harness"
import { loadConfig } from "../src/config"
import { GitHub } from "../src/github"
import { Automation, OpenCodeAutomationError } from "../src/opencode"
import { runHookService, startHookService } from "../src/runtime"
import { WorkflowStoreLive } from "../src/store"
import { Workspace } from "../src/workspace"
import { WorkerHealth, WorkerHealthLive } from "../src/worker-health"
import { WorkSignalLive } from "../src/work-signal"
import {
  WorkflowStart,
  WorkflowStartValidationError,
  closedWorkflowStart,
} from "../src/qrspi/workflow-start"

const qrspiDefinition = {
  contractVersion: 1,
  definitionVersion: 1,
  stages: [
    {
      key: "questions",
      kind: "document",
      contract: { name: "qrspi.questions", contractVersion: 1 },
      activation: { mode: "enabled" },
      definitionVersion: 1,
      maxEncodedInputBytes: 16_384,
      producer: {
        harness: { name: "opencode", version: 1 },
        agent: "qrspi-questions",
        model: "openai/gpt-5.6-sol",
        timeoutMs: 60_000,
        retry: { maxAttempts: 3, backoffMs: 1_000 },
      },
      outputPolicy: {
        _tag: "Artifact",
        pathTemplate: "docs/qrspi/{ticketId}/01-questions.md",
        mediaType: "text/markdown",
      },
      reviewPolicy: { mode: "none" },
      humanGatePolicy: { mode: "none" },
    },
  ],
}

describe("runHookService startup", () => {
  test("validates OpenCode exactly once before listener or workers activate", async () => {
    let validations = 0
    let githubCalls = 0
    const loaded = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
      },
      { home: "/tmp" },
    )
    const config = {
      ...loaded,
      http: { ...loaded.http, port: 0 },
    }
    const StoreLive = WorkflowStoreLive.pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    )
    const TestAdapters = Layer.mergeAll(
      WorkSignalLive,
      WorkerHealthLive,
      Layer.succeed(GitHub, {
        fetchPullRequestSnapshot: () => {
          githubCalls += 1
          return Effect.die("must not fetch")
        },
        publishReview: () => {
          githubCalls += 1
          return Effect.die("must not publish")
        },
        collectHeadEvidence: () => Effect.die("must not collect evidence"),
      }),
      Layer.succeed(Automation, {
        validateAvailability: () =>
          Effect.sync(() => {
            validations += 1
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new OpenCodeAutomationError({
                  operation: "validate OpenCode availability",
                  cause: new Error("missing fixer agent"),
                  retryable: false,
                }),
              ),
            ),
          ),
        prepareReview: () => Effect.die("must not review"),
        prepareFix: () => Effect.die("must not fix"),
      }),
      Layer.succeed(AgentHarness, {
        describe: () => Effect.die("must not describe harness"),
        validateAvailability: () => Effect.die("must not validate harness"),
        prepare: () => Effect.die("must not prepare harness"),
        createSession: () => Effect.die("must not create session"),
        resumeSession: () => Effect.die("must not resume session"),
        abortSession: () => Effect.void,
      }),
      Layer.succeed(Workspace, {
        prepareReview: () => Effect.die("must not prepare review"),
        prepareFix: () => Effect.die("must not prepare fix"),
        publishFix: () => Effect.die("must not publish fix"),
      }),
    )

    const exit = await Effect.runPromise(
      Effect.exit(
        runHookService(config).pipe(Effect.provide(Layer.merge(StoreLive, TestAdapters))),
      ),
    )

    expect(exit._tag).toBe("Failure")
    expect(validations).toBe(1)
    expect(githubCalls).toBe(0)
  })

  test("composes workers and starts a healthy listener after validation", async () => {
    let validations = 0
    const loaded = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
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
    const StoreLive = WorkflowStoreLive.pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    )
    const TestAdapters = Layer.mergeAll(
      WorkSignalLive,
      WorkerHealthLive,
      Layer.succeed(GitHub, {
        fetchPullRequestSnapshot: () => Effect.die("unexpected fetch"),
        publishReview: () => Effect.die("unexpected publish"),
        collectHeadEvidence: () => Effect.die("unexpected evidence collection"),
      }),
      Layer.succeed(Automation, {
        validateAvailability: () =>
          Effect.sync(() => {
            validations += 1
          }),
        prepareReview: () => Effect.die("unexpected review"),
        prepareFix: () => Effect.die("unexpected fix"),
      }),
      Layer.succeed(AgentHarness, {
        describe: () => Effect.die("unexpected harness description"),
        validateAvailability: () => Effect.die("unexpected harness validation"),
        prepare: () => Effect.die("unexpected harness preparation"),
        createSession: () => Effect.die("unexpected session creation"),
        resumeSession: () => Effect.die("unexpected session resume"),
        abortSession: () => Effect.die("unexpected session abort"),
      }),
      Layer.succeed(Workspace, {
        prepareReview: () => Effect.die("unexpected review workspace"),
        prepareFix: () => Effect.die("unexpected fix workspace"),
        publishFix: () => Effect.die("unexpected fix publication"),
      }),
      Layer.succeed(
        WorkflowStart,
        closedWorkflowStart(
          new WorkflowStartValidationError({
            phase: "availability",
            reason: "unavailable_agent_model",
          }),
        ),
      ),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const health = yield* WorkerHealth
          const server = yield* startHookService(config)
          // Every lane reports `starting` until it completes an iteration, so
          // waiting for readiness is waiting for all four workers to run.
          yield* Effect.iterate(false, {
            while: (ready) => !ready,
            body: () =>
              health.report.pipe(
                Effect.map((lanes) => lanes.every((lane) => lane.status === "ok")),
                Effect.tap((ready) => (ready ? Effect.void : Effect.sleep(1))),
              ),
          }).pipe(
            Effect.timeoutFail({
              duration: 10_000,
              onTimeout: () => new Error("workers did not start"),
            }),
          )
          const response = yield* Effect.tryPromise(() =>
            fetch(`http://${server.hostname}:${server.port}/health`),
          )
          const readyResponse = yield* Effect.tryPromise(() =>
            fetch(`http://${server.hostname}:${server.port}/ready`),
          )
          const qrspiResponse = yield* Effect.tryPromise(() =>
            fetch(`http://${server.hostname}:${server.port}/workflows/qrspi`, {
              method: "POST",
              body: "{}",
              headers: { authorization: "Bearer kickoff-secret" },
            }),
          )
          return {
            health: {
              status: response.status,
              body: yield* Effect.promise(() => response.json()),
            },
            ready: {
              status: readyResponse.status,
              body: yield* Effect.promise(() => readyResponse.json()),
            },
            qrspi: {
              status: qrspiResponse.status,
              body: yield* Effect.promise(() => qrspiResponse.json()),
            },
          }
        }),
      ).pipe(Effect.provide(Layer.merge(StoreLive, TestAdapters))),
    )

    expect(validations).toBe(1)
    expect(result.health).toEqual({ status: 200, body: { status: "ok" } })
    expect(result.qrspi).toEqual({
      status: 503,
      body: { error: "WorkflowStartValidationError" },
    })
    expect(result.ready.status).toBe(200)
    expect(result.ready.body).toEqual({
      status: "ready",
      store: "ok",
      workers: ["job", "publication", "reconciliation", "command"].map((lane) => ({
        lane,
        status: "ok",
        completedIterations: expect.any(Number),
        consecutiveFailures: 0,
      })),
      terminalFailures: {
        queues: ["jobs", "publications", "commands", "reconciliations"].map((queue) => ({
          queue,
          failed: 0,
          quarantined: 0,
          oldestFailureAt: null,
        })),
        agentSessionsAwaitingOperator: 0,
      },
    })
  })
})
