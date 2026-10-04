import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Layer, Schedule, Scope } from "effect"
import { kernelLayer } from "../kernel/job-store-harness"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { KernelSessionStoreLive } from "../../src/kernel/session-store"
import { AgentHandoffStoreLive } from "../../src/kernel/agent-handoff-store"
import { AgentWaitIngressLive } from "../../src/kernel/agent-wait-ingress"
import { AgentRunIngressLive, AgentRunProvider } from "../../src/kernel/agent-run-ingress"
import { AgentRunWorktrees } from "../../src/kernel/agent-run-worktrees"
import { CodexCli, makeCodexCli } from "../../src/kernel/codex-session"
import { ClaudeDispatchCli, makeClaudeDispatchCli } from "../../src/kernel/claude-dispatch"
import { AgentRunWatchdogLive } from "../../src/kernel/agent-run-watchdog"
import { WorkSignalLive } from "../../src/work-signal"
import { ExecutionDiscovery } from "../../src/execution-capabilities"
import { RemoteAgentDispatchLive } from "../../src/remote/agent-coordinator"
import { RemoteAgentRunnerLive } from "../../src/remote/agent-runner"
import { RemoteRunnerStoreLive } from "../../src/remote/runner-store"
import { RemoteCoordinatorStoreLive } from "../../src/remote/coordinator-store"
import { runRemoteResultIteration, runRemoteDispatchIteration } from "../../src/remote/coordinator"
import { runRemoteRunnerIteration } from "../../src/remote/runner"
import { ClaudeResumeExecutor } from "../../src/remote/claude-resume-executor"
import { RemoteTransport, RemoteTransportLive } from "../../src/remote/transport"
import { makeDeterministicTransport } from "./simulation/transport"
import { defaultState, makeProvider } from "../kernel/agent-run-ingress-harness"
import { McpQueriesLive } from "../../src/mcp/queries"
import { RemoteProbeProducerLive } from "../../src/remote/probe-producer"
import { WorkspaceError } from "../../src/workspace/errors"
import { runnerAgentLayer } from "../../src/remote/agent-runtime"
import { SqliteClient } from "@effect/sql-sqlite-bun"

export const remoteFixture = async (
  options: {
    old?: boolean
    hold?: boolean
    fail?: boolean
    server?: string
    kind?: "codex" | "claude" | "opencode"
    runtime?: boolean
    reportedModel?: string
    openCodeUrl?: string
    openCodePassword?: string
  } = {},
) => {
  const root = await mkdtemp("/tmp/opencode/remote-agent-")
  await mkdir(join(root, "parent"))
  const binary = join(root, "codex")
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import { appendFile, writeFile } from "node:fs/promises"
const args = process.argv.slice(2)
if(args[0]==="--version"){console.log("codex-cli 0.159.1");process.exit(0)}
if(args[0]==="login"){console.log("Logged in using ChatGPT");process.exit(0)}
if(args[0]==="auth"){console.log(JSON.stringify({loggedIn:true}));process.exit(0)}
const prompt=await Bun.stdin.text()
await appendFile(${JSON.stringify(join(root, "launches.jsonl"))},JSON.stringify({args,prompt,directory:process.cwd(),pid:process.pid})+"\\n")
if(${JSON.stringify(options.kind)}==="claude"){
 console.log(JSON.stringify({type:"system",subtype:"init",session_id:"remote-claude-session",model:${options.reportedModel === undefined ? 'args[args.indexOf("--model")+1]' : JSON.stringify(options.reportedModel)}}))
 console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"Remote answer"}]}}))
 console.log(JSON.stringify({type:"result",is_error:false,usage:{output_tokens:17}}))
 process.exit(0)
}
console.log(JSON.stringify({type:"thread.started",thread_id:"remote-native-session"}))
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Started remotely"}}))
${options.hold ? "await new Promise(()=>setInterval(()=>{},1000))" : ""}
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Remote answer"}}))
console.log(JSON.stringify({type:"turn.completed",usage:{output_tokens:17}}))
process.exit(${options.fail ? 23 : 0})
`,
    { mode: 0o755 },
  )
  const processes = new Map<string, ReturnType<typeof Bun.spawn>>()
  const descriptions = new Map<string, string>()
  const cliOptions: Parameters<typeof makeCodexCli>[0] = {
    binary,
    custodyRoot: join(root, "custody"),
    pollIntervalMs: 2,
    observationTimeoutMs: 2000,
    runCommand: async (command) => {
      if (command[0] === "systemd-run") {
        const unit = command.find((v) => v.startsWith("--unit="))!.slice(7)
        descriptions.set(unit, command.find((v) => v.startsWith("--description="))!.slice(14))
        processes.set(
          unit,
          Bun.spawn(["setsid", ...command.slice(command.indexOf(process.execPath))], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      if (command.includes("show-environment")) return { exitCode: 0, stdout: "", stderr: "" }
      const unit = command.at(-1)!
      const child = processes.get(unit)
      if (
        (command.includes("stop") || command.includes("kill")) &&
        child !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        process.kill(-child.pid, command.includes("--signal=SIGKILL") ? "SIGKILL" : "SIGTERM")
        await child.exited
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: `LoadState=${child ? "loaded" : "not-found"}\nMainPID=${child?.pid ?? 0}\nInvocationID=fixture-${unit}\nDescription=${descriptions.get(unit) ?? ""}\nActiveState=${child?.exitCode === null && child.signalCode === null ? "active" : "inactive"}\nResult=success\n`,
      }
    },
  }
  const cli = makeCodexCli(cliOptions)
  const transport = makeDeterministicTransport()
  const identity = (host: string) => ({
    owningHostId: host,
    providerId: "primary",
    serverId: "primary",
    endpointAlias: "local",
    endpointIdentity: "http://127.0.0.1:4096",
    providerVersion: 1,
  })
  const state = defaultState()
  state.telemetry.set("ses_parent", {
    directory: join(root, "parent"),
    outputTokens: 1,
    updatedAtMs: Date.now(),
    idle: false,
  })
  const trees: Array<{ repository: string; directory: string; branch: string }> = []
  const base = (host: string) => {
    const kernel = kernelLayer(join(root, `${host}.db`))
    return Layer.mergeAll(
      AgentRunStoreLive,
      KernelSessionStoreLive,
      AgentHandoffStoreLive,
      McpQueriesLive,
      RemoteCoordinatorStoreLive,
      RemoteProbeProducerLive,
    ).pipe(Layer.provideMerge(kernel), Layer.provideMerge(WorkSignalLive))
  }
  const localOptions = (host: string) => ({
    scopeNativeCompletions: host === "runner-b",
    routes: [],
    codexRoutes: [],
    claudeRoutes: [],
    repositories: [{ name: "fixture", directory: join(root, host, "repo") }],
    agent: "build",
    worktreeRoot: join(root, host, "worktrees"),
    verifyTimeoutMs: 2000,
    verifyPollIntervalMs: 2,
    progressWindowMs: 3000,
    maxAttempts: 1,
    claudeHosts: [],
    identity: identity(host),
    executionPolicy: { revision: "fixture", intents: [{ name: "research", family: "opus" }] },
  })
  const deps = Layer.mergeAll(
    Layer.succeed(CodexCli, cli),
    Layer.succeed(ClaudeDispatchCli, makeClaudeDispatchCli(cliOptions)),
    Layer.succeed(AgentRunProvider, makeProvider(state)),
    Layer.succeed(AgentRunWorktrees, {
      create: (input) =>
        Effect.tryPromise({
          try: async () => {
            trees.push(input)
            await mkdir(input.directory, { recursive: true })
          },
          catch: (cause) =>
            new WorkspaceError({ operation: "fixture worktree", cause: new Error(String(cause)) }),
        }),
    }),
  )
  const runnerIngress = Layer.merge(
    AgentRunIngressLive(localOptions("runner-b")),
    AgentRunWatchdogLive({
      owningHostId: "runner-b",
      progressWindowMs: 3000,
      staleAfterMs: 20000,
      unsupervisedExecutorKinds: ["codex", "claude"],
      now: () => new Date(),
    }),
  ).pipe(Layer.provideMerge(base("runner-b")), Layer.provideMerge(deps))
  const wire =
    options.server === undefined
      ? Layer.succeed(RemoteTransport, transport.port)
      : RemoteTransportLive({ servers: [options.server] })
  const agentRunner = RemoteAgentRunnerLive("runner-b").pipe(
    Layer.provideMerge(runnerIngress),
    Layer.provideMerge(wire),
  )
  if (options.runtime) {
    await mkdir(join(root, "runner-b", "repo"), { recursive: true })
    for (const args of [
      ["init", "-q"],
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        "Fixture",
      ],
    ]) {
      const child = Bun.spawn(["git", ...args], {
        cwd: join(root, "runner-b", "repo"),
        stdout: "pipe",
        stderr: "pipe",
      })
      if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text())
    }
  }
  const runtime = runnerAgentLayer(
    {
      hostId: "runner-b",
      databasePath: join(root, "runner-b.db"),
      servers: [],
      auth: { mode: "token", token: "fixture" },
      claudeBinary: binary,
      claudeDirectories: [],
      agentExecution: {
        repositories: [{ name: "fixture", directory: join(root, "runner-b/repo") }],
        worktreeRoot: join(root, "runner-b/worktrees"),
        codexBinary: binary,
        openCodePassword: options.openCodePassword ?? "",
        ...(options.openCodeUrl === undefined ? {} : { openCodeUrl: options.openCodeUrl }),
        verifyTimeoutMs: 2000,
        progressWindowMs: 3000,
      },
    },
    SqliteClient.layer({ filename: join(root, "runner-b.db") }),
    wire,
    { nativeOptions: cliOptions },
  )
  const runner = RemoteRunnerStoreLive.pipe(
    Layer.provideMerge(options.old ? base("runner-b") : options.runtime ? runtime : agentRunner),
    Layer.provideMerge(base("runner-b")),
    Layer.provideMerge(wire),
    Layer.provide(
      Layer.succeed(ClaudeResumeExecutor, {
        execute: () => Effect.succeed({ status: "failed", failureReason: "directory_not_allowed" }),
      }),
    ),
  )
  const core = base("coordinator")
  const remote = RemoteAgentDispatchLive({ hosts: ["runner-b"], timeoutMs: 2500 }).pipe(
    Layer.provideMerge(core),
    Layer.provideMerge(wire),
  )
  const kind = options.kind ?? "codex"
  let model =
    kind === "claude" ? "claude-opus-5-5" : kind === "opencode" ? "claude-fable-5" : "gpt-6.10-sol"
  const discovery = Layer.succeed(ExecutionDiscovery, {
    list: () =>
      Effect.succeed({
        sources: [
          {
            host: "coordinator",
            executor: `${kind}:local`,
            kind,
            protocol: "fixture",
            status: "available",
            checkedAt: new Date().toISOString(),
            observedAt: new Date().toISOString(),
            freshUntil: new Date().toISOString(),
            stale: false,
          },
        ],
        capabilities: [
          {
            identity: {
              host: "coordinator",
              executor: `${kind}:local`,
              provider: kind === "codex" ? "openai" : "anthropic",
              model,
            },
            kind,
            nativeModel: model,
            selectionModel: model,
            observedAt: new Date().toISOString(),
            availability: "available",
            thinking: { status: "advertised", efforts: [{ id: "xhigh", native: "xhigh" }] },
            speed: { status: "advertised", tiers: [{ id: "fast", native: "fast" }] },
          },
        ],
      }),
  })
  const waits = AgentWaitIngressLive(identity("coordinator")).pipe(Layer.provideMerge(remote))
  const central = AgentRunIngressLive(localOptions("coordinator")).pipe(
    Layer.provideMerge(waits),
    Layer.provideMerge(deps),
    Layer.provideMerge(discovery),
  )
  const startContexts = (scope: Scope.Scope) =>
    Effect.gen(function* () {
      const centralContext = yield* Layer.buildWithScope(Layer.fresh(central), scope)
      const runnerContext = yield* Layer.buildWithScope(Layer.fresh(runner), scope)
      yield* Context.get(centralContext, RemoteTransport).ensureInfrastructure()
      yield* Effect.suspend(() => runRemoteRunnerIteration("runner-b", new Date())).pipe(
        Effect.provide(runnerContext),
        Effect.repeat(Schedule.spaced("5 millis")),
        Effect.forkIn(scope),
      )
      yield* Effect.gen(function* () {
        yield* runRemoteDispatchIteration({
          commandId: () => crypto.randomUUID(),
          workerId: "fixture",
          now: () => new Date(),
          leaseDurationMs: 1000,
          commandTtlMs: 1000,
        })
        yield* runRemoteResultIteration(new Date())
      }).pipe(
        Effect.provide(centralContext),
        Effect.repeat(Schedule.spaced("5 millis")),
        Effect.forkIn(scope),
      )
      return { centralContext, runnerContext }
    })
  const contexts = Effect.scope.pipe(Effect.flatMap(startContexts))
  // Expose layers, not additional production behavior: tests own restart scopes.
  return {
    root,
    providerState: state,
    cli,
    trees,
    transport,
    runner,
    central,
    contexts,
    startContexts,
    identity: identity("coordinator"),
    changeCatalog: () => {
      model = "gpt-9-sol"
    },
    cleanup: async () => {
      for (const child of processes.values())
        if (child.exitCode === null && child.signalCode === null)
          process.kill(-child.pid, "SIGTERM")
      await Promise.all([...processes.values()].map((p) => p.exited))
      await rm(root, { recursive: true, force: true })
    },
  }
}
