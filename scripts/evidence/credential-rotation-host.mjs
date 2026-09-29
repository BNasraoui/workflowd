/* global Bun */
// Manual-only scratch host: production ingress, SQLite stores, migrations,
// worktree creation, dispatcher, worker and recovery. No production integrations.
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { join } from "node:path"
import { writeFile } from "node:fs/promises"
import {
  AgentRunIngress,
  AgentRunIngressLive,
  AgentRunProvider,
} from "../../src/kernel/agent-run-ingress.ts"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store.ts"
import { AgentRunWorktrees, gitAgentRunWorktrees } from "../../src/kernel/agent-run-worktrees.ts"
import { AgentWaitIngress } from "../../src/kernel/agent-wait-ingress.ts"
import { ClaudeCli } from "../../src/kernel/claude-session.ts"
import { CodexCli, makeCodexCli } from "../../src/kernel/codex-session.ts"
import { KernelSessionStoreLive } from "../../src/kernel/session-store.ts"
import { routeRequest } from "../../src/http.ts"
import { WorkflowStore } from "../../src/store/contracts.ts"
import { WorkflowStoreLive } from "../../src/store.ts"
import { WorkSignal } from "../../src/work-signal.ts"

const root = process.env.EVIDENCE_ROOT
if (!root?.includes("/.scratch/evidence59/")) throw Error("scratch root required")
const prefix = process.env.EVIDENCE_PREFIX
if (!prefix?.startsWith("workflowd-evidence59-")) throw Error("scratch unit prefix required")
const runCommand = async (command) => {
  if (command[0] === "systemd-run") {
    if (!command.some((x) => x.startsWith(`--unit=${prefix}`))) throw Error("unsafe unit")
    const unit = command.find((x) => x.startsWith("--unit=")).slice(7)
    await writeFile(join(root, `owned-${unit}`), "")
    // A user manager can have ambient credentials. The worker receives only
    // scratch paths and PATH, even if the manager has additional environment.
    const executable = command.indexOf(process.execPath)
    if (executable < 0) throw Error("worker executable missing")
    const clean = [
      "HOME",
      "PATH",
      "CODEX_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
    ].map((name) => `${name}=${process.env[name]}`)
    command = [
      ...command.slice(0, executable),
      "/usr/bin/env",
      "-i",
      ...clean,
      ...command.slice(executable),
    ]
  }
  const env = { ...process.env }
  if (process.env.EVIDENCE_UNAVAILABLE === "1") {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${root}/missing-bus`
    env.XDG_RUNTIME_DIR = root
  }
  const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  // Never log show-environment output: the real manager can contain secrets.
  if (!command.includes("show-environment"))
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        command: command.filter((x) => !x.startsWith("--setenv=")),
        exitCode,
        stdout,
        stderr,
      }),
    )
  if (
    command[0] === "systemd-run" &&
    exitCode === 0 &&
    process.env.EVIDENCE_LAUNCH_BARRIER === "1"
  ) {
    await writeFile(join(root, "launch-barrier"), "")
    await new Promise(() => {})
  }
  return { exitCode, stdout, stderr }
}
const liveCli = makeCodexCli({
  binary: process.env.EVIDENCE_BINARY,
  custodyRoot: join(root, "agent-processes"),
  unitPrefix: prefix,
  retentionMs: 1000,
  maxOutputBytes: 4096,
  pollIntervalMs: 30,
  cancellationGraceMs: 500,
  runCommand,
})
const observed = (process) =>
  process === null
    ? null
    : {
        ...process,
        events: {
          async *[Symbol.asyncIterator]() {
            for await (const event of process.events) {
              console.log(
                JSON.stringify({
                  at: new Date().toISOString(),
                  parsedEvent: event,
                  unit: process.executionId,
                }),
              )
              yield event
            }
          },
        },
      }
const cli = {
  ...liveCli,
  spawn: (input) => liveCli.spawn(input).pipe(Effect.map(observed)),
  attach: (input) => liveCli.attach(input).pipe(Effect.map(observed)),
}
const bootstrap = WorkflowStoreLive.pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: join(root, "state.db") })),
)
const stores = Layer.mergeAll(AgentRunStoreLive, KernelSessionStoreLive).pipe(
  Layer.provideMerge(bootstrap),
)
const unused = () => Effect.die("disabled scratch integration")
// A deterministic OpenCode protocol fixture checks route separation; it is not a real model.
const provider = {
  listProviders: () => Effect.succeed(["fixture"]),
  listModels: () => Effect.succeed([{ providerID: "fixture", id: "fixture" }]),
  createSession: () => Effect.succeed({ id: "fixture-session" }),
  promptSession: () => Effect.void,
  abortSession: () => Effect.succeed(true),
  sessionTelemetry: () =>
    Effect.succeed({ directory: root, outputTokens: 7, updatedAtMs: Date.now(), idle: false }),
}
const layer = AgentRunIngressLive({
  routes: [{ name: "other", providerID: "fixture", modelID: "fixture" }],
  codexRoutes: [{ name: "codex", modelID: null }],
  repositories: [{ name: "scratch", directory: join(root, "repo") }],
  agent: "worker",
  worktreeRoot: join(root, "worktrees"),
  verifyTimeoutMs: 60000,
  verifyPollIntervalMs: 20,
  progressWindowMs: 120000,
  maxAttempts: 1,
  claudeHosts: [],
  identity: {
    owningHostId: "evidence59",
    providerId: "fixture",
    serverId: "evidence59",
    endpointAlias: "scratch",
    endpointIdentity: "scratch://evidence59",
    providerVersion: 1,
  },
}).pipe(
  Layer.provideMerge(stores),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(CodexCli, cli),
      Layer.succeed(AgentRunProvider, provider),
      Layer.succeed(AgentRunWorktrees, gitAgentRunWorktrees),
      Layer.succeed(AgentWaitIngress, { register: unused }),
      Layer.succeed(ClaudeCli, { sessionExists: unused, resume: unused }),
      Layer.succeed(WorkSignal, { subscribe: unused, wake: () => Effect.void }),
    ),
  ),
)
await Effect.runPromise(
  Effect.gen(function* () {
    const ingress = yield* AgentRunIngress
    const store = yield* WorkflowStore
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        Effect.runPromise(
          routeRequest(request, {
            webhookSecret: "scratch-disabled",
            now: new Date(),
            agentRuns: { ...ingress, token: process.env.EVIDENCE_TOKEN },
          }).pipe(
            Effect.provideService(WorkflowStore, store),
            Effect.provideService(WorkSignal, { subscribe: unused, wake: () => Effect.void }),
          ),
        ),
    })
    yield* Effect.tryPromise(() =>
      writeFile(join(root, "ready.json"), JSON.stringify({ port: server.port, pid: process.pid })),
    )
    yield* Effect.never
  }).pipe(Effect.provide(layer)),
)
