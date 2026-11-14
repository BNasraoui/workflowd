import { expect, test } from "bun:test"
import { Effect } from "effect"
import { routeRequest } from "../../src/http"
import { WorkSignalLive } from "../../src/work-signal"
import { WorkflowStoreLive } from "../../src/store"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Layer } from "effect"
import { loadConfig } from "../../src/config"
import { startHookService } from "../../src/runtime"
import { AgentRunIngress } from "../../src/kernel/agent-run-ingress"
import { AgentRunWatchdog } from "../../src/kernel/agent-run-watchdog"
import { kernelLayer, stubAdapters } from "../helpers/runtime"
import { agentGitTestEnvironment } from "../helpers/agent-git-config"
import { ExecutionDiscovery } from "../../src/execution-capabilities"

test("started runtime exposes native control under its configured controller token", async () => {
  const loaded = await loadConfig(
    {
      ...agentGitTestEnvironment,
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY_PATH: "/tmp/fixture-key",
      GITHUB_WEBHOOK_SECRET: "fixture",
      WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232",
      WORKFLOWD_PR_REPOSITORIES: '[{"repository":"fixture/repo","installationId":91}]',
      OPENCODE_SERVER_PASSWORD: "fixture",
      WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-fixture",
      WORKFLOWD_OPENCODE_ATTACH_URL: "http://127.0.0.1:4096",
      WORKFLOWD_AGENT_RUN_TOKEN: "controller-private",
      WORKFLOWD_AGENT_RUN_REPOSITORIES: "fixture=/fixture/repo",
    },
    { home: "/tmp" },
  )
  const calls: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startHookService({
        ...loaded,
        http: { ...loaded.http, host: "127.0.0.1", port: 0 },
        worker: { ...loaded.worker, concurrency: 0, pollIntervalMs: 60000 },
      })
      const response = yield* Effect.tryPromise(() =>
        fetch(
          `http://${server.hostname}:${server.port}/workflows/agent-runs/agent-run-fixture/native`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer controller-private",
              "content-type": "application/json",
            },
            body: '{"operation":"status"}',
          },
        ),
      )
      expect(response.status).toBe(200)
      expect(calls).toEqual(["agent-run-fixture"])
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ state: "paused" })
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          kernelLayer(":memory:"),
          stubAdapters(),
          Layer.succeed(ExecutionDiscovery, { list: () => Effect.die("Unexpected discovery") }),
          Layer.succeed(AgentRunWatchdog, { iteration: Effect.succeed("idle" as const) }),
          Layer.succeed(AgentRunIngress, {
            register: () => Effect.die("Unexpected registration"),
            cancel: () => Effect.die("Unexpected cancellation"),
            nativeControl: (runId) =>
              Effect.sync(() => {
                calls.push(runId)
                return {
                  sessionId: "native",
                  nonce: "a".repeat(64),
                  state: "paused",
                  revision: null,
                }
              }),
          }),
        ),
      ),
    ),
  )
})

test("native controller API requires controller authentication and strict explicit operations", async () => {
  const calls: unknown[] = []
  const options = {
    installationIds: new Set<number>(),
    webhookSecret: "fixture",
    now: new Date(),
    agentRuns: {
      token: "controller-private",
      register: () => Effect.die("No registration in control fixture"),
      cancel: () => Effect.die("No cancellation in control fixture"),
      nativeControl: (runId: string, input: unknown) => {
        calls.push({ runId, input })
        return Effect.succeed({
          sessionId: "11111111-1111-4111-8111-111111111111",
          nonce: "a".repeat(64),
          state: "paused",
          revision: null,
        })
      },
    },
  }
  const invoke = (body: unknown, token = "controller-private") =>
    Effect.runPromise(
      routeRequest(
        new Request("http://controller/workflows/agent-runs/agent-run-fixture/native", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        options,
      ).pipe(
        Effect.provide(WorkSignalLive),
        Effect.provide(WorkflowStoreLive),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      ),
    )
  expect((await invoke({ operation: "status" }, "agent-sentinel")).status).toBe(401)
  expect(calls).toHaveLength(0)
  for (const input of [
    { operation: "status" },
    { operation: "pause", nonce: "a".repeat(64) },
    { operation: "finish", nonce: "a".repeat(64), revision: 2 },
    { operation: "resume", nonce: "a".repeat(64), prompt: "Continue this same session" },
  ])
    expect((await invoke(input)).status).toBe(200)
  expect(calls).toHaveLength(4)
  for (const input of [
    { operation: "finish" },
    { operation: "resume", nonce: "a".repeat(64), prompt: "" },
    { operation: "status", prompt: "replay" },
    { operation: "resume", nonce: "a".repeat(64), prompt: "x", model: "other" },
    { operation: "finish", nonce: "a".repeat(64), revision: 0 },
  ])
    expect((await invoke(input)).status).toBe(400)
  expect(calls).toHaveLength(4)
})
