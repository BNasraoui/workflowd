import { Context, Effect, Schedule, Schema } from "effect"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AgentRunStore, type AgentRunRecord } from "../kernel/agent-run-store"
import type { OpenCodeModel, OpenCodeAdapter } from "../opencode/adapter"
import { makeSandboxStore, SandboxError, isUnobservedRun } from "./store"
import type { SandboxPolicy } from "./config"
import type { makeSandboxGithub } from "./github"
import type { makeSandboxLeaseService } from "./lease"
import { Session, type OpenCodeClient } from "@opencode-ai/client/effect"
import type { AgentRunProviderPort } from "../kernel/agent-run-ingress"
import { OpenCodeAdapterError } from "../opencode/adapter"
import {
  saveSandboxFile,
  bindingDirectory,
  sandboxBridgeName,
  readSandboxBinding,
  writeSandboxBinding,
  sandboxPolicyHash,
  transportHash,
} from "./binding"
import { readSandboxEndpoint, makeSandboxOpenCode, stopSandboxOpenCode } from "./opencode"
import type { CliPort } from "../kernel/cli-process-contract"
import { compileSandboxBridge } from "./bridge"

export type SandboxDispatchPort = {
  readonly prepareNative?: (run: AgentRunRecord) => Effect.Effect<
    {
      readonly cli: CliPort
      readonly sandboxBindingFile: string
    },
    SandboxError
  >
  readonly finishNative?: (
    run: AgentRunRecord,
    terminal: {
      readonly state: "completed" | "operator_required"
      readonly finalMessage: string | null
      readonly diagnostic: string
    },
  ) => Effect.Effect<void, SandboxError>
  readonly launch: (
    run: AgentRunRecord,
    model: OpenCodeModel,
  ) => Effect.Effect<
    {
      readonly nativeSessionId: string
    },
    SandboxError
  >
  readonly cancel: (run: AgentRunRecord) => Effect.Effect<void, SandboxError>
  readonly observe: (run: AgentRunRecord) => Effect.Effect<void, SandboxError>
  readonly owns: (runId: string) => Effect.Effect<boolean, SandboxError>
  readonly provider: (sessionId: string) => Effect.Effect<AgentRunProviderPort, SandboxError>
  readonly heartbeat: Effect.Effect<void, SandboxError>
  readonly iteration: Effect.Effect<void, SandboxError>
}

export const SandboxDispatch = Context.Service<SandboxDispatchPort>("workflowd/SandboxDispatch")

const failure = () =>
  new SandboxError({ message: "Sandbox custody operation failed; reconciliation required" })
const Terminal = Schema.Struct({
  state: Schema.Literals(["completed", "cancelled", "failed", "operator_required"]),
  sessionId: Schema.NullOr(Schema.String),
  finalMessage: Schema.NullOr(Schema.String),
  diagnostic: Schema.String,
})

export const makeSandboxDispatch = (options: {
  readonly policies: ReadonlyArray<SandboxPolicy>
  readonly github: Effect.Success<ReturnType<typeof makeSandboxGithub>>
  readonly leases: Effect.Success<ReturnType<typeof makeSandboxLeaseService>>
  readonly executor: OpenCodeAdapter
  readonly client: OpenCodeClient
  readonly executorId: string
  readonly endpointIdentity: string
  readonly nativeExecutors?: Partial<Record<"codex" | "claude", CliPort>>
}) =>
  Effect.gen(function* () {
    const store = yield* makeSandboxStore
    const runs = yield* AgentRunStore
    const { github, leases } = options
    const cancelling = new Set<string>()
    const executor = makeSandboxOpenCode(options.client, options.executor)
    const nativeCli = (run: AgentRunRecord) => {
      const kind = run.executorKind
      const cli =
        kind === "codex" || kind === "claude" ? options.nativeExecutors?.[kind] : undefined
      if (cli?.ownership !== "transient-exec" || cli.executionId === undefined) throw failure()
      return cli
    }
    const nativeEndpoint = (run: AgentRunRecord) =>
      `${run.executorKind}-cli://${run.resolvedSelection?.host ?? "local"}`
    const bindingFor = Effect.fn("SandboxDispatch.binding")(function* (sessionId: string) {
      const lease = yield* store.bySession(sessionId)
      if (lease === null || lease.state !== "ready" || lease.transport === null)
        return yield* Effect.fail(failure())
      const run = yield* runs.read(lease.run_id)
      if (run === null || run.agent !== "sandbox") return yield* Effect.fail(failure())
      const binding = yield* Effect.tryPromise(() => readSandboxBinding(run.directory))
      if (
        binding.runId !== run.runId ||
        binding.leaseId !== lease.lease_id ||
        binding.sessionId !== sessionId ||
        binding.repositoryId !== lease.policy.repositoryId ||
        binding.sourceSha !== lease.source_sha ||
        binding.executorId !== options.executorId ||
        binding.endpointIdentity !== options.endpointIdentity ||
        binding.transportHash !== transportHash(lease.transport) ||
        binding.deadline !== lease.deadline
      )
        return yield* Effect.fail(failure())
      yield* executor.check(binding)
      return binding
    })
    const provider = (sessionId: string) =>
      Effect.gen(function* () {
        yield* bindingFor(sessionId)
        const guard = <A, E>(
          input: { sessionID: string; directory?: string; agent?: string },
          effect: Effect.Effect<A, E>,
        ) =>
          Effect.gen(function* () {
            const binding = yield* bindingFor(sessionId)
            if (
              input.sessionID !== sessionId ||
              (input.directory !== undefined && input.directory !== binding.directory) ||
              (input.agent !== undefined && input.agent !== "sandbox")
            )
              return yield* Effect.fail(failure())
            return yield* effect
          }).pipe(
            Effect.mapError(
              (cause) => new OpenCodeAdapterError({ operation: "guard sandbox session", cause }),
            ),
          )
        return {
          createSession: () =>
            Effect.fail(
              new OpenCodeAdapterError({
                operation: "create sandbox session",
                cause: new Error("Session already reserved"),
              }),
            ),
          listModels: options.executor.listModels,
          listProviders: options.executor.listProviders,
          promptSession: (input) => guard(input, options.executor.promptSession(input)),
          abortSession: (input) => guard(input, options.executor.abortSession(input)),
          sessionTelemetry: (input) => guard(input, options.executor.sessionTelemetry(input)),
        } satisfies AgentRunProviderPort
      }).pipe(Effect.mapError(failure))
    const stop = (run: AgentRunRecord) =>
      Effect.gen(function* () {
        const lease = yield* store.read(run.runId)
        if (lease === null) return
        if (run.executorKind === "codex" || run.executorKind === "claude") {
          const cli = yield* Effect.try(() => nativeCli(run))
          if (
            yield* Effect.tryPromise(() =>
              Bun.file(join(bindingDirectory(run.directory), "binding.json")).exists(),
            )
          ) {
            const binding = yield* Effect.tryPromise(() => readSandboxBinding(run.directory))
            if (
              binding.runId !== run.runId ||
              binding.leaseId !== lease.lease_id ||
              binding.sessionId !== cli.executionId!(run.runId) ||
              (lease.session_id !== null && lease.session_id !== binding.sessionId) ||
              binding.executorId !== `${run.executorKind}:local` ||
              binding.endpointIdentity !== nativeEndpoint(run) ||
              binding.repositoryId !== lease.policy.repositoryId ||
              binding.sourceSha !== lease.source_sha ||
              binding.policyHash !== sandboxPolicyHash ||
              lease.transport === null ||
              binding.transportHash !== transportHash(lease.transport) ||
              binding.deadline !== lease.deadline
            )
              return yield* Effect.fail(failure())
            yield* Effect.tryPromise(() => writeSandboxBinding({ ...binding, state: "revoked" }))
          }
          const process = yield* cli.attach({ runId: run.runId })
          if (process !== null) {
            yield* process.cancel
            yield* process.exited
          }
          return
        }
        if (
          yield* Effect.tryPromise(() =>
            Bun.file(join(bindingDirectory(run.directory), "binding.json")).exists(),
          )
        ) {
          const binding = yield* Effect.tryPromise(() => readSandboxBinding(run.directory))
          if (
            binding.runId !== run.runId ||
            binding.leaseId !== lease.lease_id ||
            (binding.sessionId !== lease.session_id &&
              !(lease.session_id === null && binding.state === "reserved")) ||
            binding.endpointIdentity !== options.endpointIdentity ||
            binding.executorId !== options.executorId
          )
            return yield* Effect.fail(failure())
          yield* executor.stop(binding)
          return
        }
        const { unit, invocation } = lease
        if (unit !== null && invocation !== null) {
          yield* Effect.tryPromise(() => stopSandboxOpenCode({ unit, invocationId: invocation }))
          return
        }
        const exists = yield* Effect.tryPromise(() =>
          Bun.file(join(run.directory, "endpoint.json")).exists(),
        )
        if (!exists) {
          if (lease.unit !== null || lease.session_id !== null) return yield* Effect.fail(failure())
          return
        }
        const endpoint = yield* Effect.tryPromise(() => readSandboxEndpoint(run.directory))
        if (
          endpoint.unit !== `workflowd-sandbox-${lease.lease_id}` ||
          (lease.invocation !== null && endpoint.invocationId !== lease.invocation)
        )
          return yield* Effect.fail(failure())
        yield* Effect.tryPromise(() => stopSandboxOpenCode(endpoint))
      }).pipe(
        Effect.tap(() => store.sessionCleanupConfirmed(run.runId)),
        Effect.tapError(() => store.sessionCleanupError(run.runId)),
      )
    const publish = (run: AgentRunRecord) =>
      Effect.gen(function* () {
        const lease = yield* store.read(run.runId)
        const unobserved = lease?.state === "operator_required" && isUnobservedRun(lease)
        if (lease !== null && lease.state !== "released" && !unobserved) return
        yield* stop(run)
        const terminal = yield* Effect.tryPromise(async () =>
          Schema.decodeUnknownSync(Terminal)(
            await Bun.file(join(run.directory, "terminal.json")).json(),
          ),
        )
        const current = yield* runs.read(run.runId)
        if (
          current === null ||
          ["completed", "cancelled", "failed", "operator_required"].includes(current.state)
        )
          return
        if (terminal.sessionId !== current.nativeSessionId) return yield* Effect.fail(failure())
        const now = new Date()
        if (unobserved)
          yield* runs.operatorRequired({ runId: run.runId, diagnostic: lease.release_error!, now })
        else if (terminal.state === "completed")
          yield* runs.complete({ runId: run.runId, finalMessage: terminal.finalMessage, now })
        else if (terminal.state === "cancelled")
          yield* runs.cancel({ runId: run.runId, diagnostic: terminal.diagnostic, now })
        else if (terminal.state === "failed")
          yield* runs.fail({ runId: run.runId, diagnostic: terminal.diagnostic, now })
        else
          yield* runs.operatorRequired({
            runId: run.runId,
            finalMessage: terminal.finalMessage,
            diagnostic: terminal.diagnostic,
            now,
          })
      })
    const settle = (run: AgentRunRecord, terminal: typeof Terminal.Type) =>
      Effect.gen(function* () {
        const lease = yield* store.read(run.runId)
        const current = yield* runs.read(run.runId)
        if (current === null || current.nativeSessionId !== run.nativeSessionId)
          return yield* Effect.fail(failure())
        yield* stop(run)
        const pending = yield* Effect.tryPromise(() =>
          Bun.file(join(run.directory, "terminal.json")).exists(),
        )
        if (!pending) {
          yield* Effect.tryPromise(() => mkdir(run.directory, { recursive: true, mode: 0o700 }))
          let result = terminal
          if (
            terminal.state === "operator_required" &&
            lease?.state === "released" &&
            lease.actions_run_id === null
          )
            result = { ...terminal, state: "failed", diagnostic: "Sandbox ref creation rejected" }
          if (lease?.transport != null && lease.state !== "released") {
            const patch = yield* Effect.result(leases.artifact(run.runId))
            if (patch._tag === "Success")
              yield* Effect.tryPromise(() =>
                saveSandboxFile(run.directory, "result.patch", patch.success),
              )
            else
              result = {
                ...terminal,
                state: "operator_required",
                diagnostic: "Sandbox artifact capture failed",
              }
          }
          const message =
            result.finalMessage === null
              ? null
              : Buffer.from(result.finalMessage).subarray(0, 1048573).toString("utf8")
          yield* Effect.tryPromise(() => saveSandboxFile(run.directory, "final.txt", message ?? ""))
          yield* Effect.tryPromise(() =>
            saveSandboxFile(
              run.directory,
              "terminal.json",
              JSON.stringify({ ...result, finalMessage: message }),
              true,
            ),
          )
        }
        yield* stop(run)
        if (lease !== null) yield* leases.release(run.runId)
        yield* publish(run)
      }).pipe(
        Effect.onError(() =>
          stop(run).pipe(
            Effect.andThen(leases.release(run.runId).pipe(Effect.ignore)),
            Effect.ignore,
          ),
        ),
        Effect.tapError(() => store.recordError(run.runId)),
        Effect.mapError(failure),
      )
    const cancel = (run: AgentRunRecord) =>
      Effect.suspend(() => {
        cancelling.add(run.runId)
        return settle(run, {
          state: "cancelled",
          sessionId: run.nativeSessionId,
          finalMessage: null,
          diagnostic: "Sandbox cancellation requested",
        }).pipe(Effect.ensuring(Effect.sync(() => cancelling.delete(run.runId))))
      })
    const finishNative: NonNullable<SandboxDispatchPort["finishNative"]> = (run, terminal) =>
      Effect.gen(function* () {
        // Stopping a CLI also wakes its exit observer. The cancellation caller owns
        // settlement until its terminal record is saved or custody reports failure.
        if (cancelling.has(run.runId)) return
        const current = yield* runs.read(run.runId)
        if (current === null) return yield* Effect.fail(failure())
        yield* settle(current, { ...terminal, sessionId: current.nativeSessionId })
      }).pipe(Effect.mapError(failure))
    const prepareNative: NonNullable<SandboxDispatchPort["prepareNative"]> = (run) =>
      Effect.gen(function* () {
        const cli = yield* Effect.try(() => nativeCli(run))
        const policy = options.policies.find((entry) => entry.alias === run.repository)
        if (
          policy === undefined ||
          run.agent !== "sandbox" ||
          (run.resolvedSelection != null &&
            run.resolvedSelection.executor !== `${run.executorKind}:local`)
        )
          return yield* Effect.fail(failure())
        yield* Effect.tryPromise(async () => {
          await mkdir(dirname(run.directory), { recursive: true, mode: 0o700 })
          await mkdir(run.directory, { mode: 0o700 })
        })
        yield* github.verifyWorkflow(policy)
        const sourceSha = yield* github.resolveSource(policy, run.baseRef ?? "HEAD")
        yield* store.request({
          runId: run.runId,
          leaseId: run.runId,
          policy,
          sourceSha,
          now: Date.now(),
        })
        const lease = yield* leases.acquire(run.runId).pipe(
          Effect.repeat({
            until: (lease) => lease.state === "ready",
            schedule: Schedule.spaced("2 seconds"),
          }),
        )
        if (lease.transport === null) return yield* Effect.fail(failure())
        const binding = {
          runId: run.runId,
          leaseId: lease.lease_id,
          sessionId: cli.executionId!(run.runId),
          executorId: `${run.executorKind}:local`,
          endpointIdentity: nativeEndpoint(run),
          directory: run.directory,
          locationIdentity: run.directory,
          bridgeServerName: sandboxBridgeName(lease.lease_id),
          repositoryId: policy.repositoryId,
          sourceSha,
          policyHash: sandboxPolicyHash,
          transportHash: transportHash(lease.transport),
          deadline: lease.deadline,
          state: "reserved" as const,
        }
        yield* Effect.tryPromise(() => writeSandboxBinding(binding, true))
        yield* store.attachSession(run.runId, binding.sessionId)
        const root = bindingDirectory(run.directory)
        yield* Effect.tryPromise(async () => {
          await compileSandboxBridge(join(root, "bridge"))
          await saveSandboxFile(root, "transport.json", JSON.stringify(lease.transport), true)
          await writeSandboxBinding({ ...binding, state: "active" })
        })
        return { cli, sandboxBindingFile: join(root, "binding.json") }
      }).pipe(Effect.timeout("5 minutes"), Effect.mapError(failure))
    const launch = (run: AgentRunRecord, model: OpenCodeModel) =>
      Effect.gen(function* () {
        const policy = options.policies.find((entry) => entry.alias === run.repository)
        if (policy === undefined) return yield* Effect.fail(failure())
        if (
          run.agent !== "sandbox" ||
          (run.resolvedSelection != null && run.resolvedSelection.executor !== options.executorId)
        )
          return yield* Effect.fail(failure())
        const locationIdentity = yield* executor.reserve(run.directory)
        yield* github.verifyWorkflow(policy)
        const sourceSha = yield* github.resolveSource(policy, run.baseRef ?? "HEAD")
        yield* store.request({
          runId: run.runId,
          leaseId: run.runId,
          policy,
          sourceSha,
          now: Date.now(),
        })
        const acquire = leases.acquire(run.runId).pipe(
          Effect.repeat({
            until: (lease) => lease.state === "ready",
            schedule: Schedule.spaced("2 seconds"),
          }),
        )
        const lease = yield* acquire
        if (lease.transport === null) return yield* Effect.fail(failure())
        const binding = {
          runId: run.runId,
          leaseId: lease.lease_id,
          sessionId: Session.ID.create(),
          executorId: options.executorId,
          endpointIdentity: options.endpointIdentity,
          directory: run.directory,
          locationIdentity,
          bridgeServerName: sandboxBridgeName(lease.lease_id),
          repositoryId: policy.repositoryId,
          sourceSha,
          policyHash: sandboxPolicyHash,
          transportHash: transportHash(lease.transport),
          deadline: lease.deadline,
          state: "reserved" as const,
        }
        yield* Effect.tryPromise(() => writeSandboxBinding(binding, true))
        yield* store.attachSession(run.runId, binding.sessionId)
        yield* executor.start(binding, lease.transport, model)
        return { nativeSessionId: binding.sessionId }
      }).pipe(
        Effect.timeout("5 minutes"),
        Effect.onError(() =>
          settle(run, {
            state: "operator_required",
            sessionId: run.nativeSessionId,
            finalMessage: null,
            diagnostic: "Sandbox startup failed",
          }).pipe(Effect.ignore),
        ),
        Effect.mapError(failure),
      )
    const observe = (run: AgentRunRecord) =>
      Effect.gen(function* () {
        const lease = yield* store.read(run.runId)
        if (lease === null) return
        // Notify the caller of uncertain remote custody; reconciliation continues after delivery.
        if (lease.state === "operator_required" && isUnobservedRun(lease)) {
          yield* publish(run)
          return
        }
        if (run.state !== "verified" && lease.state !== "releasing" && lease.state !== "released") {
          if (Date.now() - run.createdAt.getTime() > 7 * 60000) yield* cancel(run)
          return
        }
        if (lease.state === "releasing" || lease.state === "released") {
          const saved = yield* Effect.tryPromise(() =>
            Bun.file(join(run.directory, "terminal.json")).exists(),
          )
          if (!saved) {
            yield* settle(run, {
              state: "operator_required",
              sessionId: run.nativeSessionId,
              finalMessage: null,
              diagnostic: "Sandbox result persistence interrupted",
            })
            return
          }
          if (lease.state === "releasing") {
            yield* stop(run)
            yield* leases.release(run.runId)
          }
          yield* publish(run)
          return
        }
        const pending = yield* Effect.tryPromise(() =>
          Bun.file(join(run.directory, "terminal.json")).exists(),
        )
        if (pending) {
          yield* stop(run)
          yield* leases.release(run.runId)
          yield* publish(run)
          return
        }
        if (lease.deadline <= Date.now())
          return yield* settle(run, {
            state: "operator_required",
            sessionId: run.nativeSessionId,
            finalMessage: null,
            diagnostic: "Sandbox deadline exceeded",
          })
        // Native workers settle through their durable process observer. On restart the
        // startup sweep below revokes and stops them before releasing their lease.
        if (run.executorKind === "codex" || run.executorKind === "claude") return
        if (run.nativeSessionId === null) return
        const sessionId = run.nativeSessionId
        const result = yield* Effect.result(
          provider(sessionId).pipe(
            Effect.flatMap((dedicated) => dedicated.sessionTelemetry({ sessionID: sessionId })),
          ),
        )
        if (result._tag === "Failure" || result.success === undefined) {
          yield* settle(run, {
            state: "operator_required",
            sessionId: run.nativeSessionId,
            finalMessage: null,
            diagnostic: "Sandbox process or session lost",
          })
          return
        }
        const telemetry = result.success
        if (telemetry.idle)
          yield* settle(run, {
            state:
              telemetry.outcome === "succeeded" || telemetry.outcome === undefined
                ? "completed"
                : "operator_required",
            sessionId: run.nativeSessionId,
            finalMessage: telemetry.finalMessage ?? null,
            diagnostic: `Sandbox session ${telemetry.outcome ?? "completed"}`,
          })
        else
          yield* runs.recordProgress({
            runId: run.runId,
            outputTokens: telemetry.outputTokens,
            now: new Date(),
          })
      }).pipe(Effect.mapError(failure))
    // A new coordinator never resumes an abandoned execution or injects resident tools.
    for (const lease of yield* store.active()) {
      const run = yield* runs.read(lease.run_id)
      if (run !== null)
        yield* settle(run, {
          state: "operator_required",
          sessionId: run.nativeSessionId,
          finalMessage: null,
          diagnostic: "Sandbox coordinator restarted",
        }).pipe(Effect.ignore)
      else if (lease.session_id !== null || lease.unit !== null)
        yield* store.sessionCleanupError(lease.run_id)
      else yield* store.beginRelease(lease.run_id)
    }
    const heartbeat = Effect.gen(function* () {
      for (const lease of yield* store.active())
        if (lease.state === "ready") yield* leases.heartbeat(lease.run_id).pipe(Effect.ignore)
    }).pipe(Effect.mapError(failure))
    const iteration = Effect.gen(function* () {
      // Observe sessions before inventory; failure to inventory never proves release.
      for (const lease of yield* store.active()) {
        const run = yield* runs.read(lease.run_id)
        if (run !== null) yield* observe(run).pipe(Effect.ignore)
      }
      yield* leases.reconcile(options.policies)
      // Release confirmation may have arrived during reconciliation.
      for (const kind of ["opencode", "codex", "claude"] as const)
        for (const run of yield* runs.listActiveByExecutor(kind))
          if ((yield* store.read(run.runId))?.state === "released") yield* observe(run)
    }).pipe(Effect.mapError(failure))
    return {
      launch,
      prepareNative,
      finishNative,
      cancel,
      observe,
      provider,
      heartbeat,
      iteration,
      owns: (runId: string) =>
        store.read(runId).pipe(
          Effect.map((lease) => lease !== null),
          Effect.mapError(failure),
        ),
    } satisfies SandboxDispatchPort
  })
