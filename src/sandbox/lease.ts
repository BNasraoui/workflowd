import { sandboxDiagnostic } from "./diagnostics"
import { saveSandboxFile } from "./binding"
import { SandboxCompletion } from "./config"
import { makePublishStore, ResultMetadata } from "./publish-store"
import { AuditReceipt, drainToolAudit } from "./audit"
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
) =>
  Effect.gen(function* () {
    const store = yield* makeSandboxStore
    const publications = yield* makePublishStore
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
      }
      for (const row of retained) {
        const result = yield* store
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
        if (result._tag === "Failure") failed ??= result.failure
      }
      if (failed !== undefined)
        return yield* Effect.fail(new SandboxError(sandboxDiagnostic("lease.cleanup", failed)))
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
        .pipe(Effect.tapError((cause) => store.inventoryError(policy, cause)))
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
      }).pipe(Effect.tapError((cause) => store.recordError(runId, cause)))
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
      let failed: unknown = undefined
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
              yield* cleanupUnobserved(lease)
              yield* discover(lease)
            } else yield* acquire(lease.run_id)
          }
          yield* cleanup(policy)
          yield* store.clearPolicyErrors(policy)
        }).pipe(Effect.result)
        if (result._tag === "Failure") failed ??= result.failure
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
      remote(runId, "exec /usr/local/bin/container-use heartbeat").pipe(
        Effect.timeout("10 seconds"),
        Effect.andThen(store.heartbeat(runId, Date.now())),
      )
    const finishResult = (runId: string, completion: string) =>
      Effect.gen(function* () {
        const lease = yield* required(runId)
        const json = completion.trim().replace(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/, "$1")
        const selected = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(SandboxCompletion),
        )(json, { onExcessProperty: "error" }).pipe(
          Effect.mapError(
            (cause) => new SandboxError(sandboxDiagnostic("result.completion", cause)),
          ),
        )
        const response = yield* remote(
          runId,
          "exec /usr/local/bin/runner-control finish-result",
          65536,
          JSON.stringify(selected),
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
              result.commitMessage !== selected.commitMessage))
        )
          return yield* Effect.fail(new SandboxError({ message: "Sandbox result source mismatch" }))
        return result
      })
    const finish = (runId: string) =>
      remote(runId, "exec /usr/local/bin/runner-control finish", 4096).pipe(Effect.asVoid)
    const audit = (runId: string, directory: string) =>
      Effect.gen(function* () {
        const lease = yield* required(runId)
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
      finish,
      audit,
      revalidateReleased,
    }
  })
