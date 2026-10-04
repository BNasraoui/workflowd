import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { Effect, Layer, Schedule, Schema } from "effect"
import {
  AgentRunIngress,
  AgentRunIngressLive,
  AgentRunProvider,
} from "../../../src/kernel/agent-run-ingress"
import { AgentRunStore, AgentRunStoreLive } from "../../../src/kernel/agent-run-store"
import { AgentRunWorktrees } from "../../../src/kernel/agent-run-worktrees"
import {
  AgentWaitIngressLive,
  AGENT_WAKE_CONTRACT,
  AgentWakeResult,
} from "../../../src/kernel/agent-wait-ingress"
import { AgentHandoffStoreLive } from "../../../src/kernel/agent-handoff-store"
import { KernelEventStoreLive } from "../../../src/kernel/event-store"
import { KernelSessionStoreLive } from "../../../src/kernel/session-store"
import { KernelJobStoreLive } from "../../../src/kernel/job-store"
import { runKernelJobIteration } from "../../../src/kernel/job-runner"
import { enqueueNextAgentHandoff } from "../../../src/kernel/agent-handoff-reducer"
import {
  runOpenCodeCompletionSourceIteration,
  OpenCodeCompletionProvider,
} from "../../../src/kernel/opencode-completion-source"
import { runClaudeResumeIteration } from "../../../src/kernel/claude-resume-worker"
import {
  ClaudeCli,
  encodeClaudeProjectDir,
  makeClaudeCli,
} from "../../../src/kernel/claude-session"
import { makeCodexCli, CodexCli } from "../../../src/kernel/codex-session"
import { ClaudeDispatchCli, makeClaudeDispatchCli } from "../../../src/kernel/claude-dispatch"
import {
  OpenCodeResumeProvider,
  runOpenCodeResumeIteration,
} from "../../../src/kernel/opencode-resume-worker"
import { ClaudeResumeRemoteProducerLive } from "../../../src/remote/claude-resume-producer"
import { makeClaudeResumeExecutor } from "../../../src/remote/claude-resume-executor"
import { WorkSignal } from "../../../src/work-signal"
import { WorkflowStoreLive } from "../../../src/store"
import { toJsonSchemaObject } from "../../../src/json"
import { simulationTimeoutMs } from "./budget"
import { RemoteSimulation } from "./simulator"
import { defaultState, makeProvider } from "../../kernel/agent-run-ingress-harness"

setDefaultTimeout(simulationTimeoutMs(4_000))

const identity = {
  owningHostId: "coordinator",
  providerId: "opencode-primary",
  serverId: "opencode-primary",
  endpointAlias: "local",
  endpointIdentity: "http://127.0.0.1:4096",
  providerVersion: 1,
}

const resultContract = {
  name: AGENT_WAKE_CONTRACT.name,
  version: AGENT_WAKE_CONTRACT.version,
  schema: AgentWakeResult as Schema.Codec<unknown, unknown>,
  jsonSchema: toJsonSchemaObject(AgentWakeResult),
  maxOutputBytes: 16_384,
}

const makeFixture = async (kind: "codex" | "claude", allowed = true, hold = false) => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-cli-wake-"))
  const parentDirectory = join(root, "runner-b", "parent")
  const allowedDirectory = join(root, "runner-b")
  const home = join(root, "home")
  const nativeParent = "11111111-2222-4333-8444-555555555555"
  await mkdir(parentDirectory, { recursive: true })
  await mkdir(join(home, ".claude", "projects", encodeClaudeProjectDir(parentDirectory)), {
    recursive: true,
  })
  await writeFile(
    join(
      home,
      ".claude",
      "projects",
      encodeClaudeProjectDir(parentDirectory),
      `${nativeParent}.jsonl`,
    ),
    "{}\n",
  )
  const codexBinary = join(root, "codex")
  const claudeBinary = join(root, "claude")
  await writeFile(
    codexBinary,
    `#!/usr/bin/env bun
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
if (process.argv[2] === "--version") { console.log("codex-cli 0.153.4"); process.exit(0) }
if (process.argv[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(0) }
await writeFile(join(process.cwd(), "child.pid"), String(process.pid))
console.log(JSON.stringify({type:"thread.started",thread_id:"01234567-89ab-7cde-8f01-23456789abcd"}))
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Child began."}}))
if (process.env.WORKFLOWD_FIXTURE_HOLD === "1") await new Promise(() => setInterval(() => {}, 1000))
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Codex child finished."}}))
console.log(JSON.stringify({type:"turn.completed",usage:{output_tokens:5}}))
`,
    { mode: 0o755 },
  )
  await writeFile(
    claudeBinary,
    `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
const args = process.argv.slice(2)
if (args[0] === "--version") { console.log("claude 1.0"); process.exit(0) }
if (args[0] === "auth") { console.log(JSON.stringify({loggedIn:true})); process.exit(0) }
if (args.includes("--resume")) {
  const prompt = await Bun.stdin.text()
  await appendFile(join(process.cwd(), "wakes.jsonl"), JSON.stringify({prompt})+"\\n")
  console.log(JSON.stringify({result:prompt.startsWith("{") && prompt.includes("terminal") ? "ACK line" : JSON.stringify({acknowledged:true,summary:"received"})}))
  process.exit(0)
}
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"12345678-1234-4234-8234-123456789abc"}))
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"Claude child finished."}]}}))
console.log(JSON.stringify({type:"result",is_error:false,usage:{output_tokens:5}}))
`,
    { mode: 0o755 },
  )
  const processes = new Map<string, ReturnType<typeof Bun.spawn>>()
  const descriptions = new Map<string, string>()
  const manager = async (command: ReadonlyArray<string>) => {
    if (command[0] === "systemd-run") {
      const unit = command.find((part) => part.startsWith("--unit="))!.slice(7)
      descriptions.set(unit, command.find((part) => part.startsWith("--description="))!.slice(14))
      const start = command.indexOf(process.execPath)
      const child = Bun.spawn(command.slice(start), {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, WORKFLOWD_FIXTURE_HOLD: hold ? "1" : "0" },
      })
      processes.set(unit, child)
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    if (command.includes("show-environment")) return { exitCode: 0, stdout: "", stderr: "" }
    const unit = command.at(-1)!
    const child = processes.get(unit)
    if (command.includes("stop") || command.includes("kill")) child?.kill("SIGTERM")
    const active = child !== undefined && child.exitCode === null && child.signalCode === null
    return {
      exitCode: 0,
      stderr: "",
      stdout: `LoadState=${child === undefined ? "not-found" : "loaded"}\nMainPID=${child?.pid ?? 0}\nInvocationID=fixture-${unit}\nDescription=${descriptions.get(unit) ?? ""}\nActiveState=${active ? "active" : "inactive"}\nResult=success\n`,
    }
  }
  const cliOptions = {
    custodyRoot: join(root, "custody"),
    pollIntervalMs: 2,
    observationTimeoutMs: 5_000,
    runCommand: manager,
  }
  const codex = makeCodexCli({ ...cliOptions, binary: codexBinary })
  const claudeDispatch = makeClaudeDispatchCli({ ...cliOptions, binary: claudeBinary })
  const claude = makeClaudeCli({ binary: claudeBinary, home })
  const providerState = defaultState()
  providerState.telemetry.set("ses_opencode_parent", {
    directory: parentDirectory,
    outputTokens: 1,
    updatedAtMs: Date.now(),
    idle: false,
  })
  const simulation = await RemoteSimulation.make(9001, {
    claudeExecutor: makeClaudeResumeExecutor({
      cli: claude,
      allowedDirectories: allowed ? [allowedDirectory] : [],
    }),
    startAt: new Date(Date.now() + 60_000),
  })
  const bootstrap = WorkflowStoreLive.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: simulation.centralDatabase })),
  )
  const events = KernelEventStoreLive.pipe(Layer.provideMerge(bootstrap))
  const sessions = KernelSessionStoreLive.pipe(Layer.provideMerge(bootstrap))
  const jobs = KernelJobStoreLive.pipe(Layer.provideMerge(events), Layer.provideMerge(bootstrap))
  const runs = AgentRunStoreLive.pipe(Layer.provideMerge(bootstrap))
  const handoffs = AgentHandoffStoreLive.pipe(
    Layer.provideMerge(events),
    Layer.provideMerge(bootstrap),
  )
  const signals = Layer.succeed(WorkSignal, {
    subscribe: () => Effect.never,
    wake: () => Effect.void,
  })
  const waits = AgentWaitIngressLive(identity).pipe(
    Layer.provideMerge(Layer.mergeAll(events, sessions, handoffs)),
    Layer.provideMerge(signals),
  )
  const producer = ClaudeResumeRemoteProducerLive.pipe(
    Layer.provideMerge(Layer.mergeAll(events, jobs)),
  )
  const options = {
    routes: [],
    codexRoutes: kind === "codex" ? [{ name: "child", modelID: "gpt-5.1-codex" }] : [],
    claudeRoutes: kind === "claude" ? [{ name: "child", modelID: "claude-test" }] : [],
    repositories: [{ name: "fixture", directory: root }],
    agent: "build",
    worktreeRoot: join(root, "worktrees"),
    verifyTimeoutMs: 2_000,
    verifyPollIntervalMs: 2,
    progressWindowMs: 5_000,
    maxAttempts: 3,
    claudeHosts: ["runner-b"],
    identity,
  }
  const trees = Layer.succeed(AgentRunWorktrees, {
    create: (input: { directory: string }) =>
      Effect.promise(() => mkdir(input.directory, { recursive: true })).pipe(Effect.asVoid),
  })
  const ingress = AgentRunIngressLive(options).pipe(
    Layer.provideMerge(Layer.mergeAll(runs, sessions, waits)),
    Layer.provideMerge(Layer.succeed(AgentRunProvider, makeProvider(providerState))),
    Layer.provideMerge(Layer.succeed(CodexCli, codex)),
    Layer.provideMerge(Layer.succeed(ClaudeDispatchCli, claudeDispatch)),
    Layer.provideMerge(Layer.succeed(ClaudeCli, claude)),
    Layer.provideMerge(trees),
    Layer.provideMerge(signals),
  )
  const layer = Layer.mergeAll(
    bootstrap,
    events,
    sessions,
    jobs,
    runs,
    handoffs,
    waits,
    producer,
    ingress,
    signals,
    Layer.succeed(ClaudeCli, claude),
  )
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const close = async () => {
    for (const child of processes.values())
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await simulation[Symbol.asyncDispose]()
    await rm(root, { recursive: true, force: true })
  }
  return { root, parentDirectory, nativeParent, simulation, run, close }
}

const observe = runOpenCodeCompletionSourceIteration({
  ...identity,
  observationTimeoutMs: 100,
  now: () => new Date(),
}).pipe(
  Effect.provideService(OpenCodeCompletionProvider, {
    sessionExists: async () => true,
    sessionFinished: async () => true,
    listMessages: async () => [],
    subscribeEvents: async () => (async function* () {})(),
  }),
)

const drain = (fixture: Awaited<ReturnType<typeof makeFixture>>) =>
  fixture.run(
    Effect.gen(function* () {
      const observed = yield* observe
      const queued = yield* enqueueNextAgentHandoff(fixture.simulation.now)
      const registered = yield* runKernelJobIteration({
        workerId: "test",
        now: () => fixture.simulation.now,
        leaseDurationMs: 60_000,
        retryDelayMs: 0,
      })
      const woken = yield* runClaudeResumeIteration({
        owningHostId: "coordinator",
        workerId: "test",
        leaseDurationMs: 60_000,
        heartbeatIntervalMs: 20_000,
        resumeTimeoutMs: 5_000,
        retryDelayMs: 0,
        claudeHosts: ["runner-b"],
        remoteTurnTimeoutMs: 10_000,
        now: () => fixture.simulation.now,
        contracts: [resultContract],
      })
      return { observed, queued, registered, woken }
    }),
  )

const dispatch = (
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  parentKind: "claude" | "opencode" = "claude",
  terminal: "completed" | "operator_required" = "completed",
  kill = false,
) =>
  fixture.run(
    Effect.gen(function* () {
      const ingress = yield* AgentRunIngress
      const receipt = yield* ingress.register(
        {
          route: "child",
          repository: "fixture",
          prompt: "Do the task",
          parentSessionId: parentKind === "claude" ? fixture.nativeParent : "ses_opencode_parent",
          parentKind,
          ...(parentKind === "claude"
            ? { parentHost: "runner-b", parentDirectory: fixture.parentDirectory }
            : {}),
          resumePrompt: "Continue parent.",
        },
        fixture.simulation.now,
      )
      if (kill) {
        const runs = yield* AgentRunStore
        const current = yield* runs.read(receipt.runId)
        const pid = yield* Effect.promise(() =>
          readFile(join(current!.directory, "child.pid"), "utf8"),
        )
        process.kill(Number(pid), "SIGTERM")
      }
      const runs = yield* AgentRunStore
      const row = yield* runs.read(receipt.runId).pipe(
        Effect.repeat({
          until: (run) => run?.state === terminal,
          schedule: Schedule.spaced("5 millis"),
        }),
        Effect.timeout("3 seconds"),
      )
      return { receipt, row }
    }),
  )

const records = (fixture: Awaited<ReturnType<typeof makeFixture>>, mailboxId: string) =>
  fixture.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return {
        inbox: yield* sql<{
          prompt: string
        }>`SELECT prompt FROM resident_inbox WHERE mailbox_id = ${mailboxId}`,
        watch: yield* sql<{ state: string }>`SELECT state FROM kernel_agent_completion_watches`,
        remote: yield* sql<{
          input_json: string
          state: string
          result_json: string | null
        }>`SELECT job.input_json, job.state, result.result_json FROM kernel_workflow_jobs AS job LEFT JOIN kernel_workflow_job_results AS result ON result.job_id = job.job_id WHERE json_extract(job.input_json, '$.kind') = 'claude_resume'`,
        requests: yield* sql<{
          state: string
          prompt_text: string
        }>`SELECT state, prompt_text FROM kernel_resume_requests`,
        results: yield* sql<{ result_id: string }>`SELECT result_id FROM kernel_resume_results`,
      }
    }),
  )

const finishRemote = async (fixture: Awaited<ReturnType<typeof makeFixture>>) => {
  const outcome = await fixture.run(
    runClaudeResumeIteration({
      owningHostId: "coordinator",
      workerId: "test",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 20_000,
      resumeTimeoutMs: 5_000,
      retryDelayMs: 0,
      claudeHosts: ["runner-b"],
      remoteTurnTimeoutMs: 10_000,
      now: () => fixture.simulation.now,
      contracts: [resultContract],
    }),
  )
  return outcome
}

test("remote Claude parent wakes from completed Codex CLI child through coordinator and runner", async () => {
  const fixture = await makeFixture("codex")
  try {
    const { receipt, row } = await dispatch(fixture)
    expect(row?.state).toBe("completed")
    expect(await drain(fixture)).toMatchObject({
      observed: { status: "completed" },
      queued: { status: "enqueued" },
      registered: { status: "completed" },
      woken: { status: "remote_dispatched" },
    })
    await fixture.simulation.run([
      { type: "coordinator" },
      { type: "runner", host: "runner-b" },
      { type: "coordinator" },
    ])
    const result = await records(fixture, receipt.mailboxId)
    expect(result.inbox).toHaveLength(1)
    expect(JSON.parse(result.inbox[0]!.prompt)).toMatchObject({
      status: "completed",
      final_message: "Codex child finished.",
    })
    expect(result.watch).toEqual([{ state: "completed" }])
    expect(JSON.parse(result.remote[0]!.input_json).hostId).toBe("runner-b")
    const wakes = (await readFile(join(fixture.parentDirectory, "wakes.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) =>
        Schema.decodeUnknownSync(Schema.Struct({ prompt: Schema.String }))(JSON.parse(line)),
      )
    expect(wakes).toHaveLength(2)
    expect(JSON.parse(wakes[0]!.prompt)).toMatchObject({
      task: "Continue parent.",
      terminal: {
        run_id: receipt.runId,
        mailbox_id: receipt.mailboxId,
        status: "completed",
        final_message: "Codex child finished.",
      },
    })
    expect(await finishRemote(fixture)).toMatchObject({ status: "completed" })
    expect((await records(fixture, receipt.mailboxId)).results).toHaveLength(1)
  } finally {
    await fixture.close()
  }
})

test("external SIGTERM on a Codex CLI child records the terminal reason and wakes its remote Claude parent once", async () => {
  const fixture = await makeFixture("codex", true, true)
  try {
    const { receipt, row } = await dispatch(fixture, "claude", "operator_required", true)
    expect(row?.diagnostic).toContain("SIGTERM")
    expect(await drain(fixture)).toMatchObject({
      observed: { status: "completed" },
      woken: { status: "remote_dispatched" },
    })
    await fixture.simulation.run([
      { type: "coordinator" },
      { type: "runner", host: "runner-b" },
      { type: "coordinator" },
    ])
    const state = await records(fixture, receipt.mailboxId)
    expect(state.inbox).toHaveLength(1)
    expect(JSON.parse(state.inbox[0]!.prompt)).toMatchObject({
      status: "operator_required",
      end_reason: expect.stringContaining("SIGTERM"),
    })
    const wakes = (await readFile(join(fixture.parentDirectory, "wakes.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) =>
        Schema.decodeUnknownSync(Schema.Struct({ prompt: Schema.String }))(JSON.parse(line)),
      )
    expect(wakes).toHaveLength(2)
    expect(JSON.parse(wakes[0]!.prompt).terminal).toMatchObject({
      run_id: receipt.runId,
      status: "operator_required",
      end_reason: expect.stringContaining("SIGTERM"),
    })
    expect(await finishRemote(fixture)).toMatchObject({ status: "completed" })
    expect((await records(fixture, receipt.mailboxId)).results).toHaveLength(1)
  } finally {
    await fixture.close()
  }
})

test("Claude CLI child completion wakes an OpenCode parent with the final message", async () => {
  const fixture = await makeFixture("claude")
  try {
    const { receipt, row } = await dispatch(fixture, "opencode")
    expect(row?.state).toBe("completed")
    const stage = await fixture.run(
      Effect.gen(function* () {
        const observed = yield* observe
        const queued = yield* enqueueNextAgentHandoff(fixture.simulation.now)
        const registered = yield* runKernelJobIteration({
          workerId: "test",
          now: () => fixture.simulation.now,
          leaseDurationMs: 60_000,
          retryDelayMs: 0,
        })
        return { observed, queued, registered }
      }),
    )
    expect(stage).toMatchObject({
      observed: { status: "completed" },
      queued: { status: "enqueued" },
      registered: { status: "completed" },
    })
    const prompts: string[] = []
    const provider = {
      sessionExists: async () => true,
      sessionFinished: async () => true,
      listMessages: async () => [],
      promptAsync: async (input: { prompt: string }) => {
        prompts.push(input.prompt)
      },
      subscribeEvents: async () =>
        (async function* () {
          yield {
            type: "message.updated" as const,
            sessionID: "ses_opencode_parent",
            message: { role: "assistant" as const, time: { created: 1, completed: 2 } },
          }
        })(),
      generate: async () => ({ acknowledged: true, summary: "received" }),
    }
    const resumed = await fixture.run(
      runOpenCodeResumeIteration({
        ...identity,
        workerId: "test-opencode",
        leaseDurationMs: 60_000,
        heartbeatIntervalMs: 20_000,
        now: () => fixture.simulation.now,
        contracts: [
          {
            ...resultContract,
            agent: "fixture",
            model: { providerID: "fixture", modelID: "fixture" },
          },
        ],
      }).pipe(Effect.provideService(OpenCodeResumeProvider, provider)),
    )
    expect(resumed).toMatchObject({ status: "completed" })
    expect(prompts).toHaveLength(1)
    expect(JSON.parse(prompts[0]!)).toMatchObject({
      task: "Continue parent.",
      terminal: { run_id: receipt.runId, final_message: "Claude child finished." },
    })
    expect((await records(fixture, receipt.mailboxId)).results).toHaveLength(1)
  } finally {
    await fixture.close()
  }
})

test("coordinator restart and duplicate reordered deliveries wake the Claude parent once", async () => {
  const fixture = await makeFixture("codex")
  try {
    const { receipt } = await dispatch(fixture)
    await fixture.simulation.step({ type: "restart", service: "coordinator" })
    expect((await drain(fixture)).woken.status).toBe("remote_dispatched")
    await fixture.simulation.run([
      { type: "coordinator" },
      { type: "duplicate", channel: "host" },
      { type: "reorder", channel: "host" },
      { type: "runner", host: "runner-b" },
      { type: "duplicate", channel: "result" },
      { type: "reorder", channel: "result" },
      { type: "coordinator" },
      { type: "coordinator" },
      { type: "runner", host: "runner-b" },
    ])
    expect(await finishRemote(fixture)).toMatchObject({ status: "completed" })
    expect((await records(fixture, receipt.mailboxId)).results).toHaveLength(1)
    const wakes = (await readFile(join(fixture.parentDirectory, "wakes.jsonl"), "utf8"))
      .trim()
      .split("\n")
    expect(wakes).toHaveLength(2)
  } finally {
    await fixture.close()
  }
})

test("runner refuses a Claude parent directory outside its configured prefixes with operator_required", async () => {
  const fixture = await makeFixture("codex", false)
  try {
    const { receipt } = await dispatch(fixture)
    expect((await drain(fixture)).woken.status).toBe("remote_dispatched")
    await fixture.simulation.run([
      { type: "coordinator" },
      { type: "runner", host: "runner-b" },
      { type: "coordinator" },
    ])
    expect(await finishRemote(fixture)).toMatchObject({ status: "operator_required" })
    const state = await records(fixture, receipt.mailboxId)
    expect(JSON.parse(state.remote[0]!.result_json!)).toMatchObject({
      status: "failed",
      failureReason: "directory_not_allowed",
    })
    expect(state.requests[0]?.state).toBe("operator_required")
    expect(state.inbox).toHaveLength(1)
    expect(await Bun.file(join(fixture.parentDirectory, "wakes.jsonl")).exists()).toBe(false)
  } finally {
    await fixture.close()
  }
})
