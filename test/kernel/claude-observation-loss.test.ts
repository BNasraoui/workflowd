import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { makeAgentRunCliDispatcher, type AgentRunCliStore } from "../../src/kernel/agent-run-cli"
import { makeClaudeDispatchCli } from "../../src/kernel/claude-dispatch"
import { makeCodexCli, parseCodexExecEvent } from "../../src/kernel/codex-session"
import { makeHostCli } from "../../src/agent-host/client"
import { agentHostUnitName, HostRequest } from "../../src/agent-host/protocol"
import {
  ObservationUnavailableError,
  type CliPort,
  type CliRunProcess,
} from "../../src/kernel/cli-process-contract"
import { AgentRunRefusalError } from "../../src/kernel/agent-run-ingress"
import type { AgentRunRecord } from "../../src/kernel/agent-run-store"

/**
 * workflowd-8wo4: the user systemd manager (or the agent host) is simulated, but
 * the worker is the real claude-worker.ts / codex-worker.ts process driving a
 * fake native binary that keeps working until the test releases it. A
 * `systemctl --user show` query can fail the way it does when the controller's
 * own stop signal kills it (exit 143, no output).
 */
type Kind = "claude" | "codex"

const fakeNative = (kind: Kind, root: string) => {
  const file = (name: string) => JSON.stringify(join(root, name))
  const events =
    kind === "claude"
      ? {
          start: `say({ type: "system", subtype: "init", session_id: "native-session", model: "native-model" })`,
          message: (text: string) =>
            `say({ type: "assistant", message: { content: [{ type: "text", text: ${text} }] } })`,
          end: `say({ type: "result", is_error: code !== 0, usage: { output_tokens: 7 }, result: "boom" })`,
        }
      : {
          start: `say({ type: "thread.started", thread_id: "native-session" })`,
          message: (text: string) =>
            `say({ type: "item.completed", item: { type: "agent_message", text: ${text} } })`,
          end: `say({ type: "turn.completed", usage: { output_tokens: 7 } })`,
        }
  return `#!/usr/bin/env bun
import { existsSync } from "node:fs"
await Bun.stdin.text()
const say = (value) => console.log(JSON.stringify(value))
while (!existsSync(${file("go")})) await Bun.sleep(5)
${events.start}
${events.message(`"working"`)}
while (!existsSync(${file("release")})) await Bun.sleep(5)
const code = Number(await Bun.file(${file("release")}).text())
${events.message(`"final answer"`)}
${events.end}
process.exit(code)
`
}

/** Shared by the systemd tests: one real worker child behind a scripted manager. */
const simulatedManager = (workerPath: string) => {
  let child: ReturnType<typeof Bun.spawn> | undefined
  let description = ""
  let invocationId = "invocation-1"
  let shows = 0
  let failedShows = 0
  let failing: (show: number) => boolean = () => false
  let lastCommandAt = Date.now()
  const alive = () => child !== undefined && child.exitCode === null && child.signalCode === null
  return {
    /** Fail the shows for which the plan holds, numbered from 1. */
    failShows: (plan: (show: number) => boolean) => {
      failing = plan
    },
    failNextShows: (count: number) => {
      const until = shows + count
      failing = (show) => show <= until
    },
    shows: () => shows,
    failedShows: () => failedShows,
    lastCommandAt: () => lastCommandAt,
    reuseUnit: () => {
      invocationId = "invocation-reused"
    },
    alive,
    exited: () => child?.exited,
    kill: () => child?.kill("SIGKILL"),
    runCommand: async (command: ReadonlyArray<string>) => {
      lastCommandAt = Date.now()
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
        shows += 1
        if (failing(shows)) {
          failedShows += 1
          // A systemctl child killed by SIGTERM: no properties, status 143.
          return { exitCode: 143, stdout: "", stderr: "" }
        }
        const running = alive()
        return {
          exitCode: 0,
          stdout:
            `LoadState=loaded\nMainPID=${running ? child!.pid : 0}\nInvocationID=${invocationId}\n` +
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

const RUN_ID = "agent-run-8wo4"

const run = (kind: Kind, directory: string, state: AgentRunRecord["state"] = "accepted") =>
  ({
    runId: RUN_ID,
    callerMailboxId: "agent-mailbox-8wo4",
    route: "native",
    providerId: `${kind}-cli`,
    modelId: "native-model",
    agent: "worker",
    repository: "workflowd",
    directory,
    prompt: "work for a while",
    parentSessionId: null,
    resumePrompt: null,
    resourceId: state === "accepted" ? null : "resource-8wo4",
    sessionId: state === "accepted" ? null : `${kind}-session-native-session`,
    nativeSessionId: state === "accepted" ? null : "native-session",
    state,
    attempt: 1,
    maxAttempts: 3,
    lastOutputTokens: state === "accepted" ? 0 : 1,
    lastProgressAt: null,
    diagnostic: null,
    createdAt: new Date("2026-11-05T00:31:10Z"),
    updatedAt: new Date("2026-11-05T00:31:10Z"),
    executorKind: kind,
  }) satisfies AgentRunRecord

type Terminal =
  | { readonly kind: "complete"; readonly finalMessage: string }
  | { readonly kind: "operator_required" | "failed"; readonly diagnostic: string }

type Transient = Extract<CliPort, { readonly ownership: "transient-exec" }>

const transient = (cli: CliPort): Transient => {
  if (cli.ownership !== "transient-exec") throw new Error("fixture requires transient custody")
  return cli
}

/** The dispatcher and store around one CLI port, recording every terminal write. */
const supervisor = (
  kind: Kind,
  root: string,
  cli: CliPort,
  options: { readonly retryLimit?: number; readonly active?: ReadonlyArray<AgentRunRecord> } = {},
) => {
  const terminals: Terminal[] = []
  let first = Promise.withResolvers<void>()
  const record = (terminal: Terminal) =>
    Effect.sync(() => {
      terminals.push(terminal)
      first.resolve()
    })
  const store: AgentRunCliStore = {
    claimSpawn: () => Effect.void,
    abandonLaunch: () => Effect.void,
    markSpawned: () => Effect.void,
    markVerified: () => Effect.void,
    recordProgress: () => Effect.void,
    fail: (input) => record({ kind: "failed", diagnostic: input.diagnostic }),
    cancel: () => Effect.void,
    listActiveByExecutor: () => Effect.succeed(options.active ?? []),
    complete: (input) => record({ kind: "complete", finalMessage: input.finalMessage ?? "" }),
    operatorRequired: (input) =>
      record({ kind: "operator_required", diagnostic: input.diagnostic }),
  }
  const runtime = makeAgentRunCliDispatcher({
    executor: { kind, sessionCustodyId: (id) => `${kind}-session-${id}` },
    cli,
    store,
    worktrees: { create: () => Effect.void },
    signals: { subscribe: () => Effect.die("unused"), wake: () => Effect.void },
    ensureResource: () => Effect.succeed("resource-8wo4"),
    ensureSession: () => Effect.succeed(`${kind}-session-native-session`),
    refuse: (reason, detail) => new AgentRunRefusalError({ reason, detail }),
    verifyTimeoutMs: 10_000,
    progressWindowMs: 60_000,
    observationRetryMs: 5,
    ...(options.retryLimit === undefined ? {} : { observationRetryLimit: options.retryLimit }),
  })
  return {
    runtime,
    terminals,
    firstTerminal: () => first.promise,
    reset: () => {
      first = Promise.withResolvers<void>()
    },
    dispatch: () =>
      Effect.runPromise(
        runtime.dispatch(
          run(kind, root),
          { name: "native", modelID: "native-model" },
          { repositoryDirectory: root, resourceId: "resource-8wo4", short: "8wo4" },
          new Date(),
        ),
      ),
  }
}

const harness = async (
  kind: Kind = "claude",
  options: {
    readonly gated?: boolean
    readonly retryLimit?: number
    readonly observationTimeoutMs?: number
    readonly wrap?: (cli: Transient) => Transient
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-8wo4-"))
  const binary = join(root, kind)
  await writeFile(binary, fakeNative(kind, root), { mode: 0o700 })
  if (options.gated !== true) await writeFile(join(root, "go"), "")
  const workerPath = new URL(`../../src/kernel/${kind}-worker.ts`, import.meta.url).pathname
  const manager = simulatedManager(workerPath)
  const native = transient(
    (kind === "claude" ? makeClaudeDispatchCli : makeCodexCli)({
      binary,
      custodyRoot: join(root, "custody"),
      pollIntervalMs: 5,
      runCommand: manager.runCommand,
      ...(options.observationTimeoutMs === undefined
        ? {}
        : { observationTimeoutMs: options.observationTimeoutMs }),
    }),
  )
  const cli = options.wrap?.(native) ?? native
  const supervised = supervisor(
    kind,
    root,
    cli,
    options.retryLimit === undefined ? {} : { retryLimit: options.retryLimit },
  )
  /** The first terminal write, then no manager traffic: the supervisor has settled. */
  const settle = async () => {
    await supervised.firstTerminal()
    await waitFor(() => Date.now() - manager.lastCommandAt() > 250, "the supervisor to settle")
    return supervised.terminals
  }
  const cleanup = async () => {
    manager.kill()
    await manager.exited()
    await rm(root, { recursive: true, force: true })
  }
  return {
    ...supervised,
    kind,
    root,
    cli: native,
    manager,
    settle,
    go: () => writeFile(join(root, "go"), ""),
    release: (exitCode: number) => writeFile(join(root, "release"), String(exitCode)),
    manifest: join(root, "custody", RUN_ID, "manifest.json"),
    cleanup,
  }
}

const waitFor = async (condition: () => boolean, label: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

for (const kind of ["claude", "codex"] as const)
  test(`a lost manager observation never marks a live ${kind} worker failed`, async () => {
    const h = await harness(kind)
    try {
      await h.dispatch()
      // Six unanswered shows in a row: the reader and the exit observer can lose at
      // most one each, so at least four of them are re-attaches that fail too.
      h.manager.failNextShows(6)
      await waitFor(() => h.manager.failedShows() === 6, "the failed observations")
      await Bun.sleep(50)
      expect(h.manager.alive()).toBe(true)
      expect(h.terminals).toEqual([])
      // The supervisor re-attaches and records the worker's real end in the mailbox.
      await h.release(0)
      expect(await h.settle()).toEqual([{ kind: "complete", finalMessage: "final answer" }])
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
    const terminals = await h.settle()
    expect(h.manager.alive()).toBe(false)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
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
    // The worker's real end is recorded, not the lost observation.
    expect(await h.settle()).toEqual([
      {
        kind: "operator_required",
        diagnostic:
          "claude_failed: exit -1; stderr: claude transient unit exited without a result (success)",
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
    // The manager stays unreachable, so every re-attach fails until the manifest is
    // gone; only then does attach answer, with missing custody.
    h.manager.failShows(() => true)
    await waitFor(() => h.manager.failedShows() >= 3, "the failed observations")
    await rm(h.manifest)
    expect(await h.settle()).toEqual([
      {
        kind: "operator_required",
        diagnostic: "claude_observation_lost: durable process custody is missing",
      },
    ])
  } finally {
    await h.cleanup()
  }
}, 20_000)

test("a reused unit is lost custody, not a lost observation to retry", async () => {
  const h = await harness()
  try {
    await h.dispatch()
    h.manager.reuseUnit()
    const terminals = await h.settle()
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      kind: "operator_required",
      diagnostic: expect.stringMatching(
        /^claude_observation_lost: .*claude transient unit invocation identity mismatch/,
      ),
    })
    // Nothing was killed: the operator decides what the reused unit is.
    expect(h.manager.alive()).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 20_000)

test("a result record that fails to decode is not retried", async () => {
  const h = await harness()
  try {
    await h.dispatch()
    await writeFile(
      join(h.root, "custody", RUN_ID, "result.json"),
      JSON.stringify({ version: 1, exitCode: "zero" }),
    )
    const terminals = await h.settle()
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      kind: "operator_required",
      diagnostic: expect.stringMatching(/^claude_observation_lost: /),
    })
  } finally {
    await h.cleanup()
  }
}, 20_000)

test("an observation that never answers stops after the retry budget", async () => {
  const h = await harness("claude", { retryLimit: 3 })
  try {
    await h.dispatch()
    h.manager.failShows(() => true)
    const terminals = await h.settle()
    expect(terminals).toEqual([
      {
        kind: "operator_required",
        diagnostic: expect.stringMatching(
          /^claude_observation_lost: observation unavailable after 3 re-attach attempts: /,
        ),
      },
    ])
    expect(h.manager.alive()).toBe(true)
  } finally {
    await h.cleanup()
  }
}, 20_000)

test("a re-attach that answers does not reset the backoff or the retry budget", async () => {
  const h = await harness("claude", { retryLimit: 4 })
  try {
    await h.dispatch()
    // Every other show fails: each re-attach can succeed, then observation is lost again.
    const started = Date.now()
    h.manager.failShows((show) => show % 2 === 0)
    const terminals = await h.settle()
    expect(terminals).toEqual([
      {
        kind: "operator_required",
        diagnostic: expect.stringMatching(
          /^claude_observation_lost: observation unavailable after 4 re-attach attempts: /,
        ),
      },
    ])
    // 5 + 10 + 20 + 40 ms: the delay kept doubling across re-attaches.
    expect(Date.now() - started).toBeGreaterThanOrEqual(75)
  } finally {
    await h.cleanup()
  }
}, 20_000)

test("a lost first-token observation re-attaches instead of refusing a live worker", async () => {
  const h = await harness("claude", { gated: true })
  try {
    // Show 1 is the launch's own attach; the next three are first-token observation.
    h.manager.failShows((show) => show >= 2 && show <= 4)
    const dispatched = h.dispatch()
    await waitFor(() => h.manager.failedShows() === 3, "the failed observations")
    await h.go()
    expect(await dispatched).toMatchObject({ nativeSessionId: "native-session" })
    expect(h.terminals).toEqual([])
    expect(h.manager.alive()).toBe(true)
    await h.release(0)
    expect(await h.settle()).toEqual([{ kind: "complete", finalMessage: "final answer" }])
  } finally {
    await h.cleanup()
  }
}, 20_000)

test("a reader that loses observation while the exit is seen still records the real final message", async () => {
  let armed = false
  // Only the event reader loses a query; the exit observer sees the real exit 0.
  const loseReader = (process: CliRunProcess, workerExited: () => Promise<unknown>) => {
    const iterator = process.events[Symbol.asyncIterator]()
    return {
      ...process,
      events: {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (!armed) return iterator.next()
            armed = false
            await workerExited()
            throw new ObservationUnavailableError("command timed out after 5000ms")
          },
        }),
      },
    } satisfies CliRunProcess
  }
  let exited: () => Promise<unknown> = async () => undefined
  const h = await harness("claude", {
    wrap: (cli) => ({
      ...cli,
      spawn: (input) => cli.spawn(input).pipe(Effect.map((p) => loseReader(p, exited))),
    }),
  })
  exited = async () => h.manager.exited()
  try {
    await h.dispatch()
    armed = true
    await h.release(0)
    expect(await h.settle()).toEqual([{ kind: "complete", finalMessage: "final answer" }])
  } finally {
    await h.cleanup()
  }
}, 20_000)

test("a controller stopped during a failed show leaves the run for recover()", async () => {
  const h = await harness()
  try {
    await h.dispatch()
    // The controller's stop kills its systemctl children: shows answer 143.
    h.manager.failShows(() => true)
    await waitFor(() => h.manager.failedShows() >= 4, "re-attaches during the stop")
    await Effect.runPromise(h.runtime.shutdown)
    const stoppedAt = h.manager.shows()
    // An uninterrupted supervisor would re-attach again within 40-160 ms.
    await Bun.sleep(300)
    expect(h.manager.shows()).toBe(stoppedAt)
    expect(h.terminals).toEqual([])
    expect(h.manager.alive()).toBe(true)

    // The next start recovers the still-active run, survives another lost
    // observation, and records the worker's real end exactly once.
    h.manager.failShows(() => false)
    const next = supervisor("claude", h.root, h.cli, {
      active: [run("claude", h.root, "verified")],
    })
    expect(await Effect.runPromise(next.runtime.recover)).toBe(1)
    const failed = h.manager.failedShows()
    h.manager.failNextShows(2)
    await waitFor(() => h.manager.failedShows() === failed + 2, "the observation lost again")
    await h.release(0)
    await next.firstTerminal()
    await waitFor(() => Date.now() - h.manager.lastCommandAt() > 250, "the supervisor to settle")
    expect(next.terminals).toEqual([{ kind: "complete", finalMessage: "final answer" }])
    expect(h.terminals).toEqual([])
  } finally {
    await h.cleanup()
  }
}, 20_000)

test("a re-attach keeps the first attach's observation deadline", async () => {
  const h = await harness("claude", { observationTimeoutMs: 1_000 })
  try {
    const started = Date.now()
    await Effect.runPromise(
      h.cli.spawn({ runId: RUN_ID, directory: h.root, prompt: "go", model: null }),
    )
    await Bun.sleep(700)
    const again = await Effect.runPromise(h.cli.attach({ runId: RUN_ID }))
    const exit = await Effect.runPromise(again!.exited)
    expect(exit.stderr).toBe("claude observation timed out after 1000ms")
    // A fresh deadline would have run until about 1700 ms.
    expect(Date.now() - started).toBeLessThan(1_500)
  } finally {
    await h.cleanup()
  }
}, 20_000)

/** A scripted agent host: one owned launch per run, reachable or not. */
const fakeHost = async (root: string) => {
  const socket = join(root, "host.sock")
  type Launch = { launchId: string; active: boolean; exitCode: number | null; events: string }
  let launch: Launch = {
    launchId: "11111111-1111-4111-8111-111111111111",
    active: true,
    exitCode: null,
    events:
      JSON.stringify({ type: "thread.started", thread_id: "native-session" }) +
      "\n" +
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "working" } }) +
      "\n",
  }
  let reachable = true
  let refused = 0
  let lastRequestAt = Date.now()
  const owned = (runId: string) => ({
    runId,
    launchId: launch.launchId,
    unit: agentHostUnitName(runId),
    invocationId: `invocation-${launch.launchId.slice(0, 1)}`,
    uid: 12345,
    pid: 0,
    started: new Date().toISOString(),
    active: launch.active,
    exitCode: launch.exitCode,
  })
  const connections = new Set<Socket>()
  const server = createServer((connection) => {
    connections.add(connection)
    connection.on("close", () => connections.delete(connection))
    lastRequestAt = Date.now()
    if (!reachable) {
      refused += 1
      connection.destroy()
      return
    }
    let data = ""
    connection.on("data", (chunk) => {
      data += chunk.toString()
      if (!data.includes("\n")) return
      const request = Schema.decodeUnknownSync(HostRequest)(JSON.parse(data))
      const reply = (value: unknown) => connection.end(JSON.stringify(value) + "\n")
      if (request.operation === "listOwned")
        return reply({ admitted: false, reason: "unsupported" })
      if (request.operation === "start" || request.operation === "inspect")
        return reply({ admitted: true, process: owned(request.runId) })
      if (request.operation === "exchange") {
        if (request.launchId !== launch.launchId)
          return reply({ admitted: false, reason: "host_request_refused" })
        const bytes = request.file === "events" ? Buffer.from(launch.events) : Buffer.alloc(0)
        return reply({
          admitted: true,
          bytes: bytes.subarray(request.offset).toString("base64"),
        })
      }
      if (request.operation === "stop") return reply({ admitted: true, process: null })
      return reply({ admitted: false, reason: "unsupported" })
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  return {
    socket,
    refused: () => refused,
    lastRequestAt: () => lastRequestAt,
    setReachable: (value: boolean) => {
      reachable = value
    },
    finish: (text: string) => {
      launch.events +=
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n"
      launch.active = false
      launch.exitCode = 0
    },
    relaunch: () => {
      launch = {
        launchId: "22222222-2222-4222-8222-222222222222",
        active: false,
        exitCode: 0,
        events:
          JSON.stringify({ type: "thread.started", thread_id: "other-session" }) +
          "\n" +
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "another launch's answer" },
          }) +
          "\n",
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of connections) connection.destroy()
        server.close(() => resolve())
      }),
  }
}

const hostHarness = async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-8wo4-host-"))
  const host = await fakeHost(root)
  const supervised = supervisor(
    "codex",
    root,
    makeHostCli(host.socket, "codex", parseCodexExecEvent),
  )
  const settle = async () => {
    await supervised.firstTerminal()
    await waitFor(() => Date.now() - host.lastRequestAt() > 250, "the supervisor to settle")
    return supervised.terminals
  }
  return {
    ...supervised,
    host,
    settle,
    cleanup: async () => {
      await host.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("an unreachable agent host is a lost observation, not a failed run", async () => {
  const h = await hostHarness()
  try {
    await h.dispatch()
    h.host.setReachable(false)
    await waitFor(() => h.host.refused() >= 3, "the refused host requests")
    expect(h.terminals).toEqual([])
    h.host.setReachable(true)
    h.host.finish("final answer")
    expect(await h.settle()).toEqual([{ kind: "complete", finalMessage: "final answer" }])
  } finally {
    await h.cleanup()
  }
}, 20_000)

test("a host re-attach that finds another launch does not adopt its result", async () => {
  const h = await hostHarness()
  try {
    await h.dispatch()
    h.host.setReachable(false)
    await waitFor(() => h.host.refused() >= 3, "the refused host requests")
    // While unreachable the host replaced the launch; the new one already finished.
    h.host.relaunch()
    h.host.setReachable(true)
    const terminals = await h.settle()
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      kind: "operator_required",
      diagnostic: expect.stringMatching(/^codex_observation_lost: .*custody changed/),
    })
  } finally {
    await h.cleanup()
  }
}, 20_000)
