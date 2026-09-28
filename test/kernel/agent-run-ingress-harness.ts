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
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { ClaudeCli, type ClaudeCliPort } from "../../src/kernel/claude-session"
import { CodexCli } from "../../src/kernel/codex-session"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { KernelSessionStoreLive } from "../../src/kernel/session-store"
import type { OpenCodeSessionTelemetry } from "../../src/opencode/adapter"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignal, type WorkSignalPort } from "../../src/work-signal"

export const at = new Date("2026-08-30T10:00:00.000Z")

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
  worktreeRoot: "/var/lib/workflowd-test/worktrees",
  verifyTimeoutMs: 50,
  verifyPollIntervalMs: 10,
  progressWindowMs: 10 * 60_000,
  maxAttempts: 3,
  claudeHosts: ["ben-arch"],
  identity,
}

export type ProviderState = {
  created: Array<{ directory: string; agent: string; model: unknown }>
  prompted: Array<{ sessionID: string; text: string }>
  aborted: Array<string>
  telemetry: Map<string, OpenCodeSessionTelemetry | undefined>
  providers: ReadonlyArray<string>
  models: ReadonlyArray<{ providerID: string; id: string }>
}

export const defaultState = (): ProviderState => ({
  created: [],
  prompted: [],
  aborted: [],
  telemetry: new Map([
    [
      "ses_child",
      {
        directory: "/var/lib/workflowd-test/worktrees/agent-runs/x",
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

export const makeProvider = (state: ProviderState): AgentRunProviderPort => ({
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

export const worktrees = (
  created: Array<{ repository: string; directory: string; branch: string }>,
) =>
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

export type CodexState = {
  spawned: Array<{ directory: string; prompt: string; model: string | null }>
  killed: boolean
}

const neverCodexEvent = () =>
  new Promise<IteratorResult<import("../../src/kernel/codex-session").CodexExecEvent>>(() => {})

export const makeCodexCli = (
  events: ReadonlyArray<import("../../src/kernel/codex-session").CodexExecEvent>,
  exitCode = 0,
  preflightError?: import("../../src/kernel/codex-session").CodexPreflightError,
  threadId = "01a09976-e799-7c52-9759-8b76d692b755",
) => {
  const state: CodexState = { spawned: [], killed: false }
  const port: import("../../src/kernel/codex-session").CodexCliPort = {
    preflight: preflightError === undefined ? Effect.void : Effect.fail(preflightError),
    attach: () => Effect.succeed(null),
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
        void (async () => {
          for (const event of [{ type: "thread.started", threadId } as const, ...events]) {
            await Bun.sleep(5)
            queue.push(event)
          }
          queue.close()
        })()
        return {
          executionId: `test-${input.runId}.service`,
          events: { [Symbol.asyncIterator]: () => iterator },
          exited: Effect.suspend(() => Effect.succeed({ exitCode, stderr: "" })),
          cancel: Effect.sync(() => {
            state.killed = true
          }),
        }
      }),
  }
  return { state, port }
}

export const codexNeverStreams = () => {
  const state: CodexState = { spawned: [], killed: false }
  const port: import("../../src/kernel/codex-session").CodexCliPort = {
    preflight: Effect.void,
    attach: () => Effect.succeed(null),
    spawn: (input) =>
      Effect.sync(() => {
        state.spawned.push({ directory: input.directory, prompt: input.prompt, model: input.model })
        const never: AsyncIterable<import("../../src/kernel/codex-session").CodexExecEvent> = {
          [Symbol.asyncIterator]: () => ({
            next: neverCodexEvent,
          }),
        }
        return {
          executionId: `test-${input.runId}.service`,
          events: never,
          exited: Effect.callback<
            { exitCode: number; stderr: string },
            import("../../src/workspace/errors").WorkspaceError
          >((resume, signal) => {
            signal.addEventListener(
              "abort",
              () => {
                state.killed = true
                resume(Effect.succeed({ exitCode: -1, stderr: "" }))
              },
              { once: true },
            )
          }),
          cancel: Effect.sync(() => {
            state.killed = true
          }),
        }
      }),
  }
  return { state, port }
}

export const makeLayer = (
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

const defaultCodex = makeCodexCli([
  { type: "turn.started" },
  { type: "agent_message", text: "done" },
  { type: "turn.completed", outputTokens: 42 },
])

export const submission = {
  route: "implement",
  repository: "workflowd",
  prompt: "Fix the flaky retry test and push the branch.",
}

export const register = (input: import("../../src/agent-run-contract").AgentRunSubmission) =>
  Effect.gen(function* () {
    const ingress = yield* AgentRunIngress
    return yield* ingress.register(input, at)
  })

export const refusalOf = async <A>(promise: Promise<A>): Promise<AgentRunRefusalError> => {
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
