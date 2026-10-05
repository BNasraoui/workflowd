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
