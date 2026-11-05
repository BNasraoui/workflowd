import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeAgentRunCliDispatcher, type AgentRunCliStore } from "../../src/kernel/agent-run-cli"
import { makeClaudeDispatchCli } from "../../src/kernel/claude-dispatch"
import { AgentRunRefusalError } from "../../src/kernel/agent-run-ingress"
import type { AgentRunRecord } from "../../src/kernel/agent-run-store"

/**
 * workflowd-8wo4: the user systemd manager is simulated, but the worker is the
 * real src/kernel/claude-worker.ts process driving a fake `claude` binary. A
 * `systemctl --user show` query can fail the way it does when the controller's
 * own stop signal kills it (exit 143, no output) or when the manager stalls.
 */
const fakeClaude = (root: string) => `#!/usr/bin/env bun
import { existsSync } from "node:fs"
await Bun.stdin.text()
const say = (value) => console.log(JSON.stringify(value))
say({ type: "system", subtype: "init", session_id: "native-session", model: "claude-opus-5-5" })
say({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } })
while (!existsSync(${JSON.stringify(join(root, "release"))})) await Bun.sleep(5)
const code = Number(await Bun.file(${JSON.stringify(join(root, "release"))}).text())
say({ type: "assistant", message: { content: [{ type: "text", text: "final answer" }] } })
say({ type: "result", is_error: code !== 0, usage: { output_tokens: 7 }, result: "boom" })
process.exit(code)
`

const simulatedManager = (workerPath: string) => {
  let child: ReturnType<typeof Bun.spawn> | undefined
  let description = ""
  let failedShows = 0
  let pendingFailures = 0
  return {
    failNextShows: (count: number) => {
      pendingFailures = count
    },
    failedShows: () => failedShows,
    alive: () => child !== undefined && child.exitCode === null && child.signalCode === null,
    exited: () => child?.exited,
    kill: () => child?.kill("SIGKILL"),
    runCommand: async (command: ReadonlyArray<string>) => {
      if (command[0] === "systemd-run") {
        description = command.find((part) => part.startsWith("--description="))!.slice(14)
        const cwd = command.find((part) => part.startsWith("--working-directory="))!.slice(20)
        const worker = command.indexOf(workerPath)
        child = Bun.spawn([process.execPath, ...command.slice(worker)], {
          cwd,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        })
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      if (command.includes("show")) {
        if (pendingFailures > 0) {
          pendingFailures -= 1
          failedShows += 1
          // A systemctl child killed by SIGTERM: no properties, status 143.
          return { exitCode: 143, stdout: "", stderr: "" }
        }
        const running = child !== undefined && child.exitCode === null && child.signalCode === null
        return {
          exitCode: 0,
          stdout:
            `LoadState=loaded\nMainPID=${running ? child!.pid : 0}\nInvocationID=invocation-1\n` +
            `Description=${description}\nActiveState=${running ? "active" : "inactive"}\n` +
            `SubState=${running ? "running" : "dead"}\nResult=success\n`,
          stderr: "",
        }
      }
      if (command.includes("stop") || command.includes("kill")) {
        child?.kill("SIGKILL")
        await child?.exited
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" }
    },
  }
}

const run = (directory: string): AgentRunRecord => ({
  runId: "agent-run-8wo4",
  callerMailboxId: "agent-mailbox-8wo4",
  route: "opus",
  providerId: "claude-cli",
  modelId: "claude-opus-5-5",
  agent: "worker",
  repository: "workflowd",
  directory,
  prompt: "work for a while",
  parentSessionId: null,
  resumePrompt: null,
  resourceId: null,
  sessionId: null,
  nativeSessionId: null,
  state: "accepted",
  attempt: 1,
  maxAttempts: 3,
  lastOutputTokens: 0,
  lastProgressAt: null,
  diagnostic: null,
  createdAt: new Date("2026-11-05T00:31:10Z"),
  updatedAt: new Date("2026-11-05T00:31:10Z"),
  executorKind: "claude",
})

type Terminal =
  | { readonly kind: "complete"; readonly finalMessage: string }
  | { readonly kind: "operator_required"; readonly diagnostic: string }

const harness = async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-8wo4-"))
  const binary = join(root, "claude")
  await writeFile(binary, fakeClaude(root), { mode: 0o700 })
  const workerPath = new URL("../../src/kernel/claude-worker.ts", import.meta.url).pathname
  const manager = simulatedManager(workerPath)
  const cli = makeClaudeDispatchCli({
    binary,
    custodyRoot: join(root, "custody"),
    pollIntervalMs: 5,
    runCommand: manager.runCommand,
  })
  const terminals: Terminal[] = []
  const settled = Promise.withResolvers<void>()
  const store: AgentRunCliStore = {
    claimSpawn: () => Effect.void,
    abandonLaunch: () => Effect.void,
    markSpawned: () => Effect.void,
    markVerified: () => Effect.void,
    recordProgress: () => Effect.void,
    fail: () => Effect.die("first token was produced"),
    cancel: () => Effect.void,
    listActiveByExecutor: () => Effect.succeed([]),
    complete: (input) =>
      Effect.sync(() => {
        terminals.push({ kind: "complete", finalMessage: input.finalMessage ?? "" })
        settled.resolve()
      }),
    operatorRequired: (input) =>
      Effect.sync(() => {
        terminals.push({ kind: "operator_required", diagnostic: input.diagnostic })
        settled.resolve()
      }),
  }
  const runtime = makeAgentRunCliDispatcher({
    executor: { kind: "claude", sessionCustodyId: (id) => `claude-session-${id}` },
    cli,
    store,
    worktrees: { create: () => Effect.void },
    signals: { subscribe: () => Effect.die("unused"), wake: () => Effect.void },
    ensureResource: () => Effect.succeed("resource-8wo4"),
    ensureSession: () => Effect.succeed("claude-session-native-session"),
    refuse: (reason, detail) => new AgentRunRefusalError({ reason, detail }),
    verifyTimeoutMs: 10_000,
    progressWindowMs: 60_000,
    observationRetryMs: 5,
  })
  const dispatch = () =>
    Effect.runPromise(
      runtime.dispatch(
        run(root),
        { name: "opus", modelID: "claude-opus-5-5" },
        { repositoryDirectory: root, resourceId: "resource-8wo4", short: "8wo4" },
        new Date(),
      ),
    )
  const release = (exitCode: number) => writeFile(join(root, "release"), String(exitCode))
  const cleanup = async () => {
    manager.kill()
    await manager.exited()
    await rm(root, { recursive: true, force: true })
  }
  return { root, manager, terminals, settled: settled.promise, dispatch, release, cleanup }
}

const waitFor = async (condition: () => boolean, label: string) => {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

test("a lost manager observation never marks a live Claude worker failed", async () => {
  const h = await harness()
  try {
    await h.dispatch()
    h.manager.failNextShows(2)
    await waitFor(() => h.manager.failedShows() === 2, "the failed observations")
    // Observation is lost while the worker keeps working.
    await Bun.sleep(100)
    expect(h.manager.alive()).toBe(true)
    expect(h.terminals).toEqual([])
    // The supervisor re-attaches and records the worker's real end in the mailbox.
    await h.release(0)
    await h.settled
    expect(h.terminals).toEqual([{ kind: "complete", finalMessage: "final answer" }])
  } finally {
    await h.cleanup()
  }
}, 20_000)

test("a Claude worker that really fails still reaches operator_required", async () => {
  const h = await harness()
  try {
    await h.dispatch()
    h.manager.failNextShows(1)
    await waitFor(() => h.manager.failedShows() === 1, "the failed observations")
    await h.release(3)
    await h.settled
    expect(h.manager.alive()).toBe(false)
    expect(h.terminals).toHaveLength(1)
    expect(h.terminals[0]).toMatchObject({
      kind: "operator_required",
      diagnostic: expect.stringContaining("claude_failed: exit 3"),
    })
  } finally {
    await h.cleanup()
  }
}, 20_000)

test("a Claude worker killed while observation is lost reaches operator_required", async () => {
  const h = await harness()
  try {
    await h.dispatch()
    h.manager.failNextShows(2)
    await waitFor(() => h.manager.failedShows() === 2, "the failed observations")
    h.manager.kill()
    await h.manager.exited()
    await h.settled
    expect(h.terminals).toHaveLength(1)
    // The worker's real end is recorded, not the lost observation.
    expect(h.terminals).toEqual([
      {
        kind: "operator_required",
        diagnostic:
          "claude_failed: exit -1; stderr: codex transient unit exited without a result (success)",
      },
    ])
  } finally {
    await h.cleanup()
  }
}, 20_000)

test("a lost observation whose custody also vanished reaches operator_required", async () => {
  const h = await harness()
  try {
    await h.dispatch()
    h.manager.failNextShows(2)
    await waitFor(() => h.manager.failedShows() === 2, "the failed observations")
    await rm(join(h.root, "custody", "agent-run-8wo4", "manifest.json"))
    await h.settled
    expect(h.terminals).toEqual([
      {
        kind: "operator_required",
        diagnostic: "claude_observation_lost: durable process custody is missing",
      },
    ])
  } finally {
    await h.cleanup()
  }
}, 20_000)
