import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect, Fiber, Layer, Schedule, Schema } from "effect"
import { AgentRunReceipt, type AgentRunSubmission } from "../../src/agent-run-contract"
import type { ExecutionCapabilities } from "../../src/execution-capability-contract"
import { TestClock } from "effect/testing"
import { ExecutionDiscovery } from "../../src/execution-capabilities"
import { routeRequest } from "../../src/http"
import {
  AgentRunIngress,
  AgentRunIngressLive,
  agentRunIdentifiers,
} from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { runAgentRunWatchdogIteration } from "../../src/kernel/agent-run-watchdog"
import type { CliPort } from "../../src/kernel/cli-process-contract"
import { at, defaultState, makeLayer, makeProvider, worktrees } from "./agent-run-ingress-harness"

const options = {
  routes: [],
  codexRoutes: [],
  claudeRoutes: [],
  repositories: [{ name: "workflowd", directory: "/fixture" }],
  agent: "build",
  worktreeRoot: "/work",
  verifyTimeoutMs: 100,
  verifyPollIntervalMs: 5,
  progressWindowMs: 1000,
  maxAttempts: 3,
  claudeHosts: [],
  identity: {
    owningHostId: "mint",
    providerId: "opencode-primary",
    serverId: "opencode-primary",
    endpointAlias: "local",
    endpointIdentity: "http://127.0.0.1:4096",
    providerVersion: 1,
  },
}

const call = (input: AgentRunSubmission) =>
  Effect.gen(function* () {
    const ingress = yield* AgentRunIngress
    return yield* routeRequest(
      new Request("http://fixture/workflows/agent-runs", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
      { webhookSecret: "", now: at, agentRuns: { token: "secret", ...ingress } },
    )
  })

const receiptOf = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AgentRunReceipt)),
  )
const refusalOf = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ reason: Schema.String }))),
  )
const settled = (id: string) =>
  Effect.gen(function* () {
    const store = yield* AgentRunStore
    return yield* store.read(id).pipe(
      Effect.repeat({
        while: (row) => row?.state === "verified",
        schedule: Schedule.spaced("5 millis"),
      }),
      Effect.timeout("2 seconds"),
    )
  })

const listing = (kind: "opencode" | "codex", provider: string | null): ExecutionCapabilities => ({
  sources: [
    {
      executor: kind === "opencode" ? "opencode:opencode-primary" : "codex:local",
      kind,
      protocol: "fixture",
      status: "available",
      checkedAt: at.toISOString(),
      observedAt: at.toISOString(),
      freshUntil: at.toISOString(),
      stale: false,
    },
  ],
  capabilities: [
    {
      identity: {
        host: "mint",
        executor: kind === "opencode" ? "opencode:opencode-primary" : "codex:local",
        provider,
        model: "native",
      },
      selectionModel: "picker",
      availability: kind === "codex" ? "unknown" : "available",
      observedAt: at.toISOString(),
      thinking: { status: "unknown" },
    },
  ],
})

const events: CliPort = {
  ownership: "transient-exec",
  preflight: Effect.void,
  attach: () => Effect.succeed(null),
  spawn: () =>
    Effect.succeed({
      executionId: "fixture",
      exited: Effect.succeed({ exitCode: 0, stderr: "" }),
      cancel: Effect.void,
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "thread.started", threadId: "native-thread" }
          yield { type: "agent_message", text: "fixture" }
          yield { type: "turn.completed", outputTokens: 1 }
        },
      },
    }),
}

for (const change of ["matching", "model", "provider", "executor"] as const)
  test(`historical duplicate ${change} alias replays only its persisted original choice`, async () => {
    const state = defaultState()
    state.providers = []
    state.models = []
    state.telemetry.set("old", {
      directory: "/old",
      outputTokens: 7,
      updatedAtMs: at.getTime(),
      idle: false,
    })
    const prompt = "historical task"
    const ids = agentRunIdentifiers({
      route: "implement",
      repository: "workflowd",
      prompt,
      parentSessionId: null,
      resumePrompt: null,
    })
    const alias = {
      name: "implement",
      providerID: change === "provider" ? "changed-provider" : "old-provider",
      modelID: change === "model" ? "changed-model" : "old-picker",
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* AgentRunStore
        const sessions = yield* KernelSessionStore
        yield* store.create({
          runId: ids.runId,
          route: "implement",
          providerId: "old-provider",
          modelId: "old-picker",
          executorKind: "opencode",
          agent: "build",
          repository: "workflowd",
          directory: "/old",
          prompt,
          promptSha256: createHash("sha256").update(prompt).digest("hex"),
          parentSessionId: null,
          resumePrompt: null,
          maxAttempts: 3,
          createdAt: at,
        })
        yield* store.claimSpawn({ runId: ids.runId, now: at })
        yield* sessions.registerResource({
          resourceId: "resource",
          owningHostId: "original-host",
          absolutePath: "/old",
          kind: "worktree",
          createdAt: at,
        })
        yield* sessions.registerSession({
          sessionId: "opencode-session-old",
          providerKind: "opencode",
          providerVersion: 1,
          providerId: "original-server",
          serverId: "original-server",
          owningHostId: "original-host",
          endpointAlias: "local",
          endpointIdentity: "http://original",
          nativeSessionId: "old",
          resourceId: "resource",
          createdAt: at,
        })
        yield* store.markSpawned({
          runId: ids.runId,
          now: at,
          resourceId: "resource",
          sessionId: "opencode-session-old",
          nativeSessionId: "old",
        })
        yield* store.markVerified({ runId: ids.runId, now: at, outputTokens: 7 })
        const response = yield* call({ route: "implement", repository: "workflowd", prompt })
        expect(response.status).toBe(202)
        const receipt = yield* receiptOf(response)
        expect(receipt).toMatchObject({
          status: "duplicate",
          providerId: "old-provider",
          modelId: "old-picker",
          nativeSessionId: "old",
          resolvedSelection: {
            executorKind: "opencode",
            provider: "old-provider",
            model: null,
            selectionModel: "old-picker",
            thinking: {},
            evidence: "configured",
            host: "original-host",
            executor: "opencode:original-server",
          },
        })
        expect(receipt.requestedSelection).toBeUndefined()
        expect((yield* store.read(ids.runId))?.resolvedSelection).toBeNull()
        expect(state.created).toHaveLength(0)
        expect(state.prompted).toHaveLength(0)
      }).pipe(
        Effect.provide(
          makeLayer(makeProvider(state), worktrees([]), events, {
            ...options,
            routes: change === "executor" ? [] : [alias],
            codexRoutes:
              change === "executor" ? [{ name: "implement", modelID: "changed-native" }] : [],
          }),
        ),
      ),
    )
  })

for (const provider of ["codex-cli", "claude-cli"])
  test(`OpenCode provider ${provider} stays out of native recovery and completes through watchdog`, async () => {
    const state = defaultState()
    const attachments: string[] = []
    const cli: CliPort = {
      ...events,
      attach: ({ runId }) =>
        Effect.sync(() => {
          attachments.push(runId)
          return null
        }),
    }
    const layer = makeLayer(makeProvider(state), worktrees([]), cli, options, cli).pipe(
      Layer.provideMerge(
        Layer.succeed(ExecutionDiscovery, {
          list: () => Effect.succeed(listing("opencode", provider)),
        }),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* call({
          model: "native",
          provider,
          repository: "workflowd",
          prompt: "collision",
        })
        expect(response.status).toBe(202)
        const receipt = yield* receiptOf(response)
        const store = yield* AgentRunStore
        expect((yield* store.read(receipt.runId))?.executorKind).toBe("opencode")
        yield* Effect.void.pipe(Effect.provide(AgentRunIngressLive(options)))
        expect(attachments).toEqual([])
        expect((yield* store.read(receipt.runId))?.state).toBe("verified")
        state.telemetry.set("ses_child", {
          directory: "/work",
          outputTokens: 7,
          updatedAtMs: at.getTime(),
          idle: true,
          outcome: "succeeded",
        })
        expect(
          yield* runAgentRunWatchdogIteration({
            progressWindowMs: 1000,
            staleAfterMs: 1000,
            unsupervisedExecutorKinds: ["codex", "claude"],
            now: () => at,
          }),
        ).toBe("worked")
        expect((yield* store.read(receipt.runId))?.state).toBe("completed")
      }).pipe(Effect.provide(layer)),
    )
  })

for (const kind of ["codex", "claude"] as const)
  for (const failure of ["not_authenticated", "cli_unusable"] as const)
    test(`${kind} launch readiness refreshes ${failure} in both directions and never gates accepted duplicates`, async () => {
      let available = false,
        checks = 0,
        spawns = 0
      const cli: CliPort = {
        ...events,
        preflight: Effect.suspend(() => {
          checks += 1
          return available
            ? Effect.void
            : Effect.fail({ kind: failure, detail: "current native readiness" })
        }),
        spawn: (input) => {
          spawns += 1
          return events.spawn(input)
        },
      }
      const layer = makeLayer(
        makeProvider(defaultState()),
        worktrees([]),
        kind === "codex" ? cli : events,
        { ...options, claudeRoutes: [{ name: "opus", modelID: "opus" }] },
        kind === "claude" ? cli : events,
      ).pipe(
        Layer.provideMerge(
          Layer.succeed(ExecutionDiscovery, { list: () => Effect.succeed(listing("codex", null)) }),
        ),
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const choice =
            kind === "codex" ? { model: "native", allowUnknownAccess: true } : { route: "opus" }
          const input = {
            ...choice,
            repository: "workflowd",
            prompt: "recover",
            idempotencyKey: "accepted",
          }
          const broken = yield* call(input)
          expect(broken.status).toBe(409)
          expect((yield* refusalOf(broken)).reason).toBe(
            failure === "cli_unusable" ? "executor_unavailable" : "provider_not_authenticated",
          )
          available = true
          const response = yield* call(input)
          expect(response.status).toBe(202)
          const first = yield* receiptOf(response)
          yield* settled(first.runId)
          const beforeDuplicate = checks
          available = false
          const duplicate = yield* call(input)
          expect(duplicate.status).toBe(202)
          expect((yield* receiptOf(duplicate)).resolvedSelection).toEqual(first.resolvedSelection)
          expect(checks).toBe(beforeDuplicate)
          const newLaunch = yield* call({ ...input, prompt: "new task", idempotencyKey: "new" })
          expect(newLaunch.status).toBe(409)
          expect((yield* refusalOf(newLaunch)).reason).toBe(
            failure === "cli_unusable" ? "executor_unavailable" : "provider_not_authenticated",
          )
          expect(spawns).toBe(1)
          expect(checks).toBeGreaterThan(beforeDuplicate)
        }).pipe(Effect.provide(layer)),
      )
    })

test("accepted explicit model and thinking conflicts refuse without fresh discovery", async () => {
  let available = true,
    discoveryCalls = 0
  const layer = makeLayer(makeProvider(defaultState()), worktrees([]), events, options).pipe(
    Layer.provideMerge(
      Layer.succeed(ExecutionDiscovery, {
        list: () => {
          discoveryCalls += 1
          return available
            ? Effect.succeed(listing("opencode", "p"))
            : Effect.fail(new Error("catalog lost"))
        },
      }),
    ),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const input = {
        model: "native",
        provider: "p",
        repository: "workflowd",
        prompt: "fixed",
        idempotencyKey: "fixed",
      }
      const first = yield* receiptOf(yield* call(input))
      available = false
      const duplicate = yield* receiptOf(yield* call(input))
      expect(duplicate.resolvedSelection).toEqual(first.resolvedSelection)
      for (const changed of [
        { ...input, model: "different" },
        { ...input, thinking: { effort: "different" } },
      ]) {
        const response = yield* call(changed)
        expect(response.status).toBe(409)
      }
      expect(discoveryCalls).toBe(1)
    }).pipe(Effect.provide(layer)),
  )
})

for (const kind of ["codex", "claude"] as const)
  test(`${kind} new-launch preflight is bounded and interrupted before refusing`, async () => {
    let blocked = false,
      interrupted = false,
      spawns = 0
    const entered = Promise.withResolvers<void>()
    const cli: CliPort = {
      ...events,
      preflight: Effect.suspend(() => {
        if (!blocked) return Effect.void
        entered.resolve()
        return Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              interrupted = true
            }),
          ),
        )
      }),
      spawn: (input) => {
        spawns += 1
        return events.spawn(input)
      },
    }
    const layer = makeLayer(
      makeProvider(defaultState()),
      worktrees([]),
      kind === "codex" ? cli : events,
      {
        ...options,
        codexRoutes: [{ name: "scan", modelID: "native" }],
        claudeRoutes: [{ name: "opus", modelID: "opus" }],
      },
      kind === "claude" ? cli : events,
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        blocked = true
        const pending = yield* call({
          route: kind === "codex" ? "scan" : "opus",
          repository: "workflowd",
          prompt: "bounded",
        }).pipe(Effect.forkChild)
        yield* Effect.promise(() => entered.promise)
        yield* TestClock.adjust("5 seconds")
        const response = yield* Fiber.join(pending)
        expect(response.status).toBe(409)
        expect((yield* refusalOf(response)).reason).toBe("executor_unavailable")
        expect(interrupted).toBe(true)
        expect(spawns).toBe(0)
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
    )
  })
