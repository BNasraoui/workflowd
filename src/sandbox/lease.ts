import { sandboxDiagnostic } from "./diagnostics"
import { saveSandboxFile } from "./binding"
import { SandboxCompletion, SandboxPolicy } from "./config"
import { makePublishStore, ResultMetadata } from "./publish-store"
import { AuditReceipt, drainToolAudit } from "./audit"
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Clock, Effect, Schema, Semaphore } from "effect"
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
import type { SavedSandboxPolicy } from "./saved-policy"
import { discoverJobPeer, exchangeJobProof, githubJobKeys, verifyJobProof } from "./bootstrap"
import { makeCapabilityStore, type CapabilityBinding } from "../capability-gateway/store"
import type { CapabilityGateway } from "../capability-gateway/service"
import type { makeCapabilityTransport } from "./capability-transport"
import { ownedPromise } from "../capability-gateway/owned"
import { makeNativeExecutionStore } from "./native-execution"
import { makeNativeResultStore } from "./native-result"
import { requireNativePublisherActivation, type PublisherContract } from "./publisher-contract"

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
  const started = Date.now()
  signal.throwIfAborted()
  const child = Bun.spawn([...args], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
  })
  const stop = () => {
    child.kill("SIGKILL")
  }
  signal.addEventListener("abort", stop, { once: true })
  const timer = setTimeout(stop, 300000)
  const stderr = (async () => {
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of child.stderr) {
      length += chunk.length
      if (length > 4096) {
        stop()
        break
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString("utf8")
  })()
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
    const status = await child.exited
    signal.throwIfAborted()
    if (status !== 0)
      throw new SandboxError({
        ...sandboxDiagnostic(
          "control.command",
          {
            name: "Error",
            message: (await stderr).trim(),
            exitCode: status,
          },
          started,
        ),
      })
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", stop)
    stop()
    await child.exited
    await stderr
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
  Effect.suspend(() => {
    const started = Date.now()
    let stage = "peer.status"
    return Effect.tryPromise({
      try: async (signal) => {
        const status: unknown = JSON.parse(
          controlText(await command(["/usr/bin/tailscale", "status", "--json"], "", signal)),
        )
        stage = "peer.binding"
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
          stage = "peer.heartbeat"
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
              (cause) => {
                keepalive.abort(
                  new SandboxError(sandboxDiagnostic("peer.keepalive", cause, started)),
                )
              },
            )
          }, 30000)
          try {
            stage = "peer.initialize"
            const source = await command(
              [...args, "exec /usr/local/bin/container-use initialize"],
              JSON.stringify({ repository: lease.policy.repository, sourceSha: lease.source_sha }),
              initializing,
            )
            initializing.throwIfAborted()
            if (controlText(source).trim() !== lease.source_sha)
              throw new SandboxError({ message: "Sandbox source checkout unconfirmed" })
          } finally {
            clearInterval(timer)
            keepalive.abort()
            await pulse
          }
          return transport
        } catch (error) {
          try {
            await rm(directory, { recursive: true, force: true })
          } catch (cleanupError) {
            throw new AggregateError([error], "Peer initialization and local cleanup failed", {
              cause: cleanupError,
            })
          }
          throw error
        }
      },
      catch: (cause) => new SandboxError(sandboxDiagnostic(stage, cause, started)),
    })
  })

export const makeSandboxLeaseService = (
  github: Github,
  controlRoot = join(homedir(), ".local/share/workflowd/sandboxes"),
  command = controlCommand,
  privateAccess?: {
    readonly publicationContract?: PublisherContract
    readonly native?: {
      readonly gateway: typeof CapabilityGateway.Service
      readonly transport: Effect.Success<ReturnType<typeof makeCapabilityTransport>>
    }
    readonly keys?: typeof githubJobKeys
    readonly sshArguments?: typeof sandboxSshArguments
  },
) =>
  Effect.gen(function* () {
    const store = yield* makeSandboxStore
    const bootstrapStore = yield* makeCapabilityStore
    const publications = yield* makePublishStore
    const native = yield* makeNativeExecutionStore
    const nativeResults = yield* makeNativeResultStore
    const cleanupGate = yield* Semaphore.make(1)
    const discoveryCursor = new Map<string, string>()
    const privatePeer = Effect.fn("SandboxLease.privatePeer")(function* (
      lease: NonNullable<Effect.Success<ReturnType<typeof store.read>>>,
      actionsRunId: number,
      attempt: number,
      handoff: (transport: SandboxTransport) => Effect.Effect<void, Error>,
    ) {
      const policy = lease.policy
      const bootstrap = policy.privateBootstrap
      if (!bootstrap || (bootstrap.mode === "actions-native" && !privateAccess?.native))
        return yield* Effect.fail(
          new SandboxError({ message: "Private bootstrap policy unavailable" }),
        )
      const peer = yield* Effect.tryPromise({
        try: async (signal) =>
          discoverJobPeer(
            JSON.parse(
              controlText(await command(["/usr/bin/tailscale", "status", "--json"], "", signal)),
            ),
            actionsRunId,
            attempt,
          ),
        catch: () => new SandboxError({ message: "Private peer discovery unavailable" }),
      })
      if (peer === null) return null
      return yield* Effect.acquireUseRelease(
        Effect.tryPromise(async () => {
          await mkdir(controlRoot, { recursive: true, mode: 0o700 })
          return { directory: await mkdtemp(join(controlRoot, "bootstrap-")), retained: false }
        }),
        (owned) =>
          Effect.gen(function* () {
            const { directory } = owned
            yield* ownedPromise(async (signal) => {
              signal.throwIfAborted()
              await writeFile(
                join(directory, "known_hosts"),
                peer.keys.map((key) => `${peer.address} ${key}\n`).join(""),
                { mode: 0o600 },
              )
              signal.throwIfAborted()
            })
            const transport: SandboxTransport = {
              leaseId: lease.lease_id,
              peerId: peer.peerId,
              address: peer.address,
              port: 22,
              repositoryPath: "/workspace/repository",
              knownHostsFile: join(directory, "known_hosts"),
              identityFile: "/dev/null",
            }
            let binding: CapabilityBinding | undefined
            const operation = Effect.gen(function* () {
              const challenge = yield* bootstrapStore.challenge(lease.run_id, transport, Date.now())
              const audience = `workflowd:${challenge.channel}:${challenge.nonce}`
              const keys = yield* Effect.tryPromise(privateAccess?.keys ?? githubJobKeys)
              yield* ownedPromise((signal) =>
                exchangeJobProof(
                  [
                    ...(privateAccess?.sshArguments ?? sandboxSshArguments)(transport).slice(0, -1),
                    "exec /usr/local/bin/runner-control bootstrap",
                  ],
                  { audience, peerId: peer.peerId },
                  async (value, signal) => {
                    const proof = Schema.decodeUnknownSync(
                      Schema.Struct({
                        token: Schema.String,
                        peerId: Schema.String,
                        agentImage: Schema.String,
                        workflowSha: Schema.String,
                      }),
                    )(value)
                    if (
                      proof.peerId !== peer.peerId ||
                      proof.agentImage !== policy.agentImage ||
                      proof.workflowSha !== policy.workflowSha
                    )
                      throw new Error("job proof refused")
                    const ref = `refs/heads/workflowd/leases/${lease.lease_id}`
                    const verified = verifyJobProof(
                      proof.token,
                      {
                        audience,
                        repository: policy.repository,
                        repositoryId: policy.repositoryId,
                        ownerId: bootstrap.repositoryOwnerId,
                        actorId: policy.appActorId,
                        ref,
                        workflowSha: policy.workflowSha,
                        toolingSha: policy.toolingSha ?? policy.workflowSha,
                        workflowRef: `${policy.repository}/.github/workflows/agent-sandbox-caller.yml@${ref}`,
                        jobWorkflowRef:
                          policy.toolingSha === undefined
                            ? `${policy.repository}/.github/workflows/agent-sandbox.yml@${ref}`
                            : `BNasraoui/workflowd/.github/workflows/agent-sandbox.yml@${policy.toolingSha}`,
                        runId: actionsRunId,
                        attempt,
                      },
                      keys,
                      Date.now(),
                    )
                    if (bootstrap.mode === "remote-tools") {
                      await Effect.runPromise(
                        bootstrapStore.acceptProof(challenge, verified.jti, Date.now()),
                        { signal },
                      )
                      return { mode: "remote-tools" }
                    }
                    if (!privateAccess?.native) throw new Error("gateway unavailable")
                    const grant = await Effect.runPromise(
                      privateAccess.native.gateway.bind(challenge, verified.jti),
                      { signal },
                    )
                    binding = grant.binding
                    return {
                      mode: "actions-native",
                      token: grant.token,
                      expiresAt: grant.expiresAt,
                      renewAt: grant.renewAt,
                      deadline: lease.deadline,
                    }
                  },
                  signal,
                ),
              )
              if (bootstrap.mode === "remote-tools") {
                yield* Effect.tryPromise(() => rm(directory, { recursive: true, force: true }))
                const connected = yield* connectPeer(lease, peer, controlRoot, command)
                yield* handoff(connected)
                return connected
              }
              if (!binding || !privateAccess?.native)
                return yield* Effect.fail(new Error("gateway unavailable"))
              yield* privateAccess.native.transport.connect(binding, transport, () =>
                rm(directory, { recursive: true, force: true }),
              )
              yield* handoff(transport)
              return transport
            })
            const connected = yield* operation.pipe(
              Effect.onError(() =>
                Effect.gen(function* () {
                  if (binding && privateAccess?.native) {
                    yield* privateAccess.native.gateway
                      .revoke(lease.run_id)
                      .pipe(
                        Effect.ensuring(
                          privateAccess.native.transport
                            .disconnect(lease.run_id)
                            .pipe(Effect.orDie),
                        ),
                      )
                  }
                }).pipe(Effect.orDie),
              ),
            )
            owned.retained = true
            return connected
          }),
        (owned) =>
          owned.retained
            ? Effect.void
            : Effect.tryPromise(() => rm(owned.directory, { recursive: true, force: true })).pipe(
                Effect.orDie,
              ),
      )
    })
    const required = Effect.fn("SandboxLease.required")(function* (runId: string) {
      const lease = yield* store.read(runId)
      if (lease === null)
        return yield* Effect.fail(
          new SandboxError({ message: "Sandbox intent must exist before acquisition" }),
        )
      return lease
    })
    const cleanup = Effect.fn("SandboxLease.cleanup")(
      function* (policy: SavedSandboxPolicy) {
        const retained = (yield* store.cleanupRuns())
          .filter((row) => JSON.stringify(row.policy) === JSON.stringify(policy))
          .sort((a, b) => a.updated_at - b.updated_at)
        const checked: typeof retained = []
        let failed: unknown = undefined
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
          // One serial, bounded batch per repository; oldest attempted custody first.
          if (policy?.privateBootstrap?.mode === "actions-native" && checked.length >= 8) break
          if (checked.length && policy?.privateBootstrap?.mode === "actions-native")
            yield* Effect.sleep("250 millis")
          checked.push(row)
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
            Effect.tapError((cause) =>
              store.cleanupState(
                row,
                "pending",
                sandboxDiagnostic("lease.confirmRun", cause).message,
              ),
            ),
            Effect.result,
          )
          if (result._tag === "Failure") failed ??= result.failure
          // Advance each confirmed run before the shared pass deadline can interrupt us.
          const finished = yield* store
            .finishCleanup(
              row,
              github.deleteRef(row.policy, row.lease_id),
              github.ensureRef(row.policy, row.lease_id, false),
            )
            .pipe(
              Effect.tapError((cause) =>
                store.cleanupState(
                  row,
                  "terminated",
                  sandboxDiagnostic("lease.deleteRef", cause).message,
                ),
              ),
              Effect.result,
            )
          if (finished._tag === "Failure") failed ??= finished.failure
        }
        if (failed !== undefined)
          return yield* Effect.fail(new SandboxError(sandboxDiagnostic("lease.cleanup", failed)))
      },
      (effect, policy: SavedSandboxPolicy) =>
        policy.privateBootstrap?.mode === "actions-native"
          ? cleanupGate
              .withPermits(1)(effect)
              .pipe(
                Effect.timeout("60 seconds"),
                Effect.mapError(
                  (cause) => new SandboxError(sandboxDiagnostic("lease.cleanup", cause)),
                ),
              )
          : effect,
    )
    const discover = (lease: Effect.Success<ReturnType<typeof required>>) =>
      github.runs(lease.policy, lease.lease_id).pipe(
        Effect.flatMap((runs) =>
          store.adoptAll(
            lease.policy,
            runs.map((run) => ({ leaseId: lease.lease_id, run })),
          ),
        ),
      )
    const inventoryNow = Effect.fn("SandboxLease.inventoryNow")(function* (
      policy: SavedSandboxPolicy,
    ) {
      const owned = yield* github
        .inventory(policy)
        .pipe(Effect.tapError((cause) => store.inventoryError(policy, cause)))
      yield* store.adoptAll(policy, owned)
    })
    const inventoryGate = yield* Semaphore.make(1)
    const inventories = new Map<
      number,
      {
        policy: string
        after: number
        result: ReturnType<typeof inventoryNow>
        waiting: Map<string, SavedSandboxPolicy>
      }
    >()
    const inventory = Effect.fn("SandboxLease.inventory")(
      function* (policy: SavedSandboxPolicy) {
        if (policy.privateBootstrap?.mode !== "actions-native") return yield* inventoryNow(policy)
        const now = yield* Clock.currentTimeMillis
        const key = JSON.stringify([
          policy.repository,
          policy.repositoryId,
          policy.installationId,
          policy.workflowSha,
          policy.appActorId,
          policy.toolingSha,
        ])
        const previous = inventories.get(policy.repositoryId)
        const waiting = previous?.waiting ?? new Map<string, SavedSandboxPolicy>()
        waiting.set(key, policy)
        const uncertain = Effect.fail(
          new SandboxError({ message: "Sandbox inventory unconfirmed; retry required" }),
        )
        if (previous && now < previous.after)
          return yield* previous.policy === key ? previous.result : uncertain
        // Serve the oldest waiting identity, even when today's configured policy calls first.
        // Keeping the saved policy here also avoids stalling behind a caller that disappears.
        const [selected, saved] = waiting.entries().next().value!
        waiting.delete(selected)
        // Cache failures too. An interrupted attempt never becomes evidence of absence.
        const entry = {
          policy: selected,
          after: now + 60000,
          result: uncertain as ReturnType<typeof inventoryNow>,
          waiting,
        }
        inventories.set(policy.repositoryId, entry)
        entry.result = Effect.fromResult(yield* inventoryNow(saved).pipe(Effect.result))
        return yield* selected === key ? entry.result : uncertain
      },
      (effect) => inventoryGate.withPermits(1)(effect),
    )
    const release = Effect.fn("SandboxLease.release")(function* (runId: string) {
      const lease = yield* required(runId)
      if (lease.policy.privateBootstrap?.mode === "actions-native" && privateAccess?.native) {
        yield* privateAccess.native.gateway.revoke(runId).pipe(
          Effect.ensuring(privateAccess.native.transport.disconnect(runId).pipe(Effect.orDie)),
          Effect.tapError((cause) => store.recordError(runId, cause)),
        )
      }
      yield* store.beginRelease(runId)
      const discovery = yield* Effect.gen(function* () {
        yield* cleanupUnobserved(lease)
        yield* inventory(lease.policy)
        yield* discover(lease)
      }).pipe(Effect.result)
      // A failed inventory is uncertainty, not permission to abandon known IDs.
      const cleaned = yield* cleanup(lease.policy).pipe(Effect.result)
      for (const result of [discovery, cleaned])
        if (result._tag === "Failure") {
          yield* store.recordError(runId, result.failure)
          return yield* Effect.fail(result.failure)
        }
      yield* store.clearPolicyErrors(lease.policy)
      return yield* Effect.void
    })
    const cleanupUnobserved = (lease: Effect.Success<ReturnType<typeof required>>) =>
      store.reconcileUnobserved(
        lease.run_id,
        lease.policy.privateBootstrap?.mode === "actions-native"
          ? discover(lease)
          : inventory(lease.policy).pipe(Effect.andThen(discover(lease))),
        github.deleteRef(lease.policy, lease.lease_id),
        github.ensureRef(lease.policy, lease.lease_id, false),
      )
    const acquire = Effect.fn("SandboxLease.acquire")(function* (runId: string) {
      let lease = yield* required(runId)
      yield* Schema.decodeUnknownEffect(SandboxPolicy)(lease.policy)
      yield* requireNativePublisherActivation(lease.policy, privateAccess?.publicationContract)
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
                if (lease.policy.privateBootstrap !== undefined) {
                  yield* privatePeer(lease, run.id, run.run_attempt, (transport) =>
                    commit(store.bind(runId, run.id, run.run_attempt, transport)),
                  )
                  return
                }
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
      policies: ReadonlyArray<SavedSandboxPolicy> = [],
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
      let failed: unknown = undefined
      for (const key of discoveryCursor.keys()) if (!snapshots.has(key)) discoveryCursor.delete(key)
      for (const [key, policy] of snapshots) {
        const selected = leases.filter(
          (lease) => JSON.stringify(lease.policy) === JSON.stringify(policy),
        )
        const nativePolicy = policy.privateBootstrap?.mode === "actions-native"
        const offset = nativePolicy
          ? selected.findIndex((lease) => lease.run_id === discoveryCursor.get(key)) + 1
          : 0
        const ordered = [...selected.slice(offset), ...selected.slice(0, offset)]
        const result = yield* Effect.gen(function* () {
          yield* inventory(policy)
          let pending = 0
          for (const lease of ordered) {
            // Shared sessions must cross their local cleanup barrier before runner release,
            // including after deadline expiry or a lost executor acknowledgement.
            if (
              lease.release_error === sessionCleanupUnconfirmed ||
              (lease.session_id !== null && lease.unit === null && lease.state !== "releasing")
            )
              continue
            if (lease.policy.publish !== undefined && lease.state !== "releasing") {
              const intent = yield* publications.read(lease.run_id)
              // Approval may have succeeded before its acknowledgement was persisted.
              // Keep the owned run alive through publication's separate bounded deadline.
              if (
                intent !== null &&
                ["approving", "approved"].includes(intent.phase) &&
                intent.actions_run_id === lease.actions_run_id &&
                intent.attempt === lease.actions_attempt &&
                intent.metadata.sourceSha === lease.source_sha &&
                intent.base_ref === lease.policy.publish.baseRef &&
                intent.deadline > Date.now()
              )
                continue
            }
            if (lease.deadline <= Date.now() || isUnobservedRun(lease))
              yield* store.beginRelease(lease.run_id)
            if (
              lease.state === "releasing" ||
              lease.deadline <= Date.now() ||
              isUnobservedRun(lease)
            ) {
              if (nativePolicy && pending++ >= 8) continue
              if (nativePolicy) discoveryCursor.set(key, lease.run_id)
              yield* cleanupUnobserved(lease)
              if (
                policy.privateBootstrap?.mode !== "actions-native" ||
                lease.actions_run_id === null
              )
                yield* discover(lease)
            } else yield* acquire(lease.run_id)
          }
        }).pipe(
          (effect) => (nativePolicy ? effect.pipe(Effect.timeout("60 seconds")) : effect),
          Effect.result,
        )
        const cleaned = yield* cleanup(policy).pipe(Effect.result)
        if (result._tag === "Success" && cleaned._tag === "Success")
          yield* store.clearPolicyErrors(policy)
        if (result._tag === "Failure") failed ??= result.failure
        if (cleaned._tag === "Failure") failed ??= cleaned.failure
      }
      if (failed !== undefined)
        return yield* Effect.fail(new SandboxError(sandboxDiagnostic("lease.reconcile", failed)))
    })
    const remote = (runId: string, operation: string, limit = 1048576, input = "") =>
      Effect.gen(function* () {
        const lease = yield* required(runId)
        if (lease.transport === null)
          return yield* Effect.fail(new SandboxError({ message: "Sandbox transport is not bound" }))
        return yield* Effect.tryPromise({
          try: (signal) =>
            command(
              [...sandboxSshArguments(lease.transport!).slice(0, -1), operation],
              input,
              signal,
              limit,
            ),
          catch: (cause) => new SandboxError(sandboxDiagnostic("control.remote", cause)),
        })
      })
    const heartbeat = (runId: string) =>
      Effect.gen(function* () {
        if ((yield* required(runId)).policy.privateBootstrap?.mode === "actions-native") return
        yield* remote(runId, "exec /usr/local/bin/container-use heartbeat").pipe(
          Effect.timeout("10 seconds"),
          Effect.andThen(store.heartbeat(runId, Date.now())),
        )
      })
    const initializeNative = Effect.fn("SandboxLease.initializeNative")(function* (runId: string) {
      const lease = yield* required(runId)
      if (lease.policy.privateBootstrap?.mode !== "actions-native" || lease.state !== "ready")
        return yield* Effect.fail(new SandboxError({ message: "Native source custody refused" }))
      const source = yield* remote(
        runId,
        "exec /usr/local/bin/runner-control native-initialize",
        4096,
        JSON.stringify({ repository: lease.policy.repository, sourceSha: lease.source_sha }),
      )
      if (controlText(source).trim() !== lease.source_sha)
        return yield* Effect.fail(new SandboxError({ message: "Native source mismatch" }))
    })
    const stopNative = Effect.fn("SandboxLease.stopNative")(function* (runId: string) {
      const invocation = yield* native.read(runId)
      if (invocation === null || invocation.state === "stopped") return
      const marked = yield* native.uncertain(runId).pipe(Effect.exit)
      const stopped = yield* Effect.gen(function* () {
        const raw = yield* remote(runId, "exec /usr/local/bin/runner-control native-stop", 4096)
        yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              nonce: Schema.Literal(invocation.nonce),
              session: Schema.Literal(invocation.session_id),
              stopped: Schema.Literal(true),
            }),
          ),
        )(controlText(raw), { onExcessProperty: "error" })
      }).pipe(Effect.exit)
      if (marked._tag === "Failure" || stopped._tag === "Failure")
        return yield* Effect.fail(
          new SandboxError({
            ...sandboxDiagnostic(
              "native.stop",
              new AggregateError(
                [marked, stopped],
                "Native cleanup or durable revocation unconfirmed",
              ),
            ),
            uncertain: true,
          }),
        )
      yield* native.closed(runId, invocation.nonce, "cancelled", null)
    })
    const finishResult = (runId: string, completion: string) =>
      Effect.gen(function* () {
        const lease = yield* required(runId)
        const invocation =
          lease.policy.privateBootstrap?.mode === "actions-native"
            ? yield* native.read(runId)
            : null
        const candidate = invocation === null ? null : yield* nativeResults.read(runId)
        if (
          lease.policy.privateBootstrap?.mode === "actions-native" &&
          (!invocation ||
            invocation.state !== "stopped" ||
            invocation.outcome !== "completed" ||
            !candidate?.frozen ||
            candidate.channel !== invocation.channel)
        )
          return yield* Effect.fail(new SandboxError({ message: "Native result custody refused" }))
        const json = completion.trim().replace(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/, "$1")
        const selected =
          candidate?.completion ??
          (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SandboxCompletion))(json, {
            onExcessProperty: "error",
          }).pipe(
            Effect.mapError(
              (cause) => new SandboxError(sandboxDiagnostic("result.completion", cause)),
            ),
          ))
        const response = yield* remote(
          runId,
          invocation === null
            ? "exec /usr/local/bin/runner-control finish-result"
            : "exec /usr/local/bin/runner-control native-result",
          262144,
          JSON.stringify(
            invocation === null
              ? selected
              : { nonce: invocation.nonce, session: invocation.session_id, completion: selected },
          ),
        )
        const value: unknown = yield* Effect.try((): unknown => JSON.parse(controlText(response)))
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Union([
            ResultMetadata,
            Schema.Struct({ empty: Schema.Literal(true), sourceSha: Schema.String }),
          ]),
        )(value)
        if (
          result.sourceSha !== lease.source_sha ||
          ("branch" in result &&
            (result.branch !== selected.branch ||
              result.title !== selected.title ||
              result.commitMessage !== selected.commitMessage ||
              result.body !== selected.body))
        )
          return yield* Effect.fail(new SandboxError({ message: "Sandbox result source mismatch" }))
        return result
      })
    const finish = (runId: string) =>
      remote(runId, "exec /usr/local/bin/runner-control finish", 4096).pipe(Effect.asVoid)
    const audit = (runId: string, directory: string) =>
      Effect.gen(function* () {
        const lease = yield* required(runId)
        if (lease.policy.privateBootstrap?.mode === "actions-native") {
          const invocation = yield* native.read(runId)
          if (invocation === null || invocation.state !== "stopped")
            return yield* Effect.fail(
              new SandboxError({ message: "Native audit custody unconfirmed" }),
            )
          const raw = yield* remote(
            runId,
            "exec /usr/local/bin/runner-control native-evidence",
            2 * 1048576,
          )
          const evidence = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                nonce: Schema.Literal(invocation.nonce),
                session: Schema.Literal(invocation.session_id),
                pty: Schema.String.check(
                  Schema.isMaxLength(1398104),
                  Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
                ),
              }),
            ),
          )(controlText(raw), { onExcessProperty: "error" })
          yield* Effect.tryPromise(async () => {
            await mkdir(`${directory}.sandbox`, { recursive: true, mode: 0o700 })
            await saveSandboxFile(
              `${directory}.sandbox`,
              "native-evidence.json",
              JSON.stringify(evidence),
            )
          })
          return
        }
        const transport = lease.transport
        if (transport === null)
          return yield* Effect.fail(
            new SandboxError({ message: "Sandbox audit transport missing" }),
          )
        const started = Date.now()
        yield* Effect.tryPromise({
          try: (signal) =>
            drainToolAudit(directory, async (records) => {
              const result = await command(
                [
                  ...sandboxSshArguments(transport).slice(0, -1),
                  "exec /usr/local/bin/runner-control audit",
                ],
                JSON.stringify(records),
                AbortSignal.any([signal, AbortSignal.timeout(15000)]),
                4096,
              )
              return Schema.decodeUnknownSync(AuditReceipt)(JSON.parse(controlText(result)))
            }),
          catch: (cause) => new SandboxError(sandboxDiagnostic("audit.transport", cause, started)),
        }).pipe(
          Effect.timeout("30 seconds"),
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const diagnostic = sandboxDiagnostic("audit.drain", cause, started)
              const evidence = {
                ...diagnostic.evidence,
                failedAt: new Date().toISOString(),
                error: diagnostic.message,
              }
              const message = `Sandbox audit drain unconfirmed after ${evidence.elapsedMs}ms: ${diagnostic.message}`
              yield* Effect.tryPromise({
                try: () =>
                  saveSandboxFile(
                    `${directory}.sandbox`,
                    "audit-failure.json",
                    JSON.stringify(evidence),
                  ),
                catch: (receiptCause) =>
                  new SandboxError(
                    sandboxDiagnostic(
                      "audit.receipt",
                      new AggregateError(
                        [cause, receiptCause],
                        "Audit drain and failure receipt failed",
                      ),
                      started,
                    ),
                  ),
              })
              return yield* Effect.fail(new SandboxError({ message, evidence }))
            }),
          ),
        )
      })
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
      finishResult,
      initializeNative,
      stopNative,
      finish,
      audit,
      revalidateReleased,
    }
  })
