import { describe, expect, test } from "bun:test"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { AgentHandoffStoreLive } from "../../src/kernel/agent-handoff-store"
import { AgentWaitIngressLive } from "../../src/kernel/agent-wait-ingress"
import {
  AgentRunIngress,
  AgentRunIngressLive,
  AgentRunProvider,
  AgentRunRefusalError,
  AgentRunWorktrees,
  type AgentRunProviderPort,
  type AgentRunWorktreesPort,
} from "../../src/kernel/agent-run-ingress"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { ClaudeCli, type ClaudeCliPort } from "../../src/kernel/claude-session"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { KernelSessionStoreLive } from "../../src/kernel/session-store"
import type { OpenCodeSessionTelemetry } from "../../src/opencode/adapter"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignal, type WorkSignalPort } from "../../src/work-signal"

const at = new Date("2026-08-30T10:00:00.000Z")

const identity = {
  owningHostId: "mint",
  providerId: "opencode-primary",
  serverId: "opencode-primary",
  endpointAlias: "local",
  endpointIdentity: "http://127.0.0.1:4096",
  providerVersion: 1,
}

const options = {
  routes: [
    { name: "implement", providerID: "zai-coding-plan", modelID: "glm-5.3-flash" },
    { name: "hard", providerID: "anthropic", modelID: "claude-fable-5" },
  ],
  repositories: [{ name: "workflowd", directory: "/home/ben/repos/workflowd" }],
  agent: "remote-worker",
  worktreeRoot: "/tmp/worktrees",
  verifyTimeoutMs: 50,
  verifyPollIntervalMs: 10,
  maxAttempts: 3,
  identity,
}

type ProviderState = {
  created: Array<{ directory: string; agent: string; model: unknown }>
  prompted: Array<{ sessionID: string; text: string }>
  aborted: Array<string>
  telemetry: Map<string, OpenCodeSessionTelemetry | undefined>
  providers: ReadonlyArray<string>
  models: ReadonlyArray<{ providerID: string; id: string }>
}

const defaultState = (): ProviderState => ({
  created: [],
  prompted: [],
  aborted: [],
  telemetry: new Map([
    [
      "ses_child",
      {
        directory: "/tmp/worktrees/agent-runs/x",
        outputTokens: 7,
        updatedAtMs: at.getTime(),
        idle: false,
      },
    ],
  ]),
  providers: ["zai-coding-plan", "anthropic"],
  models: [
    { providerID: "zai-coding-plan", id: "glm-5.3-flash" },
    { providerID: "anthropic", id: "claude-fable-5" },
  ],
})

const makeProvider = (state: ProviderState): AgentRunProviderPort => ({
  createSession: (input) =>
    Effect.sync(() => {
      state.created.push({ directory: input.directory, agent: input.agent, model: input.model })
      return { id: "ses_child" }
    }),
  promptSession: (input) =>
    Effect.sync(() => {
      state.prompted.push({ sessionID: input.sessionID, text: input.text })
    }),
  abortSession: (input) =>
    Effect.sync(() => {
      state.aborted.push(input.sessionID)
      return true
    }),
  listProviders: () => Effect.succeed(state.providers),
  listModels: () => Effect.succeed(state.models),
  sessionTelemetry: (input) => Effect.succeed(state.telemetry.get(input.sessionID)),
})

const worktrees = (created: Array<{ repository: string; directory: string; branch: string }>) =>
  ({
    create: (input) =>
      Effect.sync(() => {
        created.push(input)
      }),
  }) satisfies AgentRunWorktreesPort

const signals: WorkSignalPort = {
  subscribe: () => Effect.die(new Error("unused")),
  wake: () => Effect.void,
}

const claudeCli: ClaudeCliPort = {
  sessionExists: (input) => Effect.succeed(input.nativeSessionId === "claude-parent-1"),
  resume: () => Effect.die(new Error("unused in ingress tests")),
}

const makeLayer = (provider: AgentRunProviderPort, trees: AgentRunWorktreesPort) => {
  const database = SqliteClient.layer({ filename: ":memory:" })
  const bootstrap = WorkflowStoreLive.pipe(Layer.provideMerge(database))
  const events = KernelEventStoreLive.pipe(Layer.provideMerge(bootstrap))
  const sessions = KernelSessionStoreLive.pipe(Layer.provideMerge(bootstrap))
  const handoffs = AgentHandoffStoreLive.pipe(
    Layer.provideMerge(events),
    Layer.provideMerge(bootstrap),
  )
  const waits = AgentWaitIngressLive(identity).pipe(
    Layer.provideMerge(Layer.mergeAll(events, sessions, handoffs)),
    Layer.provideMerge(Layer.succeed(WorkSignal, signals)),
  )
  const runs = AgentRunStoreLive.pipe(Layer.provideMerge(bootstrap))
  return AgentRunIngressLive(options).pipe(
    Layer.provideMerge(Layer.mergeAll(runs, sessions, waits)),
    Layer.provideMerge(Layer.succeed(AgentRunProvider, provider)),
    Layer.provideMerge(Layer.succeed(AgentRunWorktrees, trees)),
    Layer.provideMerge(Layer.succeed(ClaudeCli, claudeCli)),
    Layer.provideMerge(Layer.succeed(WorkSignal, signals)),
  )
}

const submission = {
  route: "implement",
  repository: "workflowd",
  prompt: "Fix the flaky retry test and push the branch.",
}

const register = (input: import("../../src/agent-run-contract").AgentRunSubmission) =>
  Effect.gen(function* () {
    const ingress = yield* AgentRunIngress
    return yield* ingress.register(input, at)
  })

const refusalOf = async <A>(promise: Promise<A>): Promise<AgentRunRefusalError> => {
  try {
    await promise
  } catch (cause) {
    const error =
      typeof cause === "object" && cause !== null && "cause" in cause ? cause.cause : cause
    if (error instanceof AgentRunRefusalError) return error
    throw cause
  }
  throw new Error("expected a refusal")
}

describe("agent-run ingress", () => {
  test("dispatches by intent and returns a first-token-verified receipt with custody registered", async () => {
    const state = defaultState()
    const trees: Array<{ repository: string; directory: string; branch: string }> = []
    const layer = makeLayer(makeProvider(state), worktrees(trees))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const receipt = yield* register(submission)
        const sql = yield* SqlClient.SqlClient
        const custody = yield* sql<{
          readonly session_id: string
          readonly native_session_id: string
          readonly resource_id: string
        }>`SELECT session_id, native_session_id, resource_id FROM kernel_sessions`
        const resources = yield* sql<{
          readonly kind: string
          readonly state: string
        }>`SELECT kind, state FROM kernel_working_resources`
        const store = yield* AgentRunStore
        const run = yield* store.read(receipt.runId)
        return { receipt, custody, resources, run }
      }).pipe(Effect.provide(layer)),
    )

    expect(result.receipt.status).toBe("dispatched")
    expect(result.receipt.providerId).toBe("zai-coding-plan")
    expect(result.receipt.modelId).toBe("glm-5.3-flash")
    expect(result.receipt.outputTokens).toBe(7)
    expect(result.receipt.nativeSessionId).toBe("ses_child")
    expect(result.receipt.sessionId).toBe("opencode-session-ses_child")
    expect(result.custody).toHaveLength(1)
    expect(result.custody[0]!.native_session_id).toBe("ses_child")
    expect(result.resources[0]!.kind).toBe("worktree")
    expect(result.resources[0]!.state).toBe("reserved")
    expect(result.run?.state).toBe("verified")
    expect(trees).toHaveLength(1)
    expect(trees[0]!.repository).toBe("/home/ben/repos/workflowd")
    expect(state.created[0]!.agent).toBe("remote-worker")
    expect(state.prompted[0]!.text).toBe(submission.prompt)
  })

  test("re-dispatch of the same submission is a duplicate and spawns nothing new", async () => {
    const state = defaultState()
    const trees: Array<{ repository: string; directory: string; branch: string }> = []
    const layer = makeLayer(makeProvider(state), worktrees(trees))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* register(submission)
        const replay = yield* register(submission)
        return { first, replay }
      }).pipe(Effect.provide(layer)),
    )
    expect(result.first.status).toBe("dispatched")
    expect(result.replay.status).toBe("duplicate")
    expect(result.replay.runId).toBe(result.first.runId)
    expect(state.created).toHaveLength(1)
    expect(state.prompted).toHaveLength(1)
  })

  test("refuses provider-prefixed, unknown, and disallowed dispatches loudly", async () => {
    const state = defaultState()
    const layer = makeLayer(makeProvider(state), worktrees([]))
    const provider = await refusalOf(
      Effect.runPromise(
        register({ ...submission, route: "zai-coding-plan/glm-5.3-flash" }).pipe(
          Effect.provide(layer),
        ),
      ),
    )
    expect(provider.reason).toBe("provider_prefixed_route")
    const unknown = await refusalOf(
      Effect.runPromise(register({ ...submission, route: "gpt-9" }).pipe(Effect.provide(layer))),
    )
    expect(unknown.reason).toBe("unknown_route")
    const repo = await refusalOf(
      Effect.runPromise(
        register({ ...submission, repository: "not-allowed" }).pipe(Effect.provide(layer)),
      ),
    )
    expect(repo.reason).toBe("unknown_repository")
    expect(state.created).toHaveLength(0)
  })

  test("a route on an unauthenticated provider or absent model is rejected at enqueue", async () => {
    const state = defaultState()
    state.providers = ["anthropic"]
    const layer = makeLayer(makeProvider(state), worktrees([]))
    const dead = await refusalOf(
      Effect.runPromise(register(submission).pipe(Effect.provide(layer))),
    )
    expect(dead.reason).toBe("provider_not_authenticated")
    expect(dead.detail).toContain("zai-coding-plan")

    const state2 = defaultState()
    state2.models = [{ providerID: "anthropic", id: "claude-fable-5" }]
    const layer2 = makeLayer(makeProvider(state2), worktrees([]))
    const missing = await refusalOf(
      Effect.runPromise(register(submission).pipe(Effect.provide(layer2))),
    )
    expect(missing.reason).toBe("model_not_available")
    expect(state.created).toHaveLength(0)
    expect(state2.created).toHaveLength(0)
  })

  test("a session that never generates is aborted, failed, and refused", async () => {
    const state = defaultState()
    state.telemetry.set("ses_child", {
      directory: "/tmp/worktrees/agent-runs/x",
      outputTokens: 0,
      updatedAtMs: at.getTime(),
      idle: false,
    })
    const layer = makeLayer(makeProvider(state), worktrees([]))
    const refusal = await refusalOf(
      Effect.runPromise(register(submission).pipe(Effect.provide(layer))),
    )
    expect(refusal.reason).toBe("no_first_token")
    expect(state.aborted).toEqual(["ses_child"])
  })

  test("dispatch with a parent registers the wait and both custody ends", async () => {
    const state = defaultState()
    state.telemetry.set("ses_parent", {
      directory: "/home/ben/coordination",
      outputTokens: 100,
      updatedAtMs: at.getTime(),
      idle: false,
    })
    const layer = makeLayer(makeProvider(state), worktrees([]))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const receipt = yield* register({
          ...submission,
          parentSessionId: "ses_parent",
          resumePrompt: "Child finished; review its branch.",
        })
        const sql = yield* SqlClient.SqlClient
        const watches = yield* sql<{
          readonly child_session_id: string
          readonly state: string
        }>`SELECT child_session_id, state FROM kernel_agent_completion_watches`
        return { receipt, watches }
      }).pipe(Effect.provide(layer)),
    )
    expect(result.receipt.wait?.status).toBe("registered")
    expect(result.watches).toHaveLength(1)
    expect(result.watches[0]!.child_session_id).toBe("opencode-session-ses_child")
    expect(result.watches[0]!.state).toBe("watching")
  })

  test("a missing parent refuses before anything is spawned", async () => {
    const state = defaultState()
    const layer = makeLayer(makeProvider(state), worktrees([]))
    const refusal = await refusalOf(
      Effect.runPromise(
        register({
          ...submission,
          parentSessionId: "ses_gone",
          resumePrompt: "wake me",
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(refusal.reason).toBe("missing_parent_session")
    expect(state.created).toHaveLength(0)
  })

  test("dispatch with a claude parent registers claude custody and the wait", async () => {
    const state = defaultState()
    const layer = makeLayer(makeProvider(state), worktrees([]))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const receipt = yield* register({
          ...submission,
          parentSessionId: "claude-parent-1",
          parentKind: "claude",
          parentDirectory: "/home/ben/repos/workflowd",
          resumePrompt: "Child finished; review its branch.",
        })
        const sql = yield* SqlClient.SqlClient
        const parent = yield* sql<{
          readonly provider_kind: string
          readonly endpoint_identity: string
        }>`SELECT provider_kind, endpoint_identity FROM kernel_sessions
          WHERE session_id = 'claude-session-claude-parent-1'`
        const watches = yield* sql<{
          readonly state: string
        }>`SELECT state FROM kernel_agent_completion_watches`
        return { receipt, parent, watches }
      }).pipe(Effect.provide(layer)),
    )
    expect(result.receipt.wait?.status).toBe("registered")
    expect(result.parent).toHaveLength(1)
    expect(result.parent[0]!.provider_kind).toBe("claude")
    expect(result.parent[0]!.endpoint_identity).toBe("claude-cli://mint")
    expect(result.watches[0]!.state).toBe("watching")
  })

  test("a claude parent without a directory or transcript is refused before spawning", async () => {
    const state = defaultState()
    const layer = makeLayer(makeProvider(state), worktrees([]))
    const unpaired = await refusalOf(
      Effect.runPromise(
        register({
          ...submission,
          parentSessionId: "claude-parent-1",
          parentKind: "claude",
          resumePrompt: "wake me",
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(unpaired.reason).toBe("invalid_wait_pairing")
    const missing = await refusalOf(
      Effect.runPromise(
        register({
          ...submission,
          parentSessionId: "claude-parent-unknown",
          parentKind: "claude",
          parentDirectory: "/home/ben/repos/workflowd",
          resumePrompt: "wake me",
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(missing.reason).toBe("missing_parent_session")
    expect(state.created).toHaveLength(0)
  })

  test("an unpaired resume prompt is refused", async () => {
    const state = defaultState()
    const layer = makeLayer(makeProvider(state), worktrees([]))
    const refusal = await refusalOf(
      Effect.runPromise(
        register({ ...submission, resumePrompt: "wake me" }).pipe(Effect.provide(layer)),
      ),
    )
    expect(refusal.reason).toBe("invalid_wait_pairing")
  })
})
