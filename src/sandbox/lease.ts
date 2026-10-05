import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { makeSandboxStore, SandboxError } from "./store"
import { sandboxSshArguments, type SandboxTransport } from "./transport"
import type { makeSandboxGithub } from "./github"

type Github = Effect.Success<ReturnType<typeof makeSandboxGithub>>

const PeerStatus = Schema.Struct({
  Peer: Schema.Record(
    Schema.String,
    Schema.Struct({
      ID: Schema.String,
      TailscaleIPs: Schema.Array(Schema.String),
      Tags: Schema.optionalKey(Schema.Array(Schema.String)),
      Online: Schema.Boolean,
      SSH_HostKeys: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
})

export function bindSandboxPeer(
  expected: { peerId: string; address: string },
  value: unknown,
): ReadonlyArray<string> {
  const status = Schema.decodeUnknownSync(PeerStatus)(value)
  const matches = Object.values(status.Peer).filter(
    (peer) => peer.ID === expected.peerId && peer.TailscaleIPs.includes(expected.address),
  )
  const peer = matches[0]
  if (
    matches.length !== 1 ||
    peer === undefined ||
    !peer.Online ||
    !peer.Tags?.includes("tag:agent-runner") ||
    !peer.SSH_HostKeys?.length ||
    peer.SSH_HostKeys.some(
      (key) => !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+$/.test(key),
    )
  )
    throw new SandboxError({ message: "Sandbox authenticated Tailscale peer mismatch" })
  return peer.SSH_HostKeys
}

async function controlCommand(
  args: ReadonlyArray<string>,
  input: string,
  signal: AbortSignal,
): Promise<string> {
  const child = Bun.spawn([...args], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
  })
  const stop = () => {
    child.kill("SIGKILL")
  }
  signal.addEventListener("abort", stop, { once: true })
  const timer = setTimeout(stop, 300000)
  try {
    const reader = child.stdout.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.length
      if (length > 1048576)
        throw new SandboxError({ message: "Sandbox control output exceeded its bound" })
      chunks.push(item.value)
    }
    if ((await child.exited) !== 0)
      throw new SandboxError({ message: "Sandbox control command failed" })
    return Buffer.concat(chunks).toString().trim()
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", stop)
    stop()
    await child.exited
  }
}

const connectPeer = (
  lease: { lease_id: string; source_sha: string; policy: { repository: string } },
  ready: { peerId: string; address: string },
  root: string,
  command: typeof controlCommand,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const status: unknown = JSON.parse(
        await command(["/usr/bin/tailscale", "status", "--json"], "", signal),
      )
      const keys = bindSandboxPeer(ready, status)
      await mkdir(root, { recursive: true, mode: 0o700 })
      const directory = await mkdtemp(join(root, lease.lease_id + "-"))
      try {
        const knownHostsFile = join(directory, "known_hosts")
        await writeFile(knownHostsFile, keys.map((key) => `${ready.address} ${key}\n`).join(""), {
          mode: 0o600,
        })
        const transport: SandboxTransport = {
          leaseId: lease.lease_id,
          peerId: ready.peerId,
          address: ready.address,
          port: 22,
          repositoryPath: "/workspace/repository",
          knownHostsFile,
          identityFile: "/dev/null",
        }
        const args = sandboxSshArguments(transport).slice(0, -1)
        await command([...args, "exec /usr/local/bin/container-use heartbeat"], "", signal)
        const source = await command(
          [...args, "exec /usr/local/bin/container-use initialize"],
          JSON.stringify({ repository: lease.policy.repository, sourceSha: lease.source_sha }),
          signal,
        )
        if (source !== lease.source_sha)
          throw new SandboxError({ message: "Sandbox source checkout unconfirmed" })
        return transport
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
    },
    catch: () => new SandboxError({ message: "Sandbox authenticated peer initialization failed" }),
  })

export const makeSandboxLeaseService = (
  github: Github,
  controlRoot = join(homedir(), ".local/share/workflowd/sandboxes"),
  command = controlCommand,
) =>
  Effect.gen(function* () {
    const store = yield* makeSandboxStore
    const required = Effect.fn("SandboxLease.required")(function* (runId: string) {
      const lease = yield* store.read(runId)
      if (lease === null)
        return yield* Effect.fail(
          new SandboxError({ message: "Sandbox intent must exist before acquisition" }),
        )
      return lease
    })
    const release = Effect.fn("SandboxLease.release")(function* (runId: string) {
      const lease = yield* required(runId)
      if (lease.state === "released") return
      yield* store.beginRelease(runId)
      yield* Effect.gen(function* () {
        const runs = yield* github.runs(lease.policy, lease.lease_id)
        if (lease.actions_run_id !== null && lease.actions_attempt !== null) {
          const saved = yield* github.savedRun(
            lease.policy,
            lease.lease_id,
            lease.actions_run_id,
            lease.actions_attempt,
          )
          const index = runs.findIndex((run) => run.id === saved.id)
          if (index === -1) runs.push(saved)
          else runs[index] = saved
        }
        // The GitHub run can appear after a lost ref-creation response. Absence
        // is not termination; reconciliation retains custody until it is observed.
        if (runs.length === 0) return
        for (const run of runs) {
          if (run.status !== "completed") yield* github.cancel(lease.policy, run.id)
        }
        if (runs.some((run) => run.status !== "completed")) return
        yield* github.deleteRef(lease.policy, lease.lease_id)
        yield* store.confirmReleased(runId)
      }).pipe(Effect.tapError(() => store.recordError(runId)))
    })
    const acquire = Effect.fn("SandboxLease.acquire")(function* (runId: string) {
      let lease = yield* required(runId)
      if (lease.state === "ready") return lease
      if (lease.state === "requested") {
        if (!(yield* store.beginStart(runId))) return yield* required(runId)
        lease = yield* required(runId)
      }
      if (lease.state !== "starting")
        return yield* Effect.fail(
          new SandboxError({ message: "Sandbox lease cannot be acquired in its current state" }),
        )
      yield* github.ensureRef(lease.policy, lease.lease_id)
      const runs = yield* github.runs(lease.policy, lease.lease_id)
      if (runs.length > 1)
        return yield* Effect.fail(
          new SandboxError({ message: "Multiple Actions runs claimed the sandbox lease" }),
        )
      const run = runs[0]
      if (run !== undefined) {
        yield* store.recordRun(runId, run.id, run.run_attempt)
        if (run.status === "completed") yield* release(runId)
        else {
          const ready = yield* github.readiness(
            lease.policy,
            lease.lease_id,
            run.id,
            run.run_attempt,
          )
          if (ready !== null) {
            const transport = yield* connectPeer(lease, ready, controlRoot, command)
            yield* store.bind(runId, run.id, run.run_attempt, transport)
          }
        }
      }
      return yield* required(runId)
    })
    const reconcile = Effect.fn("SandboxLease.reconcile")(function* () {
      const leases = yield* store.active()
      yield* Effect.forEach(
        leases,
        (lease) =>
          lease.state === "releasing" || lease.deadline <= Date.now()
            ? release(lease.run_id)
            : acquire(lease.run_id),
        { discard: true },
      )
    })
    return { acquire, release, reconcile }
  })
