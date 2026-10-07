import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import {
  makeSandboxStore,
  SandboxError,
  SandboxRefAbsent,
  SandboxRefRejected,
  sessionCleanupUnconfirmed,
  isUnobservedRun,
} from "./store"
import { sandboxSshArguments, type SandboxTransport } from "./transport"
import type { makeSandboxGithub } from "./github"
import type { SandboxPolicy } from "./config"

type Github = Effect.Success<ReturnType<typeof makeSandboxGithub>>

const PeerStatus = Schema.Struct({
  Peer: Schema.Record(
    Schema.String,
    Schema.Struct({
      ID: Schema.String,
      TailscaleIPs: Schema.Array(Schema.String),
      Tags: Schema.optionalKey(Schema.Array(Schema.String)),
      Online: Schema.Boolean,
      sshHostKeys: Schema.optionalKey(Schema.Array(Schema.String)),
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
    !peer.sshHostKeys?.length ||
    peer.sshHostKeys.some(
      (key) => !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+$/.test(key),
    )
  )
    throw new SandboxError({ message: "Sandbox authenticated Tailscale peer mismatch" })
  return peer.sshHostKeys
}

async function controlCommand(
  args: ReadonlyArray<string>,
  input: string,
  signal: AbortSignal,
  limit = 1048576,
): Promise<string | Uint8Array> {
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
      if (length > limit)
        throw new SandboxError({ message: "Sandbox control output exceeded its bound" })
      chunks.push(item.value)
    }
    if ((await child.exited) !== 0)
      throw new SandboxError({ message: "Sandbox control command failed" })
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", stop)
    stop()
    await child.exited
  }
}

const controlText = (value: string | Uint8Array) =>
  typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value)

const connectPeer = (
  lease: { lease_id: string; source_sha: string; policy: { repository: string } },
  ready: { peerId: string; address: string },
  root: string,
  command: typeof controlCommand,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const status: unknown = JSON.parse(
        controlText(await command(["/usr/bin/tailscale", "status", "--json"], "", signal)),
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
        const keepalive = new AbortController()
        const initializing = AbortSignal.any([signal, keepalive.signal])
        let pulse = Promise.resolve()
        const timer = setInterval(() => {
          pulse = command(
            [...args, "exec /usr/local/bin/container-use heartbeat"],
            "",
            AbortSignal.any([initializing, AbortSignal.timeout(10000)]),
          ).then(
            () => undefined,
            () => {
              keepalive.abort()
            },
          )
        }, 30000)
        try {
          const source = await command(
            [...args, "exec /usr/local/bin/container-use initialize"],
            JSON.stringify({ repository: lease.policy.repository, sourceSha: lease.source_sha }),
            initializing,
          )
          if (controlText(source).trim() !== lease.source_sha || keepalive.signal.aborted)
            throw new SandboxError({ message: "Sandbox source checkout unconfirmed" })
        } finally {
          clearInterval(timer)
          keepalive.abort()
          await pulse
        }
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
    const cleanup = Effect.fn("SandboxLease.cleanup")(function* (policy?: SandboxPolicy) {
      const retained = (yield* store.cleanupRuns()).filter(
        (row) => policy === undefined || JSON.stringify(row.policy) === JSON.stringify(policy),
      )
      let failed = false
      for (const row of retained) {
        const lease = yield* store.cleanupLease(row)
        if (
          lease !== null &&
          !["releasing", "released"].includes(lease.state) &&
          !isUnobservedRun(lease) &&
          (lease.actions_run_id === null ||
            (lease.actions_run_id === row.actions_run_id &&
              lease.actions_attempt === row.actions_attempt))
        )
          continue
        const result = yield* Effect.gen(function* () {
          const run = yield* github.savedRun(
            row.policy,
            row.lease_id,
            row.actions_run_id,
            row.actions_attempt,
          )
          yield* store.cleanupState(row, run.status === "completed" ? "terminated" : "pending")
          if (run.status !== "completed") yield* github.cancel(row.policy, row.actions_run_id)
        }).pipe(
          Effect.tapError(() =>
            store.cleanupState(row, "pending", "Sandbox run confirmation failed; retry required"),
          ),
          Effect.result,
        )
        if (result._tag === "Failure") failed = true
      }
      for (const row of retained) {
        const result = yield* store
          .finishCleanup(
            row,
            github.deleteRef(row.policy, row.lease_id),
            github.ensureRef(row.policy, row.lease_id, false),
          )
          .pipe(
            Effect.tapError(() =>
              store.cleanupState(
                row,
                "terminated",
                "Sandbox ref deletion unconfirmed; retry required",
              ),
            ),
            Effect.result,
          )
        if (result._tag === "Failure") failed = true
      }
      if (failed)
        return yield* Effect.fail(
          new SandboxError({ message: "Sandbox cleanup incomplete; retry required" }),
        )
    })
    const discover = (lease: Effect.Success<ReturnType<typeof required>>) =>
      github.runs(lease.policy, lease.lease_id).pipe(
        Effect.flatMap((runs) =>
          store.adoptAll(
            lease.policy,
            runs.map((run) => ({ leaseId: lease.lease_id, run })),
          ),
        ),
      )
    const inventory = Effect.fn("SandboxLease.inventory")(function* (policy: SandboxPolicy) {
      const owned = yield* github
        .inventory(policy)
        .pipe(Effect.tapError(() => store.inventoryError(policy)))
      yield* store.adoptAll(policy, owned)
    })
    const release = Effect.fn("SandboxLease.release")(function* (runId: string) {
      const lease = yield* required(runId)
      yield* store.beginRelease(runId)
      yield* Effect.gen(function* () {
        yield* cleanupUnobserved(lease)
        yield* inventory(lease.policy)
        yield* discover(lease)
        yield* cleanup(lease.policy)
        yield* store.clearPolicyErrors(lease.policy)
      }).pipe(Effect.tapError(() => store.recordError(runId)))
    })
    const cleanupUnobserved = (lease: Effect.Success<ReturnType<typeof required>>) =>
      store.reconcileUnobserved(
        lease.run_id,
        inventory(lease.policy).pipe(Effect.andThen(discover(lease))),
        github.deleteRef(lease.policy, lease.lease_id),
        github.ensureRef(lease.policy, lease.lease_id, false),
      )
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
      let completed = false
      yield* store.withAcquisition(
        runId,
        (create) => github.ensureRef(lease.policy, lease.lease_id, create),
        (commit) =>
          Effect.gen(function* () {
            const runs = yield* github.runs(lease.policy, lease.lease_id)
            yield* commit(
              store.adoptAll(
                lease.policy,
                runs.map((run) => ({ leaseId: lease.lease_id, run })),
              ),
            )
            if (runs.length > 1)
              return yield* Effect.fail(
                new SandboxError({ message: "Multiple Actions runs claimed the sandbox lease" }),
              )
            const run = runs[0]
            completed = run?.status === "completed"
            if (run !== undefined) {
              yield* commit(store.recordRun(runId, run.id, run.run_attempt))
              if (run.status !== "completed") {
                const ready = yield* github.readiness(
                  lease.policy,
                  lease.lease_id,
                  run.id,
                  run.run_attempt,
                )
                if (ready !== null) {
                  const transport = yield* connectPeer(lease, ready, controlRoot, command)
                  yield* commit(store.bind(runId, run.id, run.run_attempt, transport))
                }
              }
            }
          }),
      )
      if (completed) yield* release(runId)
      return yield* required(runId)
    })
    // Operator recovery for older records whose definitive POST rejection was
    // incorrectly persisted as uncertain. The status must come from its receipt;
    // a current GET 404 alone never establishes that the POST was rejected.
    const reconcileRejectedCreation = Effect.fn("SandboxLease.reconcileRejectedCreation")(
      function* (runId: string, status: number) {
        yield* Schema.decodeUnknownEffect(SandboxRefRejected.fields.status)(status)
        const lease = yield* required(runId)
        yield* store.reconcileRejectedCreation(
          runId,
          Effect.gen(function* () {
            yield* inventory(lease.policy)
            yield* discover(lease)
            const ref = yield* Effect.result(github.ensureRef(lease.policy, lease.lease_id, false))
            if (ref._tag !== "Failure" || !(ref.failure instanceof SandboxRefAbsent))
              return yield* Effect.fail(
                new SandboxError({ message: "Rejected ref absence unconfirmed" }),
              )
            if (
              (yield* store.cleanupRuns(true)).some(
                (row) =>
                  row.repository_id === lease.policy.repositoryId &&
                  row.lease_id === lease.lease_id,
              )
            )
              return yield* Effect.fail(
                new SandboxError({ message: "Rejected ref has observed Actions custody" }),
              )
          }),
        )
      },
    )
    const reconcile = Effect.fn("SandboxLease.reconcile")(function* (
      policies: ReadonlyArray<SandboxPolicy> = [],
    ) {
      const leases = yield* store.active()
      const saved = yield* store.cleanupRuns()
      const snapshots = new Map(
        [
          ...policies,
          ...leases.map((lease) => lease.policy),
          ...saved.map((row) => row.policy),
        ].map((policy) => [JSON.stringify(policy), policy] as const),
      )
      let failed = false
      for (const policy of snapshots.values()) {
        const selected = leases.filter(
          (lease) => JSON.stringify(lease.policy) === JSON.stringify(policy),
        )
        const result = yield* Effect.gen(function* () {
          yield* inventory(policy)
          for (const lease of selected) {
            // Shared sessions must cross their local cleanup barrier before runner release,
            // including after deadline expiry or a lost executor acknowledgement.
            if (
              lease.release_error === sessionCleanupUnconfirmed ||
              (lease.session_id !== null && lease.unit === null && lease.state !== "releasing")
            )
              continue
            if (lease.deadline <= Date.now() || isUnobservedRun(lease))
              yield* store.beginRelease(lease.run_id)
            if (
              lease.state === "releasing" ||
              lease.deadline <= Date.now() ||
              isUnobservedRun(lease)
            ) {
              yield* cleanupUnobserved(lease)
              yield* discover(lease)
            } else yield* acquire(lease.run_id)
          }
          yield* cleanup(policy)
          yield* store.clearPolicyErrors(policy)
        }).pipe(Effect.result)
        if (result._tag === "Failure") failed = true
      }
      if (failed)
        return yield* Effect.fail(
          new SandboxError({ message: "Sandbox policy reconciliation incomplete; retry required" }),
        )
    })
    const remote = (runId: string, operation: string, limit = 1048576) =>
      Effect.gen(function* () {
        const lease = yield* required(runId)
        if (lease.transport === null)
          return yield* Effect.fail(new SandboxError({ message: "Sandbox transport is not bound" }))
        return yield* Effect.tryPromise({
          try: (signal) =>
            command(
              [...sandboxSshArguments(lease.transport!).slice(0, -1), operation],
              "",
              signal,
              limit,
            ),
          catch: () => new SandboxError({ message: "Sandbox control operation failed" }),
        })
      })
    const heartbeat = (runId: string) =>
      remote(runId, "exec /usr/local/bin/container-use heartbeat").pipe(
        Effect.timeout("10 seconds"),
        Effect.andThen(store.heartbeat(runId, Date.now())),
      )
    // A fixed command executes only on the runner. Ref names and patch paths
    // remain remote; the returned bytes are never parsed as mint paths or code.
    const artifact = (runId: string) =>
      remote(
        runId,
        `exec docker exec workflowd-sandbox-tooling sh -c 'git for-each-ref --format="%(refname)" refs/remotes/container-use/ | while IFS= read -r ref; do git -c core.hooksPath=/dev/null diff --no-ext-diff --no-textconv --binary HEAD "$ref" -- || exit; done'`,
        8 * 1048576,
      )
    const revalidateReleased = Effect.fn("SandboxLease.revalidateReleased")(function* () {
      const saved = yield* store.cleanupRuns(true)
      const active = yield* store.active()
      if (
        active.some(
          (row) => row.state !== "releasing" || row.session_id !== null || row.unit !== null,
        )
      )
        return yield* Effect.fail(
          new SandboxError({
            message: "Custody revalidation requires inactive lease-only records",
          }),
        )
      for (const row of saved) {
        const lease = yield* store.cleanupLease(row)
        if (lease?.session_id != null || lease?.unit != null)
          return yield* Effect.fail(
            new SandboxError({
              message: "Session custody requires coordinator cleanup before revalidation",
            }),
          )
      }
      const policies = new Map(saved.map((row) => [JSON.stringify(row.policy), row.policy]))
      for (const policy of policies.values()) yield* store.reopenReleased(policy)
      yield* reconcile([...policies.values()])
    })
    return {
      acquire,
      release,
      reconcile,
      reconcileRejectedCreation,
      heartbeat,
      artifact,
      revalidateReleased,
    }
  })
