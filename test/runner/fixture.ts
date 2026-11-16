import { SqliteClient } from "@effect/sql-sqlite-bun"
import { OpenCode } from "@opencode-ai/client/effect"
import { Effect, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { AgentRunIngressLive } from "../../src/kernel/agent-run-ingress"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { AgentRunWorktrees } from "../../src/kernel/agent-run-worktrees"
import { ClaudeDispatchCli } from "../../src/kernel/claude-dispatch"
import { CodexCli } from "../../src/kernel/codex-session"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import {
  makeSealedResultGit,
  sealedResultLimits,
  SealedResultGit,
  type SealedResultGitPort,
} from "../../src/kernel/sealed-result"
import { KernelSessionStoreLive } from "../../src/kernel/session-store"
import { makeOpenCodeSdkClient, SdkOpenCodeAdapter } from "../../src/opencode/adapter"
import { makeDaemonCapability } from "../../src/sandbox/capability-control"
import { defaultRunBudget } from "../../src/sandbox/config"
import { makeSandboxDispatch, SandboxDispatch } from "../../src/sandbox/dispatch"
import { RepositoryVisibility } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { WorkflowStoreLive } from "../../src/store"
import { WorkSignal } from "../../src/work-signal"
import {
  fixture,
  gatewaySource,
  proof,
  startGatewayProcess,
  type Fixture,
  type Gateway,
} from "../capability-gateway/gateway-process"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { makeCodexCli } from "../kernel/agent-run-ingress-harness"
import { githubApiStub } from "../sandbox/github-api-stub"

/**
 * A harness of the run client in place of the box: it reads the launch on its standard input,
 * writes Claude's stream-json lines for it, and leaves `result` (its result.json and its bundle)
 * in the run directory. It names the launch's prompt and model in its lines, so a test sees that
 * the launch reached it.
 */
export async function writeHarness(
  directory: string,
  result: { readonly manifest: string; readonly bundle: Uint8Array } | null,
  options: { readonly extraLines?: number; readonly exitCode?: number } = {},
) {
  const path = join(directory, "harness.mjs")
  if (result !== null) {
    await mkdir(join(directory, "result"), { recursive: true })
    await writeFile(join(directory, "fixture-result.json"), result.manifest)
    await writeFile(join(directory, "fixture-result.bundle"), result.bundle)
  }
  await writeFile(
    path,
    `import { copyFileSync, readFileSync } from "node:fs"
const launch = JSON.parse(readFileSync(0, "utf8"))
const directory = ${JSON.stringify(directory)}
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
line({ type: "system", subtype: "init", session_id: "fixture-session", model: launch.model })
for (let index = 0; index < ${options.extraLines ?? 0}; index++)
  line({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(1000) }] } })
line({ type: "assistant", message: { content: [{ type: "text", text: "prompt: " + launch.prompt + " at " + launch.sourceSha }] } })
line({ type: "result", subtype: "success", is_error: false, result: "Done for " + launch.sourceSha })
${
  result === null
    ? ""
    : `copyFileSync(directory + "/fixture-result.json", directory + "/result/result.json")
copyFileSync(directory + "/fixture-result.bundle", directory + "/result/result.bundle")`
}
process.exitCode = ${options.exitCode ?? 0}
`,
  )
  return path
}

/** The agent Git identity of the daemon, which the launch gives the seal and the check requires. */
export const runnerIdentity = { name: "Fixture Agent", email: "agent@example.invalid" }
/** The model of the runner route: a family whose anthropic-beta values the gateway's list holds. */
export const runnerModel = "claude-sonnet-4-5"
/** The Actions run of the runner job, which the GitHub stub lists for the lease ref. */
const actionsRunId = 79
const workflowSha = "a".repeat(40)

/** Runs a command and gives its standard output, trimmed; fails with `step` and its error. */
export function run(step: string, argv: ReadonlyArray<string>, cwd?: string, input?: string) {
  const child = Bun.spawnSync([...argv], {
    ...(cwd === undefined ? {} : { cwd }),
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/nonexistent",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  })
  if (child.exitCode !== 0)
    throw new Error(
      `step ${step}: ${argv.join(" ")} exited ${child.exitCode}: ${child.stderr.toString()}`,
    )
  return child.stdout.toString().trim()
}

/**
 * The fixture repository's Git remote, served over HTTP by `git http-backend` as GitHub serves
 * a public repository: upload-pack only. Its one commit is the run's source; the daemon pushes
 * the run's branch into the same bare repository.
 */
async function gitRemote(root: string) {
  const work = join(root, "work")
  const projects = join(root, "remote")
  const bare = join(projects, "fixture", "repo.git")
  await mkdir(work, { recursive: true })
  run("source", ["git", "init", "--quiet", "-b", "main"], work)
  await writeFile(join(work, "README.md"), "fixture\n")
  run("source", ["git", "add", "README.md"], work)
  run("source", ["git", "commit", "--quiet", "-m", "Source"], work)
  const sourceSha = run("source", ["git", "rev-parse", "HEAD"], work)
  await mkdir(join(projects, "fixture"), { recursive: true })
  run("source", ["git", "clone", "--quiet", "--bare", work, bare])
  // GitHub serves any commit of a public repository by its id.
  run("source", ["git", "-C", bare, "config", "uploadpack.allowAnySHA1InWant", "true"])
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = new Uint8Array(await request.arrayBuffer())
      const child = Bun.spawn(["/usr/bin/git", "http-backend"], {
        env: {
          PATH: "/usr/bin:/bin",
          GIT_PROJECT_ROOT: projects,
          GIT_HTTP_EXPORT_ALL: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          CONTENT_LENGTH: String(body.length),
          GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
          HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
          REMOTE_ADDR: "127.0.0.1",
        },
        stdin: body,
        stdout: "pipe",
        stderr: "ignore",
      })
      const output = Buffer.from(await new Response(child.stdout).arrayBuffer())
      await child.exited
      const end = output.indexOf("\r\n\r\n")
      const head = output.subarray(0, end).toString("latin1").split("\r\n")
      const headers = new Headers()
      let status = 200
      for (const line of head) {
        const [name, ...rest] = line.split(":")
        const value = rest.join(":").trim()
        if (name?.toLowerCase() === "status") status = Number.parseInt(value, 10)
        else if (name) headers.set(name, value)
      }
      return new Response(output.subarray(end + 4), { status, headers })
    },
  })
  return {
    url: server.url.origin,
    bare,
    sourceSha,
    /** The commit of `ref` in the remote, or null when it has none. */
    ref: (ref: string) => {
      const child = Bun.spawnSync(["git", "-C", bare, "rev-parse", "--verify", "--quiet", ref])
      return child.exitCode === 0 ? child.stdout.toString().trim() : null
    },
    close: () => server.stop(true),
  }
}

/**
 * A GitHub API stub of the fixture repository, public: its lease refs, the Actions run that a
 * lease ref starts (`actionsRunId`), its commits and its workflows. `started` runs once for each
 * lease ref that the daemon creates, as GitHub starts the caller workflow on its push.
 */
async function githubStub(sourceSha: string, started: (leaseId: string) => void) {
  const leases = new Set<string>()
  const ended = new Set<string>()
  const repository = "/repos/fixture/repo"
  const runOf = (leaseId: string) => ({
    id: actionsRunId,
    run_attempt: 1,
    event: "push",
    head_sha: workflowSha,
    head_branch: `workflowd/leases/${leaseId}`,
    path: ".github/workflows/agent-sandbox-caller.yml",
    repository: { id: 12, fork: false },
    head_repository: { id: 12, fork: false },
    actor: { id: 56 },
    triggering_actor: { id: 56 },
    status: ended.has(leaseId) ? "completed" : "in_progress",
    conclusion: ended.has(leaseId) ? "success" : null,
  })
  let stub: Awaited<ReturnType<typeof githubApiStub>> | undefined = undefined
  const runs = () => [...leases].map(runOf)
  stub = await githubApiStub((path, method) => {
    if (path === repository)
      return Response.json({
        id: 12,
        full_name: "fixture/repo",
        fork: false,
        private: false,
        visibility: "public",
      })
    if (path.startsWith(`${repository}/contents/.github/workflows/`)) return Response.json({})
    if (path === `${repository}/commits/HEAD`) return Response.json({ sha: sourceSha })
    if (method === "POST" && path === `${repository}/git/refs`) {
      const body: unknown = stub?.requests.at(-1)?.body
      const ref = typeof body === "object" && body !== null ? Reflect.get(body, "ref") : undefined
      const leaseId = /^refs\/heads\/workflowd\/leases\/([a-zA-Z0-9-]+)$/.exec(String(ref))?.[1]
      if (leaseId === undefined) return new Response(null, { status: 422 })
      leases.add(leaseId)
      started(leaseId)
      return Response.json({ ref, object: { sha: workflowSha } }, { status: 201 })
    }
    const lease =
      /^\/repos\/fixture\/repo\/git\/refs?\/heads\/workflowd\/leases\/([a-zA-Z0-9-]+)$/.exec(
        path,
      )?.[1]
    if (lease !== undefined && method === "DELETE") {
      leases.delete(lease)
      return new Response(null, { status: 204 })
    }
    if (lease !== undefined)
      return leases.has(lease)
        ? Response.json({
            ref: `refs/heads/workflowd/leases/${lease}`,
            object: { sha: workflowSha },
          })
        : new Response(null, { status: 404 })
    if (path === `${repository}/actions/runs`)
      return Response.json({ total_count: runs().length, workflow_runs: runs() })
    if (path === `${repository}/actions/runs/${actionsRunId}`) {
      const [first] = runs()
      return first === undefined ? new Response(null, { status: 404 }) : Response.json(first)
    }
    if (path === `${repository}/actions/runs/${actionsRunId}/cancel`)
      return new Response(null, { status: 202 })
    return undefined
  })
  return { ...stub, endRun: (leaseId: string) => ended.add(leaseId) }
}

/** The policy of the runner repository: public, actions-native, with the job's own image. */
const runnerPolicy = (agentImage: string) => ({
  alias: "runner",
  repository: "fixture/repo",
  repositoryId: 12,
  installationId: 1,
  workflowSha,
  appActorId: 56,
  agentImage,
  tailscaleClientId: "fixture",
  tailscaleAudience: "fixture",
  privateBootstrap: { mode: "actions-native" as const, repositoryOwnerId: 1 },
})

/**
 * The gateway as its own process, with Git reads: its github.com reads go to the fixture remote,
 * as its model calls go to the fixture model.
 */
async function gitGateway(f: Fixture, gitUrl: string): Promise<Gateway> {
  const github = "https://github.com/"
  const source = `const real = globalThis.fetch
globalThis.fetch = (url, init) =>
  real(typeof url === "string" && url.startsWith(${JSON.stringify(github)}) ? ${JSON.stringify(`${gitUrl}/`)} + url.slice(${github.length}) : url, init)
${gatewaySource(f)}`
  return startGatewayProcess([process.execPath, "-e", source], f.env, f.front)
}

/** What a runner job of the test runs: its directory, its harness and its image. */
export interface RunnerJob {
  /** The run directory of the job; `/run/workflowd-sandbox` on a real runner. */
  readonly directory: string
  /**
   * The harness command of the run client, given the fixture remote's bare repository; the box of
   * `native-runner.mjs` when not named.
   */
  readonly harness?: (bare: string) => Promise<ReadonlyArray<string>>
  /** The job's agent image. */
  readonly image: string
}

/**
 * The runner job of one lease, as the job's private first contact runs it: bootstrap.mjs opens
 * the gateway session with the job's OIDC proof (signed by the fixture key, for the lease ref)
 * and starts the run client, which runs the harness. Resolves once bootstrap ended; the run
 * client goes on in its own process, whose id is in `relay.pid`.
 */
async function startJob(
  f: Fixture,
  job: RunnerJob,
  harness: ReadonlyArray<string> | undefined,
  leaseId: string,
  issuer: string,
) {
  const child = Bun.spawn(
    [
      fixtureExecutable("node"),
      "--input-type=module",
      "-e",
      `import { prepare } from ${JSON.stringify(resolve("deploy/sandbox/bootstrap.mjs"))}
await prepare({
  directory: ${JSON.stringify(job.directory)},
  identity: (url, init) => fetch(${JSON.stringify(issuer)} + url.search, init),
  ${harness === undefined ? "" : `harness: ${JSON.stringify(harness)},`}
}).catch((error) => { process.stderr.write(String(error?.message) + "\\n"); process.exitCode = 1 })`,
    ],
    {
      env: {
        PATH: "/usr/bin:/bin",
        GITHUB_SHA: workflowSha,
        GITHUB_REF: `refs/heads/workflowd/leases/${leaseId}`,
        GITHUB_REPOSITORY: "fixture/repo",
        SANDBOX_GATEWAY_URL: f.front.origin,
        SANDBOX_AGENT_IMAGE: job.image,
        ACTIONS_ID_TOKEN_REQUEST_URL:
          "https://fixture.actions.githubusercontent.com/token?api-version=2",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request",
        NODE_EXTRA_CA_CERTS: f.tls.cert,
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`step job bootstrap: exit ${code}: ${errors}`)
}

/** The process id of a job's run client, or undefined before bootstrap started it. */
const runClientPid = (directory: string) =>
  readFile(join(directory, "relay.pid"), "utf8").then(Number, () => undefined)

/** Whether the process `pid` is alive. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The daemon of the runner placement on workflowd's store `database`: its ingress, and its
 * sandbox dispatch with the gateway's control socket, the GitHub stub and the check of sealed
 * results, which pushes to the fixture remote `bare` in place of github.com.
 */
function daemonRuntime(
  f: Fixture,
  github: Awaited<ReturnType<typeof githubStub>>,
  bare: string,
  policy: ReturnType<typeof runnerPolicy>,
) {
  const stores = Layer.mergeAll(KernelSessionStoreLive, AgentRunStoreLive).pipe(
    Layer.provideMerge(
      KernelEventStoreLive.pipe(
        Layer.provideMerge(
          WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: f.database }))),
        ),
      ),
    ),
  )
  const sealed = Layer.effect(
    SealedResultGit,
    Effect.gen(function* () {
      const scratchRoot = join(f.root, "sealed-scratch")
      yield* Effect.promise(() => mkdir(scratchRoot, { mode: 0o700 }))
      const live = yield* makeSealedResultGit({
        scratchRoot,
        binary: "/usr/bin/git",
        timeLimitMs: sealedResultLimits.timeLimitMs,
        waitLimitMs: sealedResultLimits.waitLimitMs,
        protocols: ["file"],
        remoteAllowed: () => true,
      })
      // The daemon pushes to https://github.com/fixture/repo.git; here, to the fixture remote.
      const port: SealedResultGitPort = {
        check: (result, target, options) =>
          live.check(result, target, { ...options, remote: bare }),
      }
      return port
    }),
  )
  const sandbox = Layer.effect(
    SandboxDispatch,
    Effect.gen(function* () {
      const gateway = yield* makeDaemonCapability({
        socket: f.config.controlSocket,
        reconcileEveryMs: 3600000,
        budget: defaultRunBudget,
        runner: { aliases: [policy.alias], identity: runnerIdentity },
      })
      const leases = yield* makeSandboxLeaseService(
        github.github,
        join(f.root, "control-root"),
        undefined,
        { native: { gateway } },
      )
      const client = yield* OpenCode.make({ baseUrl: "http://127.0.0.1:1" }).pipe(
        Effect.provide(FetchHttpClient.layer),
      )
      return yield* makeSandboxDispatch({
        policies: [policy],
        github: github.github,
        leases,
        client,
        executor: new SdkOpenCodeAdapter(makeOpenCodeSdkClient(Effect.succeed(client))),
        executorId: "opencode:unused",
        endpointIdentity: "http://127.0.0.1:1",
        runner: {
          aliases: [policy.alias],
          maxRuns: 1,
          gateway,
          sealed: yield* SealedResultGit,
          agentGit: { ...runnerIdentity, blockedEmails: [] },
          pollMs: 200,
        },
      })
    }),
  ).pipe(Layer.provide(sealed), Layer.provide(stores))
  const unused = Effect.die("a runner run uses no client of this host")
  const ingress = AgentRunIngressLive({
    routes: [],
    codexRoutes: [],
    claudeRoutes: [{ name: "claude", modelID: runnerModel }],
    placements: { [policy.alias]: "runner" },
    repositories: [{ name: policy.alias, directory: "/unused/repository" }],
    sandboxRepositories: [policy],
    agent: "sandbox",
    worktreeRoot: join(f.root, "worktrees"),
    // A runner run's first event comes once its job holds its session and its box runs Claude.
    verifyTimeoutMs: 900000,
    verifyPollIntervalMs: 50,
    progressWindowMs: 900000,
    maxAttempts: 1,
    claudeHosts: [],
    identity: {
      owningHostId: "mint",
      providerId: "opencode-primary",
      serverId: "opencode-primary",
      endpointAlias: "local",
      endpointIdentity: "http://127.0.0.1:4096",
      providerVersion: 1,
    },
  }).pipe(
    Layer.provideMerge(sandbox),
    Layer.provideMerge(stores),
    Layer.provideMerge(
      Layer.succeed(WorkSignal, { wake: () => Effect.void, subscribe: () => Effect.die("unused") }),
    ),
    Layer.provideMerge(
      Layer.succeed(RepositoryVisibility, { read: github.github.repositoryVisibility }),
    ),
    Layer.provideMerge(Layer.succeed(AgentRunWorktrees, { create: () => unused })),
    Layer.provideMerge(Layer.succeed(CodexCli, makeCodexCli([]).port)),
    Layer.provideMerge(
      Layer.succeed(ClaudeDispatchCli, {
        ownership: "resident-thread",
        preflight: Effect.void,
        spawn: () => unused,
        cancelRun: () => unused,
      }),
    ),
  )
  return ManagedRuntime.make(ingress)
}

/**
 * The daemon and a runner job of the fixture repository, placed on a runner: the real gateway
 * process with Git reads, the daemon's ingress and sandbox dispatch with its runner placement on
 * workflowd's store, a GitHub API stub, the fixture Git remote, and the job that the lease ref
 * starts. `use` gets the daemon's runtime and the parts a test reads; everything ends after it.
 */
export async function withRunnerDaemon<A>(
  job: RunnerJob,
  use: (daemon: {
    readonly f: Fixture
    readonly runtime: ReturnType<typeof daemonRuntime>
    readonly remote: Awaited<ReturnType<typeof gitRemote>>
    /** Settles once the job's run client ended; fails with the job's failure. */
    readonly jobEnded: () => Promise<void>
    /** The job's private record of its harness steps, when the box wrote one. */
    readonly harnessLog: () => Promise<string>
  }) => Promise<A>,
): Promise<A> {
  const f = await fixture({ gitRead: true })
  const remote = await gitRemote(join(f.root, "git"))
  const lease = { id: "none" }
  let jobStart: Promise<void> | undefined
  const issuer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      Response.json({
        value: proof(
          new URL(request.url).searchParams.get("audience") ?? "",
          `jti-${crypto.randomUUID()}`,
          { lease: lease.id, claims: { run_id: String(actionsRunId) } },
        ),
      }),
  })
  const harness = await job.harness?.(remote.bare)
  const github = await githubStub(remote.sourceSha, (leaseId) => {
    lease.id = leaseId
    jobStart = startJob(f, job, harness, leaseId, `${issuer.url.origin}/token`)
    // A failed start is read by `jobEnded`; the daemon's wait for the lease ends on its own.
    jobStart.catch(() => undefined)
  })
  let gateway: Gateway | undefined
  let runtime: ReturnType<typeof daemonRuntime> | undefined
  try {
    gateway = await gitGateway(f, remote.url)
    runtime = daemonRuntime(f, github, remote.bare, runnerPolicy(job.image))
    const jobEnded = async () => {
      for (let tries = 0; jobStart === undefined; tries++) {
        if (tries > 6000) throw new Error("step job: the daemon created no lease ref")
        await Bun.sleep(100)
      }
      await jobStart
      const pid = await runClientPid(job.directory)
      if (pid === undefined) throw new Error("step job: bootstrap started no run client")
      while (alive(pid)) await Bun.sleep(200)
    }
    return await use({
      f,
      runtime,
      remote,
      jobEnded,
      harnessLog: () =>
        readFile(join(job.directory, "native", "harness.log"), "utf8").catch(() => ""),
    })
  } finally {
    const pid = await runClientPid(job.directory)
    if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL")
    await runtime?.dispose()
    await gateway?.stop()
    await issuer.stop(true)
    await github.close()
    await remote.close()
    await f.close()
  }
}

/**
 * The harness of the run client in place of the box, for a host with no Docker: it writes
 * Claude's stream-json lines for the launch, makes the run's change on the source, which it
 * fetches from the fixture remote `bare`, and seals it with the real result.py as the box's
 * harness does, as the launch's agent identity.
 */
export async function writeSealingHarness(directory: string, bare: string) {
  const path = join(directory, "sealing-harness.mjs")
  await writeFile(
    path,
    `import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
const launch = JSON.parse(readFileSync(0, "utf8"))
const directory = process.env.WORKFLOWD_RUN_DIRECTORY
const native = directory + "/native"
const env = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
const run = (argv, input) => execFileSync(argv[0], argv.slice(1), { cwd: native, env, input, encoding: "utf8" })
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
line({ type: "system", subtype: "init", session_id: "fixture-session", model: launch.model })
line({ type: "assistant", message: { content: [{ type: "text", text: "prompt: " + launch.prompt }] } })
mkdirSync(native + "/workspace", { recursive: true })
run(["git", "init", "--quiet", "--bare", "source.git"])
run(["git", "-C", "source.git", "fetch", "--quiet", "--no-tags", ${JSON.stringify(bare)}, launch.sourceSha])
run(["sh", "-c", 'git -C source.git archive "$1" | tar -x -C workspace', "sh", launch.sourceSha])
writeFileSync(native + "/workspace/runner-proof.txt", "written by the runner run\\n")
run(["tar", "-cf", "capture.tar", "-C", "workspace", "."])
const result = ${JSON.stringify(resolve("deploy/sandbox/result.py"))}
run(["python3", "-I", result, "native-export", "capture.tar", launch.sourceSha])
run(["python3", "-I", result, "native-seal", launch.sourceSha], JSON.stringify({
  completion: { title: "workflowd agent run", commitMessage: "workflowd agent run\\n", body: "One file.", finalMessage: "Runner run done." },
  sensitiveValues: [],
  identity: launch.identity,
}))
renameSync(native + "/result", directory + "/result")
line({ type: "assistant", message: { content: [{ type: "text", text: "Runner run done." }] } })
line({ type: "result", subtype: "success", is_error: false, result: "Runner run done." })
`,
  )
  return path
}

/** The run's messages in the caller's mailbox: each prompt of the run's inbox rows, parsed. */
export const mailbox = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ id: string; prompt: string }>`SELECT id,prompt FROM resident_inbox
      WHERE id LIKE ${"%" + runId} ORDER BY id`
    return rows.map((row): { readonly id: string; readonly message: unknown } => ({
      id: row.id,
      message: JSON.parse(row.prompt),
    }))
  })

/** Runs `operation`; a failure names `name`, and the job's harness record when it has one. */
export async function step<A>(
  name: string,
  operation: () => Promise<A>,
  log?: () => Promise<string>,
) {
  try {
    return await operation()
  } catch (error) {
    const record = log === undefined ? "" : await log()
    throw new Error(
      `step ${name}: ${error instanceof Error ? error.message : String(error)}${record === "" ? "" : `\nharness record:\n${record}`}`,
      { cause: error },
    )
  }
}
