import { expect, test } from "bun:test"
import { Effect } from "effect"
import {
  makeAgentRunCodexDispatcher,
  type AgentRunCodexStore,
} from "../../src/kernel/agent-run-codex"
import { AgentRunRefusalError } from "../../src/kernel/agent-run-ingress"
import type { CodexCliPort } from "../../src/kernel/codex-session"
import type { AgentRunRecord } from "../../src/kernel/agent-run-store"
import type { AgentRunWorktreesPort } from "../../src/kernel/agent-run-worktrees"
import type { WorkSignalPort } from "../../src/work-signal"

const record: AgentRunRecord = {
  runId: "agent-run-recover",
  route: "scan",
  providerId: "codex-cli",
  modelId: "gpt-5.1-codex",
  agent: "worker",
  repository: "workflowd",
  directory: "/work/recover",
  prompt: "finish",
  parentSessionId: null,
  resumePrompt: null,
  resourceId: "resource-1",
  sessionId: "codex-session-thread-1",
  nativeSessionId: "thread-1",
  state: "verified",
  attempt: 1,
  maxAttempts: 3,
  lastOutputTokens: 1,
  lastProgressAt: new Date("2026-09-29T00:00:00Z"),
  diagnostic: null,
  createdAt: new Date("2026-09-29T00:00:00Z"),
  updatedAt: new Date("2026-09-29T00:00:00Z"),
}

test("startup recovery owns spawning, spawned, and verified Codex transition boundaries", async () => {
  const states = ["spawning", "spawned", "verified"] as const
  const records = states.map((state, index) => ({
    ...record,
    runId: `agent-run-recover-${state}`,
    state,
    resourceId: state === "spawning" ? null : "resource-1",
    sessionId: state === "spawning" ? null : `codex-session-thread-${index}`,
    nativeSessionId: state === "spawning" ? null : `thread-${index}`,
  }))
  const completed = new Set<string>()
  let outputTokens = 0
  const store: AgentRunCodexStore = {
    claimSpawn: () => Effect.void,
    markSpawned: (input) =>
      Effect.sync(() => {
        const item = records.find((candidate) => candidate.runId === input.runId)!
        Object.assign(item, {
          state: "spawned",
          resourceId: input.resourceId,
          sessionId: input.sessionId,
          nativeSessionId: input.nativeSessionId,
        })
      }),
    markVerified: (input) =>
      Effect.sync(() => {
        Object.assign(
          records.find((candidate) => candidate.runId === input.runId)!,
          {
            state: "verified",
          },
        )
      }),
    fail: () => Effect.void,
    abandonLaunch: () => Effect.void,
    listActiveByProvider: () => Effect.succeed(records),
    recordProgress: (input: { readonly outputTokens: number }) =>
      Effect.sync(() => {
        outputTokens = input.outputTokens
      }),
    complete: (input) =>
      Effect.sync(() => {
        completed.add(input.runId)
      }),
    cancel: () => Effect.void,
    operatorRequired: () => Effect.void,
  }
  const codex: CodexCliPort = {
    preflight: Effect.void,
    spawn: () => Effect.die("unused"),
    attach: () =>
      Effect.succeed({
        executionId: "workflowd-agent-recover.service",
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "thread.started" as const, threadId: "thread-recovered" }
            yield { type: "agent_message" as const, text: "done after restart" }
            yield { type: "turn.completed" as const, outputTokens: 73 }
          },
        },
        exited: Effect.succeed({ exitCode: 0, stderr: "" }),
        cancel: Effect.void,
      }),
  }
  const runtime = makeAgentRunCodexDispatcher({
    codex,
    store,
    worktrees: { create: () => Effect.void } satisfies AgentRunWorktreesPort,
    signals: {
      subscribe: () => Effect.die("unused"),
      wake: () => Effect.void,
    } satisfies WorkSignalPort,
    ensureResource: () => Effect.succeed("resource-1"),
    ensureSession: () => Effect.succeed("codex-session-thread-1"),
    refuse: (reason, detail) => new AgentRunRefusalError({ reason, detail }),
    verifyTimeoutMs: 50,
    progressWindowMs: 1_000,
  })

  expect(await Effect.runPromise(runtime.recover)).toBe(3)
  for (let attempt = 0; attempt < 20 && completed.size < 3; attempt += 1) await Bun.sleep(5)
  expect([...completed].sort()).toEqual(records.map(({ runId }) => runId).sort())
  expect(records.every(({ state }) => state === "verified")).toBe(true)
  expect(outputTokens).toBe(73)
})
