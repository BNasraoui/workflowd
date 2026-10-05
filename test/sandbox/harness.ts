import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SandboxTransport } from "../../src/sandbox/transport"
import { runSandboxBridge } from "../../src/sandbox/bridge"
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
    return {
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

export function bridgeClient(transport: SandboxTransport) {
  const incoming = new TransformStream<Uint8Array, Uint8Array>()
  const outgoing = new TransformStream<string, string>()
  const input = incoming.writable.getWriter()
  const output = outgoing.writable.getWriter()
  const reader = outgoing.readable.getReader()
  const settled = runSandboxBridge(transport, incoming.readable, (frame) =>
    output.write(frame),
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

export async function sandboxGithubFixture(policy: {
  repository: string
  repositoryId: number
  installationId: number
  workflowSha: string
  appActorId: number
}) {
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
    head_branch: "workflowd/leases/lease-1",
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
  let listedRuns: ReadonlyArray<unknown> | undefined
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
          : Response.json({ ref: "refs/heads/workflowd/leases/lease-1", object: { sha: ref } })
      if (path.endsWith("/cancel") && request.method === "POST") {
        cancellations.push(Number(path.split("/").at(-2)))
        return new Response(null, { status: 202 })
      }
      if (path.includes("/git/refs/heads/") && request.method === "DELETE") {
        refDeletes++
        ref = null
        return new Response(null, { status: 204 })
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
      if (path.endsWith("/actions/runs"))
        return Response.json({
          total_count: (listedRuns ?? [run]).length,
          workflow_runs: listedRuns ?? [run],
        })
      if (path.endsWith("/actions/runs/41")) return Response.json(run)
      return new Response(null, { status: 404 })
    },
  })
  return {
    github: { appId: 1, privateKeyPath },
    tokenRequests,
    cancellations,
    listRuns: (runs: ReadonlyArray<Record<string, unknown>>) => {
      listedRuns = runs.map((mutation) => ({ ...original, ...mutation }))
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
              SSH_HostKeys: [key],
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
