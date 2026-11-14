import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SandboxDispatch } from "../../src/sandbox/dispatch"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { AgentRunIngress } from "../../src/kernel/agent-run-ingress"
import { WorkspaceError } from "../../src/workspace/errors"
import { ExecutionDiscovery, makeExecutionCapabilities } from "../../src/execution-capabilities"
import type { CliEvent } from "../../src/kernel/cli-process-contract"
import {
  defaultState,
  makeLayer,
  makeProvider,
  makeCodexCli,
  register,
  worktrees,
} from "./agent-run-ingress-harness"

for (const [kind, method, localPresent, resumeFailure] of [
  ["claude", "route", true, "session"],
  ["claude", "route", false, "acquisition"],
  ["claude", "model", true, "first-output"],
  ["claude", "model", false, "model-evidence"],
  ["claude", "provider-first", false, "session"],
  ["codex", "route", false, "session"],
  ["opencode", "model", false, "first-output"],
  ["opencode", "route", false, "model-evidence"],
] as const) {
  test(`Actions-native ${kind} ${method} records relocated identity with local port ${localPresent ? "disabled" : "absent"}`, async () => {
    const model = kind === "claude" ? "claude-opus-4-6" : "gpt-5.5"
    const provider = kind === "claude" ? "anthropic" : "openai"
    const execution = makeCodexCli([
      { type: "provider.response", model, outputTokens: 3 },
      { type: "turn.completed", outputTokens: 3 },
    ])
    const executing =
      method === "provider-first"
        ? {
            ...execution.port,
            spawn: (input: Parameters<typeof execution.port.spawn>[0]) =>
              execution.port.spawn(input).pipe(
                Effect.map((process) => ({
                  ...process,
                  events: {
                    async *[Symbol.asyncIterator]() {
                      let start: CliEvent | undefined
                      for await (const event of process.events) {
                        if (event.type === "thread.started") {
                          start = event
                          continue
                        }
                        yield event
                        if (start) {
                          yield start
                          start = undefined
                        }
                      }
                    },
                  },
                })),
              ),
          }
        : execution.port
    const local = makeCodexCli([], 1, {
      kind: "not_authenticated",
      detail: "Local credential must not gate an Actions run",
    })
    const resuming = makeCodexCli(
      resumeFailure === "first-output"
        ? []
        : [{ type: "provider.response", model, outputTokens: 4 }],
      0,
      undefined,
      resumeFailure === "session" ? "foreign-session" : "01a09976-e799-7c52-9759-8b76d692b755",
    )
    const prepared: string[] = []
    const settlements: string[] = []
    const cancellations: string[] = []
    let ownsNative = true
    let sharedAborts = 0
    let records: typeof AgentRunStore.Service
    const discovery = makeExecutionCapabilities({
      host: "mint",
      refreshMs: 1000,
      timeoutMs: 1000,
      sources: [
        {
          executor: `${kind}:local`,
          kind,
          discover: async () => [{ provider, model, availability: "available" }],
        },
        {
          executor: `${kind}:actions`,
          kind,
          host: "github-actions",
          evidence: "configured",
          discover: async () => [{ provider, model, availability: "unknown" }],
        },
      ],
    })
    const sandbox = Layer.succeed(SandboxDispatch, {
      prepareNative: (run) =>
        Effect.gen(function* () {
          yield* records.recordResolvedSelection({
            runId: run.runId,
            now: new Date(),
            selection: { ...run.resolvedSelection!, host: "github-actions:78:1" },
          })
          prepared.push(run.runId)
          return { cli: executing }
        }).pipe(Effect.orDie),
      finishNative: (_run, terminal) =>
        Effect.sync(() => {
          settlements.push(terminal.state)
        }),
      nativeControl: () =>
        Effect.succeed({
          sessionId: "fixture",
          nonce: "a".repeat(64),
          state: "paused",
          revision: null,
        }),
      resumeNative: () =>
        Effect.succeed(
          resumeFailure === "acquisition"
            ? {
                ownership: "transient-exec",
                preflight: Effect.void,
                attach: () => Effect.succeed(null),
                spawn: () =>
                  Effect.fail(
                    new WorkspaceError({
                      operation: "fixture native acquisition",
                      cause: new Error("injected spawn failure"),
                    }),
                  ),
              }
            : resuming.port,
        ),
      launch: () => Effect.die("Not an OpenCode run"),
      cancel: (run) => Effect.sync(() => void cancellations.push(run.runId)),
      observe: () => Effect.void,
      owns: () => Effect.succeed(ownsNative),
      provider: () => Effect.die("No shared provider"),
      heartbeat: Effect.void,
      iteration: Effect.void,
    })
    const layer = makeLayer(
      {
        ...makeProvider(defaultState()),
        listProviders: () => Effect.die("Shared OpenCode must not be contacted"),
        createSession: () => Effect.die("Shared OpenCode must not launch"),
        abortSession: () =>
          Effect.sync(() => {
            sharedAborts++
            return true
          }),
      },
      worktrees([]),
      undefined,
      {
        claudeRoutes:
          kind === "claude"
            ? [{ name: "native", modelID: model }]
            : [{ name: "unavailable-claude", modelID: "claude-opus-4-6" }],
        codexRoutes: kind === "codex" ? [{ name: "native", modelID: model }] : [],
        routes:
          kind === "opencode" ? [{ name: "native", providerID: provider, modelID: model }] : [],
        repositories: [
          { name: "workflowd", directory: "/fixture/repo" },
          { name: "local", directory: "/fixture/local" },
        ],
        sandboxRepositories: [
          {
            alias: "workflowd",
            repository: "fixture/repo",
            repositoryId: 12,
            installationId: 1,
            workflowSha: "a".repeat(40),
            appActorId: 56,
            agentImage: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "b".repeat(64),
            tailscaleClientId: "fixture",
            tailscaleAudience: "fixture",
            privateBootstrap: { mode: "actions-native", repositoryOwnerId: 1 },
          },
        ],
      },
      localPresent ? local.port : null,
    ).pipe(
      Layer.provide(sandbox),
      Layer.provide(
        Layer.succeed(ExecutionDiscovery, { list: () => Effect.tryPromise(discovery.list) }),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        records = yield* AgentRunStore
        yield* Effect.addFinalizer(() => Effect.promise(discovery.close))
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO directory_local_identity(singleton,host_id) VALUES(1,'mint')`
        if (kind !== "claude") {
          const unavailable = yield* register({
            route: "unavailable-claude",
            repository: "workflowd",
            prompt: "Refuse unconfigured native alias",
          }).pipe(Effect.result)
          expect(unavailable._tag).toBe("Failure")
          if (unavailable._tag === "Failure")
            expect(unavailable.failure).toMatchObject({ reason: "executor_unavailable" })
          expect(prepared).toEqual([])
        } else {
          const thinking = yield* register({
            route: "native",
            repository: "workflowd",
            prompt: "Refuse unsupported thinking",
            thinking: { effort: "high" },
          }).pipe(Effect.result)
          expect(thinking._tag).toBe("Failure")
          if (thinking._tag === "Failure")
            expect(thinking.failure).toMatchObject({ reason: "unsupported_thinking" })
          expect(prepared).toEqual([])
        }
        if (method === "model") {
          const refused = yield* register({
            model,
            repository: "workflowd",
            prompt: "Access must not come from local Claude",
          }).pipe(Effect.result)
          expect(refused._tag).toBe("Failure")
          if (refused._tag === "Failure")
            expect(refused.failure).toMatchObject({ reason: "model_access_unknown" })
          expect(prepared).toHaveLength(0)
          for (const [extra, reason] of [
            [{ provider: "unconfigured" }, "unknown_model"],
            [{ thinking: { effort: "max" } }, "unsupported_thinking"],
            [{ repository: "local", executor: `${kind}:actions` }, "executor_unavailable"],
          ] as const) {
            const result = yield* register({
              model,
              repository: "workflowd",
              prompt: "Refuse incompatible Actions selection",
              allowUnknownAccess: true,
              ...extra,
            }).pipe(Effect.result)
            expect(result._tag).toBe("Failure")
            if (result._tag === "Failure") expect(result.failure).toMatchObject({ reason })
          }
          expect(prepared).toHaveLength(0)
        }
        const choice =
          method !== "model" ? { route: "native" } : { model, allowUnknownAccess: true }
        const receipt = yield* register({
          ...choice,
          repository: "workflowd",
          prompt: "Fixture",
        })
        const runs = yield* AgentRunStore
        const run = yield* runs.read(receipt.runId)
        expect(run?.resolvedSelection).toMatchObject({
          executor: `${kind}:actions`,
          host: "github-actions:78:1",
          provider,
          evidence: "provider-response",
        })
        expect(
          yield* sql`SELECT server_id, endpoint_identity FROM kernel_sessions WHERE native_session_id=${receipt.nativeSessionId}`,
        ).toEqual([
          {
            server_id: "github-actions:78:1",
            endpoint_identity: `${kind}-cli://github-actions:78:1`,
          },
        ])
        expect(run?.providerId).toBe(provider)
        expect(run?.agent).toBe("sandbox")
        const duplicate = yield* register({
          ...choice,
          repository: "workflowd",
          prompt: "Fixture",
        })
        expect(duplicate.status).toBe("duplicate")
        expect(duplicate.resolvedSelection).toEqual(receipt.resolvedSelection)
        expect(
          yield* sql`SELECT recipient_id, host_id FROM directory_managed WHERE run_id=${receipt.runId}`,
        ).toEqual([{ recipient_id: `managed:mint:${receipt.runId}`, host_id: "mint" }])
        expect(prepared).toEqual([receipt.runId])
        expect(local.state.spawned).toHaveLength(0)
        expect(execution.state.spawned).toHaveLength(1)
        {
          if (resumeFailure === "model-evidence")
            yield* sql`CREATE TRIGGER fail_resumed_evidence BEFORE UPDATE OF resolved_selection ON kernel_agent_runs
            BEGIN SELECT RAISE(FAIL,'injected resume evidence persistence failure'); END`
          const ingress = yield* AgentRunIngress
          const resumed = yield* ingress.nativeControl!(receipt.runId, {
            operation: "resume",
            nonce: "a".repeat(64),
            prompt: "Continue",
          }).pipe(Effect.result)
          expect(resumed._tag).toBe("Failure")
          expect(settlements.filter((state) => state === "operator_required")).toHaveLength(1)
          if (resumeFailure !== "acquisition") {
            expect(resuming.state.killed).toBe(true)
            expect(resuming.state.spawned.map((input) => input.prompt)).toEqual(["Continue"])
          }
          expect((yield* runs.read(receipt.runId))?.nativeSessionId).toBe(receipt.nativeSessionId)
          expect(
            yield* sql`SELECT recipient_id FROM directory_managed WHERE run_id=${receipt.runId}`,
          ).toEqual([{ recipient_id: `managed:mint:${receipt.runId}` }])
          ownsNative = false
          const before = yield* runs.read(receipt.runId)
          const refused = yield* ingress.cancel(receipt.runId, new Date()).pipe(Effect.result)
          expect(refused._tag).toBe("Failure")
          if (refused._tag === "Failure")
            expect(refused.failure).toMatchObject({ reason: "run_conflict" })
          expect(sharedAborts).toBe(0)
          expect(local.state.killed).toBe(false)
          expect(execution.state.killed).toBe(false)
          expect(cancellations).toEqual([])
          expect(yield* runs.read(receipt.runId)).toEqual(before)
          ownsNative = true
          yield* ingress.cancel(receipt.runId, new Date())
          expect(cancellations).toEqual([receipt.runId])
          expect(sharedAborts).toBe(0)
        }
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })
}
