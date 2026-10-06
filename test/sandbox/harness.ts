import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { SandboxTransport } from "../../src/sandbox/transport"
import { runSandboxBridge } from "../../src/sandbox/bridge"
import {
  bindingDirectory,
  sandboxPolicyHash,
  transportHash,
  writeSandboxBinding,
} from "../../src/sandbox/binding"
import { Schema } from "effect"

const repository = resolve(import.meta.dir, "../..")

export async function command(args: ReadonlyArray<string>, cwd = repository): Promise<string> {
  const child = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (status !== 0) throw new Error(`${args[0]} exited ${status}: ${stderr}`)
  return stdout.trim()
}

export async function runnerFixture() {
  const root = await mkdtemp(join(tmpdir(), "workflowd-sandbox-"))
  const name = `workflowd-sandbox-${process.pid}-${root.split("-").at(-1) ?? "fixture"}`
  const docker = (...args: string[]) => command(["env", "DOCKER_BUILDKIT=0", "docker", ...args])
  const close = async () => {
    await docker("rm", "-f", `${name}-runner`, `${name}-engine`)
    await docker("network", "rm", name)
    await rm(root, { recursive: true, force: true })
  }
  try {
    await docker(
      "build",
      "--memory=512m",
      "--memory-swap=512m",
      "-t",
      "workflowd-sandbox-tooling:fixture",
      "-f",
      "deploy/sandbox/Containerfile",
      "deploy/sandbox",
    )
    await docker(
      "build",
      "--memory=512m",
      "--memory-swap=512m",
      "-t",
      "workflowd-sandbox-runner:fixture",
      "-f",
      "test/sandbox/fixtures/runner.Containerfile",
      "test/sandbox/fixtures",
    )
    await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(root, "key")])
    await docker("network", "create", name)
    await docker(
      "run",
      "-d",
      "--name",
      `${name}-engine`,
      "--memory=2g",
      "--memory-swap=2g",
      "--network",
      name,
      "--network-alias",
      "engine",
      "--privileged",
      "registry.dagger.io/engine@sha256:56b68be5d9fc8e0a4e7c8db7599a76571f8806d5a9623d9afa6764ae3f8cae36",
      "--addr",
      "tcp://0.0.0.0:1234",
    )
    await docker(
      "run",
      "-d",
      "--name",
      `${name}-runner`,
      "--memory=512m",
      "--memory-swap=512m",
      "--network",
      name,
      "-p",
      "127.0.0.1::22",
      "workflowd-sandbox-runner:fixture",
    )
    await docker("cp", join(root, "key.pub"), `${name}-runner:/home/runner/.ssh/authorized_keys`)
    await docker(
      "exec",
      "-u",
      "root",
      `${name}-runner`,
      "chown",
      "runner:runner",
      "/home/runner/.ssh/authorized_keys",
    )
    const port = Number((await docker("port", `${name}-runner`, "22/tcp")).split(":").at(-1))
    const hostKey = await docker(
      "exec",
      `${name}-runner`,
      "cat",
      "/etc/ssh/ssh_host_ed25519_key.pub",
    )
    await writeFile(join(root, "known_hosts"), `[127.0.0.1]:${port} ${hostKey}\n`)
    const transport: SandboxTransport = {
      leaseId: name,
      peerId: name,
      repositoryPath: "/workspace/repository",
      address: "127.0.0.1",
      port,
      identityFile: join(root, "key"),
      knownHostsFile: join(root, "known_hosts"),
    }
    await writeFile(join(root, "transport.json"), JSON.stringify(transport))
    const directory = join(root, "bridge-session")
    await mkdir(directory)
    await writeSandboxBinding(
      {
        runId: name,
        leaseId: transport.leaseId,
        sessionId: "ses_fixture",
        executorId: "fixture",
        endpointIdentity: "fixture",
        directory,
        locationIdentity: "fixture",
        bridgeServerName: "wfdlease_fixture",
        repositoryId: 1,
        sourceSha: "a".repeat(40),
        policyHash: sandboxPolicyHash,
        transportHash: transportHash(transport),
        deadline: Date.now() + 3600000,
        state: "active",
      },
      true,
    )
    const bindingFile = join(bindingDirectory(directory), "binding.json")
    return {
      bindingFile,
      root,
      name,
      transport,
      close,
      docker,
    }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}

export function bridgeClient(
  transport: SandboxTransport,
  bindingFile = join(
    bindingDirectory(join(dirname(transport.knownHostsFile), "bridge-session")),
    "binding.json",
  ),
) {
  const incoming = new TransformStream<Uint8Array, Uint8Array>()
  const outgoing = new TransformStream<string, string>()
  const input = incoming.writable.getWriter()
  const output = outgoing.writable.getWriter()
  const reader = outgoing.readable.getReader()
  const settled = runSandboxBridge(
    transport,
    incoming.readable,
    (frame) => output.write(frame),
    bindingFile,
  ).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  )
  let id = 0
  const raw = (text: string) => input.write(new TextEncoder().encode(text))
  const request = async (method: string, params: Schema.Json = {}) => {
    await raw(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n")
    const line = await Promise.race([
      reader.read(),
      settled.then((error) => {
        throw error ?? new Error("Bridge closed")
      }),
    ])
    if (line.done) throw new Error("Bridge closed")
    const value: unknown = JSON.parse(line.value)
    return Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Json }))(value).result
  }
  return {
    raw,
    request,
    settled,
    initialize: async () => {
      await request("initialize")
      await raw('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    },
    close: async () => {
      await input.close().catch(() => undefined)
      await settled
      await reader.cancel()
    },
  }
}

export async function sandboxGithubFixture(
  policy: {
    repository: string
    repositoryId: number
    installationId: number
    workflowSha: string
    appActorId: number
  },
  leaseId = "lease-1",
) {
  const { generateKeyPairSync } = await import("node:crypto")
  const { Octokit } = await import("@octokit/rest")
  const root = await mkdtemp(join(tmpdir(), "sandbox-github-"))
  const privateKeyPath = join(root, "app.pem")
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  })
  await writeFile(privateKeyPath, key, { mode: 0o600 })
  let ref: string | null = null
  let refCreates = 0
  let refDeletes = 0
  let archive: ArrayBuffer | null = null
  const tokenRequests: unknown[] = []
  const original = {
    id: 41,
    run_attempt: 1,
    event: "push",
    head_branch: `workflowd/leases/${leaseId}`,
    head_sha: policy.workflowSha,
    path: ".github/workflows/agent-sandbox-caller.yml",
    repository: { id: policy.repositoryId, fork: false },
    head_repository: { id: policy.repositoryId, fork: false },
    actor: { id: policy.appActorId },
    triggering_actor: { id: policy.appActorId },
    status: "in_progress",
    conclusion: null,
  }
  let run: unknown = original
  const savedRuns = new Map<number, { status: number; value: unknown }>()
  const savedRunRequests: number[] = []
  let beforeCancel: ((id: number) => Promise<void>) | undefined
  let afterRefDelete: (() => void) | undefined
  let deleteStatus = 204
  let retainRef = false
  let listedRuns: ReadonlyArray<unknown> | undefined
  let inventoryPages:
    ReadonlyArray<{ status?: number; total: number; runs: ReadonlyArray<unknown> }> | undefined
  let cancelStatus = 202
  let sourceSha = "b".repeat(40)
  const inventoryRequests: number[] = []
  const cancellations: number[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith("/access_tokens")) {
        tokenRequests.push(await request.json())
        return Response.json(
          {
            token: "fixture-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions: { contents: "write", actions: "write" },
            repository_selection: "selected",
          },
          { status: 201 },
        )
      }
      if (
        request.headers.get("authorization") !== "token fixture-token" &&
        request.headers.get("authorization") !== "Bearer fixture-token"
      )
        return new Response(null, { status: 401 })
      if (path === `/repos/${policy.repository}`)
        return Response.json({
          id: policy.repositoryId,
          full_name: policy.repository,
          fork: false,
          private: false,
        })
      if (path.includes("/commits/")) return Response.json({ sha: sourceSha })
      if (path.includes("/contents/.github/workflows/")) return Response.json({ type: "file" })
      if (path.endsWith("/git/refs") && request.method === "POST") {
        refCreates++
        const body: unknown = await request.json()
        const input = Schema.decodeUnknownSync(
          Schema.Struct({ ref: Schema.String, sha: Schema.String }),
        )(body)
        ref = input.sha
        // GitHub accepted the side effect, but the caller lost its acknowledgement.
        return new Response(null, { status: 502 })
      }
      if (path.includes("/git/ref/heads/"))
        return ref === null
          ? new Response(null, { status: 404 })
          : Response.json({ ref: `refs/heads/workflowd/leases/${leaseId}`, object: { sha: ref } })
      if (path.endsWith("/cancel") && request.method === "POST") {
        const id = Number(path.split("/").at(-2))
        await beforeCancel?.(id)
        cancellations.push(id)
        return new Response(null, { status: cancelStatus })
      }
      if (path.includes("/git/refs/heads/") && request.method === "DELETE") {
        refDeletes++
        if (!retainRef) ref = null
        afterRefDelete?.()
        return new Response(null, { status: deleteStatus })
      }
      if (path.endsWith("/artifacts"))
        return Response.json({
          total_count: archive === null ? 0 : 1,
          artifacts:
            archive === null
              ? []
              : [
                  {
                    id: 52,
                    name: "sandbox-ready-41-1",
                    size_in_bytes: archive.byteLength,
                    expired: false,
                  },
                ],
        })
      if (path.endsWith("/artifacts/52/zip") && archive !== null)
        return new Response(archive, { headers: { "content-type": "application/zip" } })
      if (path.endsWith("/actions/runs")) {
        const query = new URL(request.url).searchParams
        if (!query.has("branch")) {
          const page = Number(query.get("page") ?? 1)
          inventoryRequests.push(page)
          const response = inventoryPages?.[page - 1]
          if (response !== undefined)
            return Response.json(
              { total_count: response.total, workflow_runs: response.runs },
              { status: response.status ?? 200 },
            )
        }
        return Response.json({
          total_count: (listedRuns ?? [run]).length,
          workflow_runs: listedRuns ?? [run],
        })
      }
      const savedId = /\/actions\/runs\/(\d+)$/.exec(path)?.[1]
      if (savedId !== undefined) {
        const id = Number(savedId)
        savedRunRequests.push(id)
        const saved = savedRuns.get(id)
        return saved !== undefined
          ? Response.json(saved.value, { status: saved.status })
          : id === 41
            ? Response.json(run)
            : new Response(null, { status: 404 })
      }
      return new Response(null, { status: 404 })
    },
  })
  return {
    github: { appId: 1, privateKeyPath },
    apiUrl: server.url.toString(),
    tokenRequests,
    cancellations,
    savedRunRequests,
    beforeCancel: (check: (id: number) => Promise<void>) => {
      beforeCancel = check
    },
    afterRefDelete: (effect: () => void) => {
      afterRefDelete = effect
    },
    deleteResponse: (status: number, retain = false) => {
      deleteStatus = status
      retainRef = retain
    },
    savedRun: (id: number, mutation: Record<string, unknown>, status = 200) => {
      savedRuns.set(id, { status, value: { ...original, id, ...mutation } })
    },
    inventoryRequests,
    source: (sha: string) => {
      sourceSha = sha
    },
    failCancellation: (status: number) => {
      cancelStatus = status
    },
    inventoryPages: (
      pages: ReadonlyArray<{
        status?: number
        total: number
        runs: ReadonlyArray<Record<string, unknown>>
      }>,
    ) => {
      inventoryPages = pages.map((page) => ({
        ...page,
        runs: page.runs.map((mutation) => ({ ...original, ...mutation })),
      }))
    },
    listRuns: (runs: ReadonlyArray<Record<string, unknown>>) => {
      listedRuns = runs.map((mutation) => ({ ...original, ...mutation }))
      for (const mutation of runs) {
        if (typeof mutation.id === "number" && mutation.id !== 41 && !savedRuns.has(mutation.id))
          savedRuns.set(mutation.id, { status: 200, value: { ...original, ...mutation } })
      }
    },
    setReady: async (ready: unknown) => {
      await writeFile(join(root, "ready.json"), JSON.stringify(ready))
      await command(["zip", "-q", "-j", join(root, "ready.zip"), join(root, "ready.json")])
      archive = await Bun.file(join(root, "ready.zip")).arrayBuffer()
    },
    get refDeletes() {
      return refDeletes
    },
    get refCreates() {
      return refCreates
    },
    OctokitClass: Octokit.defaults({
      baseUrl: server.url.toString(),
      log: { debug() {}, info() {}, warn() {}, error() {} },
    }),
    mutateRun: (mutation: Record<string, unknown>) => {
      run = { ...original, ...mutation }
    },
    close: async () => {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    },
  }
}

export async function dispatchRunnerFixture() {
  const runner = await runnerFixture()
  try {
    const adapter = join(runner.root, "docker")
    await writeFile(
      adapter,
      '#!/bin/sh\nset -eu\ntest "$1" = exec\ntest "$2" = workflowd-sandbox-tooling\nshift 2\ncd /workspace/repository\nexec "$@"\n',
      { mode: 0o755 },
    )
    await runner.docker("cp", adapter, `${runner.name}-runner:/usr/local/bin/docker`)
    await runner.docker(
      "exec",
      "-u",
      "root",
      `${runner.name}-runner`,
      "chmod",
      "755",
      "/usr/local/bin/docker",
    )
    return runner
  } catch (error) {
    await runner.close()
    throw error
  }
}

export async function sandboxCoordinatorProcess(input: {
  database: string
  policy: import("../../src/sandbox/config").SandboxPolicy
  github: { appId: number; privateKeyPath: string }
  apiUrl: string
  fullControlDirectory?: string
  fullControlFiles?: Record<string, string>
  openCodeUrl?: string
  openCodeFault?: { path: string; method?: string; after?: boolean }
}) {
  const source = `
    import { SqliteClient } from "@effect/sql-sqlite-bun"
    import { Effect, Layer, Schedule } from "effect"
    import { Octokit } from "@octokit/rest"
    import { WorkflowStoreLive } from "./src/store.ts"
    import { AgentRunStoreLive } from "./src/kernel/agent-run-store.ts"
    import { makeSandboxGithub } from "./src/sandbox/github.ts"
    import { makeSandboxLeaseService } from "./src/sandbox/lease.ts"
    import { makeSandboxDispatch } from "./src/sandbox/dispatch.ts"
    import { OpenCode } from "@opencode-ai/client/effect"
    import { FetchHttpClient } from "effect/unstable/http"
    import { SdkOpenCodeAdapter, makeOpenCodeSdkClient } from "./src/opencode/adapter.ts"
    const input = JSON.parse(process.env.SANDBOX_FIXTURE_OPTIONS)
    if (input.fullControlDirectory) {
      for (const [name, contents] of Object.entries(input.fullControlFiles ?? {})) await Bun.write(input.fullControlDirectory + "/" + name, contents)
      try { await Bun.write(input.fullControlDirectory + "/fill", new Uint8Array(131072)); throw new Error("Expected ENOSPC") }
      catch (error) { if (error.code !== "ENOSPC") throw error }
      console.log("disk exhaustion verified")
    }
    const base = WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: input.database })))
    const layer = AgentRunStoreLive.pipe(Layer.provideMerge(base))
    await Effect.runPromise(Effect.gen(function* () {
      const github = yield* makeSandboxGithub(input.github, Octokit.defaults({ baseUrl: input.apiUrl, log: { debug() {}, info() {}, warn() {}, error() {} } }))
      const leases = yield* makeSandboxLeaseService(github)
      const url = input.openCodeUrl ?? "http://127.0.0.1:1"
      const sdkFetch = Object.assign(async (target, init) => {
        const headers = new Headers(init?.headers)
        headers.set("Authorization", "Basic " + Buffer.from("opencode:fixture-server-password").toString("base64"))
        const fault = input.openCodeFault
        const reject = fault && new URL(target instanceof Request ? target.url : target).pathname.endsWith(fault.path) && (!fault.method || fault.method === init?.method)
        if (reject && !fault.after) return new Response(null, {status:502})
        const response = await fetch(target, {...init,headers})
        if (reject && fault.after) { await response.arrayBuffer(); return new Response(null, {status:502}) }
        return response
      }, {preconnect:fetch.preconnect})
      const client = yield* OpenCode.make({baseUrl:url}).pipe(Effect.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch,sdkFetch)))))
      const executor = new SdkOpenCodeAdapter(makeOpenCodeSdkClient(Effect.succeed(client)))
      const service = yield* makeSandboxDispatch({ policies: [input.policy], github, leases, client, executor, executorId: "opencode:opencode-primary", endpointIdentity: url })
      console.log("coordinator ready")
      yield* service.iteration.pipe(Effect.ignore, Effect.repeat(Schedule.spaced("30 seconds")))
    }).pipe(Effect.provide(layer)))
  `
  const unit =
    input.fullControlDirectory === undefined
      ? undefined
      : `workflowd-sandbox-test-coordinator-${crypto.randomUUID()}`
  const args =
    unit === undefined
      ? [process.execPath, "--eval", source]
      : [
          "systemd-run",
          "--user",
          "--wait",
          "--pipe",
          "--collect",
          "--expand-environment=no",
          `--unit=${unit}`,
          "-p",
          "PrivateUsers=yes",
          "-p",
          `TemporaryFileSystem=${input.fullControlDirectory}:rw,size=64k,mode=1777`,
          "-p",
          "MemoryMax=512M",
          "-p",
          "MemorySwapMax=0",
          `--working-directory=${repository}`,
          `--setenv=SANDBOX_FIXTURE_OPTIONS=${JSON.stringify(input)}`,
          process.execPath,
          "--eval",
          source,
        ]
  const child = Bun.spawn(args, {
    cwd: repository,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      SANDBOX_FIXTURE_OPTIONS: JSON.stringify(input),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stop = async () => {
    if (unit !== undefined)
      await command(["systemctl", "--user", "kill", "--signal=SIGKILL", unit]).catch(
        () => undefined,
      )
    child.kill("SIGKILL")
    await child.exited
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000)
  try {
    const reader = child.stdout.getReader()
    let output = ""
    for (;;) {
      const item = await reader.read()
      if (item.done)
        throw new Error(
          "Sandbox coordinator exited before readiness: " +
            (await new Response(child.stderr).text()),
        )
      output += new TextDecoder().decode(item.value)
      if (output.includes("coordinator ready")) break
      if (output.length > 4096) throw new Error("Unexpected coordinator output")
    }
    reader.releaseLock()
    return { stop, output }
  } catch (error) {
    await stop()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function sandboxIngressFixtureLayer(
  provider: import("../../src/kernel/agent-run-ingress").AgentRunProviderPort,
  sandbox: import("effect").Effect.Effect<
    import("../../src/sandbox/dispatch").SandboxDispatchPort,
    never,
    | import("effect/unstable/sql/SqlClient").SqlClient
    | import("../../src/kernel/agent-run-store").AgentRunStorePort
  >,
  policy: import("../../src/sandbox/config").SandboxPolicy,
  options?: { root: string; providerID: string; modelID: string },
) {
  const { Effect, Layer } = await import("effect")
  const { SqliteClient } = await import("@effect/sql-sqlite-bun")
  const { WorkflowStoreLive } = await import("../../src/store")
  const { KernelSessionStoreLive } = await import("../../src/kernel/session-store")
  const { KernelEventStoreLive } = await import("../../src/kernel/event-store")
  const { AgentRunStoreLive } = await import("../../src/kernel/agent-run-store")
  const { AgentHandoffStore, AgentHandoffStoreLive } =
    await import("../../src/kernel/agent-handoff-store")
  const { AgentWaitIngressLive } = await import("../../src/kernel/agent-wait-ingress")
  const { AgentRunIngressLive, AgentRunProvider } =
    await import("../../src/kernel/agent-run-ingress")
  const { AgentRunWorktrees } = await import("../../src/kernel/agent-run-worktrees")
  const { CodexCli } = await import("../../src/kernel/codex-session")
  const { SandboxDispatch } = await import("../../src/sandbox/dispatch")
  const { routeSandboxHandoffs, routeSandboxProvider } = await import("../../src/sandbox/provider")
  const { WorkSignal } = await import("../../src/work-signal")
  const { makeCodexCli } = await import("../kernel/agent-run-ingress-harness")
  const base = WorkflowStoreLive.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  )
  const stores = Layer.mergeAll(
    KernelSessionStoreLive,
    AgentRunStoreLive,
    AgentHandoffStoreLive,
  ).pipe(Layer.provideMerge(KernelEventStoreLive.pipe(Layer.provideMerge(base))))
  const signals = Layer.succeed(WorkSignal, {
    wake: () => Effect.void,
    subscribe: () => Effect.die("unused"),
  })
  const identity = {
    owningHostId: "mint",
    providerId: "opencode-primary",
    serverId: "opencode-primary",
    endpointAlias: "local",
    endpointIdentity: "http://127.0.0.1:4096",
    providerVersion: 1,
  }
  const waits = AgentWaitIngressLive(identity).pipe(
    Layer.provide(
      Layer.effect(AgentHandoffStore, routeSandboxHandoffs).pipe(Layer.provide(stores)),
    ),
    Layer.provideMerge(stores),
    Layer.provideMerge(signals),
  )
  const sandboxLayer = Layer.effect(SandboxDispatch, sandbox).pipe(Layer.provide(stores))
  const providerLayer =
    options === undefined
      ? Layer.succeed(AgentRunProvider, provider)
      : Layer.effect(
          AgentRunProvider,
          Effect.gen(function* () {
            return yield* routeSandboxProvider(provider, yield* SandboxDispatch)
          }),
        ).pipe(Layer.provide(sandboxLayer), Layer.provide(stores))
  return AgentRunIngressLive({
    routes: [
      {
        name: "implement",
        providerID: options?.providerID ?? "openai",
        modelID: options?.modelID ?? "gpt-6-astra-fixture",
      },
    ],
    codexRoutes: [],
    repositories: [{ name: policy.alias, directory: "/unused/repository" }],
    sandboxRepositories: [policy],
    agent: "sandbox",
    worktreeRoot: options?.root ?? "/var/lib/workflowd-test",
    verifyTimeoutMs: options === undefined ? 50 : 10000,
    verifyPollIntervalMs: 10,
    progressWindowMs: 600000,
    maxAttempts: 1,
    claudeHosts: [],
    identity,
  }).pipe(
    Layer.provideMerge(waits),
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(
      Layer.succeed(AgentRunWorktrees, {
        create: () => Effect.die("Sandbox attempted a local worktree"),
      }),
    ),
    Layer.provideMerge(Layer.succeed(CodexCli, makeCodexCli([]).port)),
  )
}

// The runner script and SSH are real. Local fixture identity replaces tailnet
// discovery, and a single-container Docker adapter avoids nesting a daemon.
export async function leaseRunnerFixture(repositoryName: string) {
  const runner = await runnerFixture()
  try {
    const sourceSha = await runner.docker(
      "exec",
      "-u",
      "runner",
      `${runner.name}-runner`,
      "git",
      "rev-parse",
      "HEAD",
    )
    const key = (
      await runner.docker(
        "exec",
        `${runner.name}-runner`,
        "cat",
        "/etc/ssh/ssh_host_ed25519_key.pub",
      )
    )
      .split(" ")
      .slice(0, 2)
      .join(" ")
    const adapter = join(runner.root, "docker")
    await writeFile(
      adapter,
      '#!/bin/sh\nset -eu\ntest "$1" = exec\ntest "$2" = workflowd-sandbox-tooling\nshift 2\ncd /workspace/repository\nexec "$@"\n',
      { mode: 0o755 },
    )
    await runner.docker("cp", adapter, `${runner.name}-runner:/usr/local/bin/docker`)
    await runner.docker(
      "cp",
      "deploy/sandbox/runner.sh",
      `${runner.name}-runner:/usr/local/bin/container-use`,
    )
    await runner.docker(
      "exec",
      "-u",
      "root",
      `${runner.name}-runner`,
      "bash",
      "-c",
      "mkdir -p /run/workflowd-sandbox && chown runner:runner /run/workflowd-sandbox && chmod 755 /usr/local/bin/docker /usr/local/bin/container-use",
    )
    await runner.docker(
      "exec",
      "-u",
      "runner",
      `${runner.name}-runner`,
      "bash",
      "-c",
      'git clone --bare . /home/runner/source.git && git config --global url.file:///home/runner/source.git.insteadOf "$1" && rm -rf .git README',
      "_",
      `https://github.com/${repositoryName}.git`,
    )
    const identityFile = join(runner.root, "identity.json")
    await writeFile(identityFile, JSON.stringify({ repository: repositoryName }))
    await runner.docker(
      "cp",
      identityFile,
      `${runner.name}-runner:/run/workflowd-sandbox/identity.json`,
    )
    const { sandboxSshArguments } = await import("../../src/sandbox/transport")
    const control = async (args: ReadonlyArray<string>, input: string, signal: AbortSignal) => {
      if (args[0] === "/usr/bin/tailscale")
        return JSON.stringify({
          Peer: {
            fixture: {
              ID: "peer-1",
              TailscaleIPs: ["100.64.0.1"],
              Online: true,
              Tags: ["tag:agent-runner"],
              sshHostKeys: [key],
            },
          },
        })
      const child = Bun.spawn(
        [...sandboxSshArguments(runner.transport).slice(0, -1), args.at(-1) ?? ""],
        {
          stdin: new Blob([input]),
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const stop = () => {
        child.kill("SIGKILL")
      }
      signal.addEventListener("abort", stop, { once: true })
      try {
        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        if (status !== 0) {
          const log = await runner
            .docker("exec", `${runner.name}-runner`, "cat", "/run/workflowd-sandbox/clone.log")
            .catch(() => "")
          throw new Error(`SSH control failed: ${stderr} ${log}`)
        }
        return stdout.trim()
      } finally {
        signal.removeEventListener("abort", stop)
        stop()
        await child.exited
      }
    }
    return { ...runner, sourceSha, control }
  } catch (error) {
    await runner.close()
    throw error
  }
}
