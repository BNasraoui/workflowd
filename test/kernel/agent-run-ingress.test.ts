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
  type AgentRunProviderPort,
} from "../../src/kernel/agent-run-ingress"
import { AgentRunWorktrees, type AgentRunWorktreesPort } from "../../src/kernel/agent-run-worktrees"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { ClaudeCli, type ClaudeCliPort } from "../../src/kernel/claude-session"
import { CodexCli } from "../../src/kernel/codex-session"
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
  codexRoutes: [{ name: "scan", modelID: "gpt-5.1-codex" }],
  repositories: [{ name: "workflowd", directory: "/home/ben/repos/workflowd" }],
  agent: "remote-worker",
  worktreeRoot: "/tmp/worktrees",
  verifyTimeoutMs: 50,
  verifyPollIntervalMs: 10,
  progressWindowMs: 10 * 60_000,
  maxAttempts: 3,
  claudeHosts: ["ben-arch"],
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

/** Scripted codex CLI: `threadId`, the events to stream, the resulting exit,
 * and a `preflight` outcome; spawn/preflight calls are recorded. */
type CodexState = {
  spawned: Array<{ directory: string; prompt: string; model: string | null }>
  killed: boolean
}

const makeCodexCli = (
  events: ReadonlyArray<import("../../src/kernel/codex-session").CodexExecEvent>,
  exitCode = 0,
  preflightError?: import("../../src/kernel/codex-session").CodexPreflightError,
  threadId = "01a09976-e799-7c52-9759-8b76d692b755",
) => {
  const state: CodexState = { spawned: [], killed: false }
  const port: import("../../src/kernel/codex-session").CodexCliPort = {
    preflight: preflightError === undefined ? Effect.void : Effect.fail(preflightError),
    spawn: (input) =>
      Effect.sync(() => {
        state.spawned.push({ directory: input.directory, prompt: input.prompt, model: input.model })
        const queue: {
          push: (event: import("../../src/kernel/codex-session").CodexExecEvent) => void
          close: () => void
          items: import("../../src/kernel/codex-session").CodexExecEvent[]
          waiter: (() => void) | null
          closed: boolean
        } = {
          items: [],
          waiter: null,
          closed: false,
          push(event) {
            this.items.push(event)
            const wake = this.waiter
            this.waiter = null
            wake?.()
          },
          close() {
            this.closed = true
            const wake = this.waiter
            this.waiter = null
            wake?.()
          },
        }
        const iterator: AsyncIterator<import("../../src/kernel/codex-session").CodexExecEvent> = {
          next: async () => {
            for (;;) {
              if (queue.items.length > 0) {
                return { value: queue.items.shift()!, done: false }
              }
              if (queue.closed) return { value: undefined, done: true }
              await new Promise<void>((resolve) => {
                queue.waiter = resolve
              })
            }
          },
        }
        // Drain the scripted events onto the queue asynchronously so the
        // ingress observes a real stream, then close it with the exit.
        void (async () => {
          for (const event of [{ type: "thread.started", threadId } as const, ...events]) {
            await Bun.sleep(5)
            queue.push(event)
          }
          queue.close()
        })()
        return {
          events: { [Symbol.asyncIterator]: () => iterator },
          exited: Effect.suspend(() => Effect.succeed({ exitCode, stderr: "" })),
        }
      }),
  }
  return { state, port }
}

const codexNeverStreams = () => {
  // A codex process that never emits and never exits: exercises the
  // first-token timeout and the process-group kill.
  const state: CodexState = { spawned: [], killed: false }
  const port: import("../../src/kernel/codex-session").CodexCliPort = {
    preflight: Effect.void,
    spawn: (input) =>
      Effect.sync(() => {
        state.spawned.push({ directory: input.directory, prompt: input.prompt, model: input.model })
        const never: AsyncIterable<import("../../src/kernel/codex-session").CodexExecEvent> = {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<import("../../src/kernel/codex-session").CodexExecEvent>>(
                () => {},
              ),
          }),
        }
        return {
          events: never,
          exited: Effect.callback<
            { exitCode: number; stderr: string },
            import("../../src/workspace/errors").WorkspaceError
          >((resume, signal) => {
            // Interruption is the process-group kill; mirror that here.
            signal.addEventListener(
              "abort",
              () => {
                state.killed = true
                resume(Effect.succeed({ exitCode: -1, stderr: "" }))
              },
              { once: true },
            )
          }),
        }
      }),
  }
  return { state, port }
}

const makeLayer = (
  provider: AgentRunProviderPort,
  trees: AgentRunWorktreesPort,
  codex: import("../../src/kernel/codex-session").CodexCliPort = defaultCodex.port,
  optionOverrides: Partial<
    import("../../src/kernel/agent-run-ingress").AgentRunIngressOptions
  > = {},
) => {
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
  return AgentRunIngressLive({ ...options, ...optionOverrides }).pipe(
    Layer.provideMerge(Layer.mergeAll(runs, sessions, waits)),
    Layer.provideMerge(Layer.succeed(AgentRunProvider, provider)),
    Layer.provideMerge(Layer.succeed(AgentRunWorktrees, trees)),
    Layer.provideMerge(Layer.succeed(ClaudeCli, claudeCli)),
    Layer.provideMerge(Layer.succeed(CodexCli, codex)),
    Layer.provideMerge(Layer.succeed(WorkSignal, signals)),
  )
}

// Success-turn codex by default: preflight passes, a thread starts, one
// message lands, the turn completes, exit 0.
const defaultCodex = makeCodexCli([
  { type: "turn.started" },
  { type: "agent_message", text: "done" },
  { type: "turn.completed", outputTokens: 42 },
])

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

  test("parents of both kinds share one custody resource per directory", async () => {
    // The production collision: a directory already held by an opencode
    // parent's resource must be reused, not fought over, when a claude
    // parent in the same directory registers later.
    const state = defaultState()
    state.telemetry.set("ses_parent", {
      directory: "/home/ben/repos/workflowd",
      outputTokens: 5,
      updatedAtMs: at.getTime(),
      idle: false,
    })
    const layer = makeLayer(makeProvider(state), worktrees([]))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* register({
          ...submission,
          parentSessionId: "ses_parent",
          resumePrompt: "wake the opencode parent",
        })
        const second = yield* register({
          ...submission,
          prompt: "A second task for the same directory's claude coordinator.",
          parentSessionId: "claude-parent-1",
          parentKind: "claude",
          parentDirectory: "/home/ben/repos/workflowd",
          resumePrompt: "wake the claude parent",
        })
        const sql = yield* SqlClient.SqlClient
        const resources = yield* sql<{
          readonly resource_id: string
        }>`SELECT resource_id FROM kernel_working_resources
          WHERE absolute_path = '/home/ben/repos/workflowd'`
        const parents = yield* sql<{
          readonly provider_kind: string
          readonly resource_id: string
        }>`SELECT provider_kind, resource_id FROM kernel_sessions
          WHERE session_id IN ('opencode-session-ses_parent', 'claude-session-claude-parent-1')`
        return { first, second, resources, parents }
      }).pipe(Effect.provide(layer)),
    )
    expect(result.first.wait?.status).toBe("registered")
    expect(result.second.wait?.status).toBe("registered")
    expect(result.resources).toHaveLength(1)
    expect(result.parents).toHaveLength(2)
    expect(new Set(result.parents.map((parent) => parent.resource_id)).size).toBe(1)
  })

  test("a cross-host claude parent registers optimistically without a local probe", async () => {
    const state = defaultState()
    const layer = makeLayer(makeProvider(state), worktrees([]))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // "claude-parent-unknown" has no local transcript (the fake probe
        // only knows claude-parent-1 on mint); a ben-arch parent must be
        // accepted anyway — its transcript can only be checked by ben-arch's
        // runner at delivery time.
        const receipt = yield* register({
          ...submission,
          parentSessionId: "claude-parent-unknown",
          parentKind: "claude",
          parentHost: "ben-arch",
          parentDirectory: "/home/ben/repos/workflowd",
          resumePrompt: "Child finished; review its branch.",
        })
        const sql = yield* SqlClient.SqlClient
        const parent = yield* sql<{
          readonly server_id: string
          readonly endpoint_identity: string
        }>`SELECT server_id, endpoint_identity FROM kernel_sessions
          WHERE session_id = 'claude-session-claude-parent-unknown'`
        return { receipt, parent }
      }).pipe(Effect.provide(layer)),
    )
    expect(result.receipt.wait?.status).toBe("registered")
    expect(result.parent).toHaveLength(1)
    expect(result.parent[0]!.server_id).toBe("ben-arch")
    expect(result.parent[0]!.endpoint_identity).toBe("claude-cli://ben-arch")
  })

  test("a claude parent on an unlisted host is refused before spawning", async () => {
    const state = defaultState()
    const layer = makeLayer(makeProvider(state), worktrees([]))
    const refusal = await refusalOf(
      Effect.runPromise(
        register({
          ...submission,
          parentSessionId: "claude-parent-1",
          parentKind: "claude",
          parentHost: "some-laptop",
          parentDirectory: "/home/ben/repos/workflowd",
          resumePrompt: "wake me",
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(refusal.reason).toBe("missing_parent_session")
    expect(refusal.detail).toContain("some-laptop")
    expect(state.created).toHaveLength(0)
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

  test("a codex route dispatches synchronously, registers codex custody, and completes inline", async () => {
    const state = defaultState()
    const trees: Array<{ repository: string; directory: string; branch: string }> = []
    const codex = makeCodexCli(
      [
        { type: "turn.started" },
        { type: "agent_message", text: "done" },
        { type: "turn.completed", outputTokens: 42 },
      ],
      0,
      undefined,
      "01thread-codex",
    )
    const layer = makeLayer(makeProvider(state), worktrees(trees), codex.port)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const receipt = yield* register({
          route: "scan",
          repository: "workflowd",
          prompt: "Scan the fixtures.",
        })
        const sql = yield* SqlClient.SqlClient
        const custody = yield* sql<{
          readonly session_id: string
          readonly provider_kind: string
          readonly endpoint_identity: string
        }>`SELECT session_id, provider_kind, endpoint_identity
          FROM kernel_sessions WHERE provider_kind = 'codex'`
        const run = yield* waitForRunState(receipt.runId, ["completed"])
        return { receipt, custody, run }
      }).pipe(Effect.provide(layer)),
    )
    expect(result.receipt.status).toBe("dispatched")
    expect(result.receipt.nativeSessionId).toBe("01thread-codex")
    expect(result.receipt.sessionId).toBe("codex-session-01thread-codex")
    expect(result.receipt.providerId).toBe("codex-cli")
    expect(result.receipt.modelId).toBe("gpt-5.1-codex")
    expect(result.receipt.outputTokens).toBe(1)
    expect(result.custody).toHaveLength(1)
    expect(result.custody[0]!.endpoint_identity).toBe("codex-cli://mint")
    // The detached continuation recorded the real usage and completed the run.
    expect(result.run?.state).toBe("completed")
    expect(result.run?.lastOutputTokens).toBe(42)
    // Codex never touched the OpenCode adapter.
    expect(state.created).toHaveLength(0)
    expect(codex.state.spawned).toHaveLength(1)
    expect(codex.state.spawned[0]!.model).toBe("gpt-5.1-codex")
    expect(codex.state.spawned[0]!.prompt).toBe("Scan the fixtures.")
  })

  test("a codex run with no model output inside the budget is refused and killed", async () => {
    const state = defaultState()
    const codex = codexNeverStreams()
    const layer = makeLayer(makeProvider(state), worktrees([]), codex.port, {
      verifyTimeoutMs: 80,
    })
    const refusal = await refusalOf(
      Effect.runPromise(
        register({ route: "scan", repository: "workflowd", prompt: "hang" }).pipe(
          Effect.provide(layer),
        ),
      ),
    )
    expect(refusal.reason).toBe("no_first_token")
    expect(refusal.detail).toContain("80ms")
    expect(codex.state.spawned).toHaveLength(1)
    // The refusal terminated the process group instead of leaving it running.
    expect(codex.state.killed).toBe(true)
  })

  test("a codex exit before output maps onto the refusal vocabulary", async () => {
    const state = defaultState()
    const unauthenticated = makeCodexCli([
      {
        type: "error",
        message:
          "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
      },
      { type: "turn.failed", message: "unexpected status 401 Unauthorized" },
    ])
    const layer = makeLayer(makeProvider(state), worktrees([]), unauthenticated.port)
    const refusal = await refusalOf(
      Effect.runPromise(
        register({ route: "scan", repository: "workflowd", prompt: "x" }).pipe(
          Effect.provide(layer),
        ),
      ),
    )
    expect(refusal.reason).toBe("provider_not_authenticated")

    // A non-zero exit with no authentication flavor stays no_first_token.
    const broken = makeCodexCli([{ type: "error", message: "model overloaded" }], 1)
    const layer2 = makeLayer(makeProvider(state), worktrees([]), broken.port)
    const refusal2 = await refusalOf(
      Effect.runPromise(
        register({ route: "scan", repository: "workflowd", prompt: "x" }).pipe(
          Effect.provide(layer2),
        ),
      ),
    )
    expect(refusal2.reason).toBe("no_first_token")
    expect(refusal2.detail).toContain("model overloaded")
  })

  test("a codex dispatch with a parent pairing is refused before anything spawns", async () => {
    const state = defaultState()
    const codex = makeCodexCli([{ type: "agent_message", text: "done" }])
    const layer = makeLayer(makeProvider(state), worktrees([]), codex.port)
    const refusal = await refusalOf(
      Effect.runPromise(
        register({
          route: "scan",
          repository: "workflowd",
          prompt: "x",
          parentSessionId: "ses_parent",
          resumePrompt: "wake me",
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(refusal.reason).toBe("invalid_wait_pairing")
    expect(codex.state.spawned).toHaveLength(0)
  })

  test("a codex route whose CLI is unusable or unauthenticated is refused at preflight", async () => {
    const state = defaultState()
    const unusable = makeCodexCli([], 0, {
      kind: "cli_unusable",
      detail: "no codex binary",
    })
    const layer = makeLayer(makeProvider(state), worktrees([]), unusable.port)
    const refusal = await refusalOf(
      Effect.runPromise(
        register({ route: "scan", repository: "workflowd", prompt: "x" }).pipe(
          Effect.provide(layer),
        ),
      ),
    )
    expect(refusal.reason).toBe("provider_not_authenticated")
    expect(unusable.state.spawned).toHaveLength(0)

    const unauthenticated = makeCodexCli([], 0, {
      kind: "not_authenticated",
      detail: "codex login status failed",
    })
    const layer2 = makeLayer(makeProvider(state), worktrees([]), unauthenticated.port)
    const refusal2 = await refusalOf(
      Effect.runPromise(
        register({ route: "scan", repository: "workflowd", prompt: "x" }).pipe(
          Effect.provide(layer2),
        ),
      ),
    )
    expect(refusal2.reason).toBe("provider_not_authenticated")
    expect(unauthenticated.state.spawned).toHaveLength(0)
    expect(state.created).toHaveLength(0)
  })

  test("a name served by both providers is refused ambiguous and never spawns", async () => {
    const state = defaultState()
    const codex = makeCodexCli([{ type: "agent_message", text: "done" }])
    const layer = makeLayer(makeProvider(state), worktrees([]), codex.port, {
      codexRoutes: [{ name: "implement", modelID: null }],
    })
    const refusal = await refusalOf(
      Effect.runPromise(register(submission).pipe(Effect.provide(layer))),
    )
    expect(refusal.reason).toBe("ambiguous_route")
    expect(codex.state.spawned).toHaveLength(0)
    expect(state.created).toHaveLength(0)
  })
})

/** Polls the agent-run row until it reaches one of the given states; the
 * codex completion runs on a detached fiber, so its terminal state lands a
 * few scheduler ticks after the receipt. */
const waitForRunState = (runId: string, states: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const store = yield* AgentRunStore
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const run = yield* store.read(runId)
      if (run !== null && states.includes(run.state)) return run
      yield* Effect.sleep(5)
    }
    return yield* store.read(runId)
  })
