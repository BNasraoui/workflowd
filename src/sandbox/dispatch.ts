import { sandboxDiagnostic, retainSandboxFailure } from "./diagnostics"
import { visibleText } from "../../deploy/sandbox/hidden-text.mjs"
import { Context, Deferred, Effect, Schedule, Schema, Stream } from "effect"
import type { AgentGitConfig } from "../agent-git/config"
import type { GatewayEnd } from "../capability-control/protocol"
import {
  makeRunnerExecutor,
  type RunnerGateway,
  type RunnerHandle,
  RunnerRunFailed,
  runnerWindows,
} from "../kernel/runner-executor"
import { SealedResultRefused, type SealedResultGitPort } from "../kernel/sealed-result"
import { WorkspaceError } from "../workspace/errors"
import { githubHost } from "./github"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AgentRunStore, type AgentRunRecord } from "../kernel/agent-run-store"
import type { OpenCodeModel, OpenCodeAdapter } from "../opencode/adapter"
import { makeSandboxStore, SandboxError, isUnobservedRun, sandboxStage } from "./store"
import { sandboxCompletionInstructions, type SandboxPolicy } from "./config"
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
import type { CliPort, CliSpawnInput } from "../kernel/cli-process-contract"
import { compileSandboxBridge } from "./bridge"
import { makeSandboxPublisher, SandboxTerminal as Terminal } from "./publish"
import { makePublishStore } from "./publish-store"
import {
  observeSandboxStage,
  observeSandboxTelemetry,
  type SandboxObservationError,
} from "./observation"

export type SandboxDispatchPort = {
  readonly prepareNative?: (run: AgentRunRecord) => Effect.Effect<
    {
      readonly cli: CliPort
      /** The binding of a local sandbox run; a runner run has none. */
      readonly sandboxBindingFile?: string
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
  readonly provider: (
    sessionId: string,
  ) => Effect.Effect<AgentRunProviderPort, SandboxError | SandboxObservationError>
  readonly heartbeat: Effect.Effect<void, SandboxError>
  readonly iteration: Effect.Effect<void, SandboxError>
}

export const SandboxDispatch = Context.Service<SandboxDispatchPort>("workflowd/SandboxDispatch")

/** A runner run's time from its start: the deadline of its lease (`store.request`). */
/** The states of a runner run that has not ended. */
const activeRunStates = new Set(["accepted", "spawning", "spawned", "verified"])
/** The time from a runner run's lease to the session of its job, after which its start fails. */
/** The most code points of a runner run's diagnostic that reach its caller. */
const runnerTextCharacters = 1000
const workspaceFailure = (detail: string) =>
  new WorkspaceError({ operation: "runner", cause: new Error(`Runner run failed: ${detail}`) })
const failure = (cause?: unknown) =>
  new SandboxError(
    sandboxDiagnostic(
      "dispatch.custody",
      cause ?? new Error("Sandbox custody operation failed; reconciliation required"),
    ),
  )

export const makeSandboxDispatch = (options: {
  readonly policies: ReadonlyArray<SandboxPolicy>
  readonly github: Effect.Success<ReturnType<typeof makeSandboxGithub>>
  readonly leases: Effect.Success<ReturnType<typeof makeSandboxLeaseService>>
  readonly executor: OpenCodeAdapter
  readonly client: OpenCodeClient
  readonly executorId: string
  readonly endpointIdentity: string
  readonly nativeExecutors?: Partial<Record<"codex" | "claude", CliPort>>
  /** The runner placement: its aliases, its bound of runs, the gateway and the check of results. */
  readonly runner?: {
    readonly aliases: ReadonlyArray<string>
    readonly maxRuns: number
    readonly gateway: RunnerGateway
    readonly sealed: SealedResultGitPort
    readonly agentGit: AgentGitConfig
  }
}) =>
  Effect.gen(function* () {
    const store = yield* makeSandboxStore
    const runs = yield* AgentRunStore
    const { github, leases } = options
    const publications = yield* makePublishStore
    const publisher = yield* makeSandboxPublisher(github, leases)
    const continuePublication = publisher.continuePublication
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
    const bindingFor = Effect.fn("SandboxDispatch.binding")(
      function* (sessionId: string) {
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
      },
      (effect) => observeSandboxStage("binding", effect),
    )
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
          promptSession: (input) =>
            guard(
              input,
              options.executor.promptSession({
                ...input,
                text: `${sandboxCompletionInstructions}\n\n${input.text}`,
              }),
            ),
          abortSession: (input) => guard(input, options.executor.abortSession(input)),
          sessionTelemetry: (input) =>
            guard(
              input,
              observeSandboxStage("telemetry", options.executor.sessionTelemetry(input)),
            ),
        } satisfies AgentRunProviderPort
      }).pipe((effect) => observeSandboxStage("binding", effect))
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
        if (
          lease?.policy.publish !== undefined &&
          (yield* publications.read(run.runId)) !== null &&
          terminal.state !== "cancelled"
        ) {
          if (!(yield* continuePublication(run))) yield* leases.release(run.runId)
          yield* publish(run)
          return
        }
        yield* publisher.saveTerminal(run, terminal)
        yield* stop(run)
        if (lease !== null && !(yield* continuePublication(run, terminal.state === "cancelled")))
          yield* leases.release(run.runId)
        yield* publish(run)
      }).pipe(
        Effect.onError(() =>
          stop(run).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const lease = yield* store.read(run.runId)
                if (
                  lease?.policy.publish === undefined ||
                  (yield* publications.read(run.runId)) === null
                )
                  yield* leases.release(run.runId).pipe(Effect.ignore)
              }),
            ),
            Effect.ignore,
          ),
        ),
        Effect.tapError((cause) => store.recordError(run.runId, cause)),
        (effect) => sandboxStage("dispatch.settle", effect),
        Effect.tapError((cause) => retainSandboxFailure(run.directory, "dispatch.settle", cause)),
      )
    /**
     * The stop of a runner run: its events end `cancelled`, and the gateway revokes it at once. A
     * revoke that fails is logged; the run's release revokes it again. A run that no executor holds
     * is settling already (a coordinator's start settles every runner run that it finds live).
     */
    const stopRunner = (run: AgentRunRecord) =>
      runnerExecutor === undefined
        ? Effect.void
        : runnerExecutor.stopRun(run.runId).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning("Runner run revoke at its stop failed; its release revokes it", {
                runId: run.runId,
                reason: error.reason,
              }),
            ),
          )
    const cancel = (run: AgentRunRecord) =>
      Effect.suspend(() => {
        if (runnerPolicy(run.repository) !== undefined) return stopRunner(run)
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
        if (runnerPolicy(run.repository) !== undefined) return yield* finishRunner(run, terminal)
        // Stopping a CLI also wakes its exit observer. The cancellation caller owns
        // settlement until its terminal record is saved or custody reports failure.
        if (cancelling.has(run.runId)) return
        const current = yield* runs.read(run.runId)
        if (current === null) return yield* Effect.fail(failure())
        yield* settle(current, { ...terminal, sessionId: current.nativeSessionId })
      }).pipe((effect) => sandboxStage("dispatch.finishNative", effect))
    /**
     * The runner placement. A runner run's lease ref starts its job; the run is the job's, and the
     * daemon reads its events and its one result from the gateway, checks the result and pushes
     * `agent-run/<id>`. What ended the run is kept for its settlement: the final message of a run
     * that completed is its sealed result's, which the check read; its events are its progress.
     */
    const runnerOptions = options.runner
    const runnerEnds = new Map<
      string,
      | { readonly kind: "ended"; readonly diagnostic: string; readonly ended: GatewayEnd | null }
      | { readonly kind: "cancelled" }
      | { readonly kind: "sealed"; readonly finalMessage: string; readonly unchanged: boolean }
    >()
    const runnerPolicy = (alias: string) =>
      runnerOptions?.aliases.includes(alias) === true
        ? options.policies.find(
            (entry) => entry.alias === alias && entry.privateBootstrap?.mode === "actions-native",
          )
        : undefined
    const runnerExecutor =
      runnerOptions === undefined
        ? undefined
        : makeRunnerExecutor({
            gateway: runnerOptions.gateway,
            maxRuns: runnerOptions.maxRuns,
            // The Actions run of the lease, once the lease holds one. A failed read is no news:
            // the run goes on to its deadline.
            job: (runId) =>
              Effect.gen(function* () {
                const lease = yield* store.read(runId)
                if (lease?.actions_run_id == null || lease.actions_attempt == null) return null
                const run = yield* github.savedRun(
                  lease.policy,
                  lease.lease_id,
                  lease.actions_run_id,
                  lease.actions_attempt,
                )
                return { status: run.status, conclusion: run.conclusion }
              }).pipe(Effect.orElseSucceed(() => null)),
            begin: (launch, stopped) =>
              Effect.gen(function* () {
                const policy = runnerPolicy(launch.repository)
                if (policy === undefined) return yield* Effect.fail(failure())
                yield* github.verifyWorkflow(policy)
                yield* store.request({
                  runId: launch.runId,
                  leaseId: launch.runId,
                  policy,
                  sourceSha: launch.sourceSha,
                  now: Date.now(),
                  deadline: launch.deadline.getTime() + runnerWindows.leaseGraceMs,
                })
                // The lease is ready once the job holds its gateway session. The wait ends at
                // the session, at a stop of the run (its events then end it) or after
                // `sessionWaitMs`; a stop of the daemon ends it between two reads.
                const until = Date.now() + runnerWindows.sessionWaitMs
                for (;;) {
                  const lease = yield* leases.acquire(launch.runId)
                  if (lease.state === "ready" || stopped()) return
                  if (Date.now() >= until)
                    return yield* new RunnerRunFailed({
                      reason: "runner_start",
                      message: `the run's job held no gateway session within ${runnerWindows.sessionWaitMs / 60000} minutes`,
                    })
                  yield* Effect.interruptible(Effect.sleep("2 seconds"))
                }
              }).pipe(
                Effect.mapError((cause) =>
                  cause instanceof RunnerRunFailed
                    ? cause
                    : new RunnerRunFailed({
                        reason: "runner_start",
                        message: sandboxDiagnostic("runner.start", cause).message,
                      }),
                ),
              ),
          })
    const runnerExit = (runId: string, diagnostic: string, ended: GatewayEnd | null = null) =>
      Effect.sync(() => {
        runnerEnds.set(runId, { kind: "ended", diagnostic, ended })
        return { exitCode: 1, stderr: diagnostic }
      })
    /** The end of a run whose stop came: it pushes nothing, whatever else ended it. */
    const runnerCancelled = (runId: string) =>
      Effect.sync(() => {
        runnerEnds.set(runId, { kind: "cancelled" })
        return { exitCode: 1, stderr: "cancelled" }
      })
    /**
     * Checks the run's sealed result and pushes it to `agent-run/<id>`, which must be new. A stop
     * before the push ends the run cancelled with nothing pushed; a push that began runs to its end,
     * also through a stop of the run or of the daemon, and its end is the run's: completed once
     * the target holds the result, or the push's fault.
     */
    const publishRunner = (
      run: AgentRunRecord,
      handle: RunnerHandle,
      policy: SandboxPolicy,
      /** A result of a daemon before this one, which may have pushed it before it stopped. */
      resumed = false,
    ) => {
      let pushing = false
      return Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* store.read(run.runId)
          if (lease === null || runnerExecutor === undefined || runnerOptions === undefined)
            return yield* Effect.fail(failure())
          const result = yield* runnerExecutor.result(handle)
          if (handle.stopping) return yield* runnerCancelled(run.runId)
          // A run that changed nothing posts its completion with an empty bundle: it ends with its
          // final message, and nothing is pushed.
          if (result.bundle.length === 0) {
            if (result.sourceSha !== lease.source_sha)
              return yield* Effect.fail(
                new SealedResultRefused({
                  check: "source",
                  detail: "",
                  message: "result_refused: source",
                }),
              )
            runnerEnds.set(run.runId, {
              kind: "sealed",
              finalMessage: result.finalMessage,
              unchanged: true,
            })
            return { exitCode: 0, stderr: "" }
          }
          const checked = yield* runnerOptions.sealed.check(
            result,
            {
              ref: `refs/heads/agent-run/${run.runId.replace(/^agent-run-/, "").slice(0, 16)}`,
              expectedHead: null,
              ...(resumed ? { resumed } : {}),
            },
            {
              remote: `https://${githubHost}/${policy.repository}.git`,
              sourceSha: lease.source_sha,
              token: github.pushToken(policy),
              agentGit: runnerOptions.agentGit,
            },
          )
          if (handle.stopping) return yield* runnerCancelled(run.runId)
          pushing = true
          yield* Effect.uninterruptible(checked.push())
          runnerEnds.set(run.runId, {
            kind: "sealed",
            finalMessage: result.finalMessage,
            unchanged: false,
          })
          return { exitCode: 0, stderr: "" }
        }),
      ).pipe(
        Effect.catch((error) =>
          handle.stopping && !pushing
            ? runnerCancelled(run.runId)
            : runnerExit(
                run.runId,
                error instanceof SealedResultRefused
                  ? `result_refused: ${error.check}`
                  : error instanceof RunnerRunFailed
                    ? `${error.reason}: ${error.message}`
                    : sandboxDiagnostic("runner.result", error).message,
              ),
        ),
      )
    }
    /** The CLI of one runner run: its events from the gateway, its exit once its result is pushed. */
    const runnerCli = (run: AgentRunRecord, policy: SandboxPolicy, sourceSha: string): CliPort => ({
      ownership: "transient-exec",
      preflight: Effect.void,
      executionId: (runId) => runId,
      attach: () => Effect.succeed(null),
      spawn: (input) =>
        Effect.gen(function* () {
          if (runnerExecutor === undefined) return yield* Effect.fail(workspaceFailure("runner"))
          const handle = yield* runnerExecutor
            .start({
              runId: run.runId,
              repository: run.repository,
              imageDigest: policy.agentImage,
              sourceSha,
              prompt: input.prompt,
              model: input.model ?? "",
              deadline: new Date(Date.now() + runnerWindows.deadlineMs),
            })
            .pipe(
              // A start that fails or that a stop of the daemon ends leaves its cause for the
              // run's settlement, which releases the lease if one was made.
              Effect.tapError((error) =>
                runnerExit(run.runId, `${error.reason}: ${error.message}`),
              ),
              Effect.onInterrupt(() =>
                runnerExit(
                  run.runId,
                  "runner_start: the daemon stopped before the run's job held its gateway session",
                ),
              ),
              Effect.mapError((error) => workspaceFailure(`${error.reason}: ${error.message}`)),
            )
          const eventsEnded = yield* Deferred.make<RunnerRunFailed | null>()
          // The observer's stop of a run whose events stalled: the run ends with its diagnostic.
          const halted = yield* Deferred.make<void>()
          const events = runnerExecutor.events(handle).pipe(
            Stream.catch((error) =>
              Stream.fromEffect(Deferred.succeed(eventsEnded, error)).pipe(Stream.drain),
            ),
            Stream.ensuring(Deferred.succeed(eventsEnded, null)),
          )
          return {
            executionId: run.runId,
            events: Stream.toAsyncIterable(events),
            ready: Deferred.await(handle.boxReady),
            exited: Effect.raceFirst(
              Deferred.await(eventsEnded).pipe(
                Effect.flatMap((ended) =>
                  ended === null
                    ? publishRunner(run, handle, policy)
                    : ended.reason === "cancelled" || handle.stopping
                      ? runnerCancelled(run.runId)
                      : runnerExit(run.runId, `${ended.reason}: ${ended.message}`, handle.ended),
                ),
              ),
              Deferred.await(halted).pipe(
                Effect.andThen(runnerExit(run.runId, "runner_stalled: the run's events stalled")),
              ),
            ),
            cancel: runnerExecutor.stop(handle).pipe(
              Effect.mapError(() => workspaceFailure("stop")),
              Effect.ensuring(Deferred.succeed(halted, undefined)),
            ),
          }
        }),
    })
    /** A runner run's start: its source commit, then its executor, which starts its job. */
    const prepareRunner = (run: AgentRunRecord, policy: SandboxPolicy) =>
      Effect.gen(function* () {
        if (run.agent !== "sandbox" || run.resolvedSelection?.executor !== "claude:actions")
          return yield* Effect.fail(failure())
        yield* Effect.tryPromise(async () => {
          await mkdir(dirname(run.directory), { recursive: true, mode: 0o700 })
          await mkdir(run.directory, { mode: 0o700 })
        })
        const sourceSha = yield* github.resolveSource(
          policy,
          policy.publish?.baseRef ?? run.baseRef ?? "HEAD",
        )
        return { cli: runnerCli(run, policy, sourceSha) }
      }).pipe(Effect.timeout("5 minutes"), (effect) =>
        sandboxStage("dispatch.prepareRunner", effect),
      )
    /**
     * Settles a runner run: its lease is released (the gateway's run revoked, the lease ref
     * removed), then the run ends as a host run does, with the gateway's own end when there is one.
     * The end is what the run's executor recorded (`runnerEnds`): its stop, its checked sealed
     * result, or the cause of its end (the deadline, the gateway, the Actions run, the lost runner,
     * the check). An event line, which the agent can write, decides neither the end nor its text:
     * a run whose sealed result was checked completes with that result's final message, whatever
     * its events said; a run that ends otherwise has no final message. Each diagnostic reaches the
     * caller without control or invisible code points and at most `runnerTextCharacters` long.
     */
    const finishRunner = (
      run: AgentRunRecord,
      terminal: Parameters<NonNullable<SandboxDispatchPort["finishNative"]>>[1],
    ) =>
      Effect.gen(function* () {
        const end = runnerEnds.get(run.runId)
        runnerEnds.delete(run.runId)
        runnerExecutor?.release(run.runId)
        if ((yield* store.read(run.runId)) !== null)
          yield* leases.release(run.runId).pipe(Effect.ignore)
        // A run ends once: a second settlement of a run that ended (the dispatch settles a start
        // that it refused, then its error) keeps the first end.
        const current = yield* runs.read(run.runId)
        if (current === null || !activeRunStates.has(current.state)) return
        const now = new Date()
        if (end?.kind === "cancelled")
          yield* runs.cancel({ runId: run.runId, now, diagnostic: "cancelled" })
        else if (end?.kind === "sealed")
          yield* runs.complete({
            runId: run.runId,
            now,
            finalMessage: end.finalMessage,
            ...(end.unchanged ? { endReason: "unchanged" } : {}),
          })
        else
          yield* runs.operatorRequired({
            runId: run.runId,
            now,
            // With no end of the executor, the settlement is the daemon's own (a restart, a
            // start that failed before the executor held the run).
            diagnostic: visibleText(
              end?.kind === "ended" ? end.diagnostic : terminal.diagnostic,
              runnerTextCharacters,
            ),
            finalMessage: null,
            ended: end?.kind === "ended" ? end.ended : null,
          })
      }).pipe(
        Effect.catchTag("AgentRunStoreConflictError", () => Effect.void),
        (effect) => sandboxStage("dispatch.finishRunner", effect),
      )
    const prepareNative: NonNullable<SandboxDispatchPort["prepareNative"]> = (run) =>
      Effect.gen(function* () {
        const policy = options.policies.find((entry) => entry.alias === run.repository)
        // A runner of an actions-native repository opens a gateway session and has no SSH peer
        // to start the harness through: only the runner placement starts such a run.
        const runner = runnerPolicy(run.repository)
        if (runner !== undefined) return yield* prepareRunner(run, runner)
        if (policy?.privateBootstrap?.mode === "actions-native")
          return yield* Effect.fail(failure(new Error("Actions-native harness start unavailable")))
        const cli = yield* Effect.try(() => nativeCli(run))
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
        const sourceSha = yield* github.resolveSource(
          policy,
          policy.publish?.baseRef ?? run.baseRef ?? "HEAD",
        )
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
          submissionCheck: {
            repositoryUrl: github.repositoryUrl(policy),
            databasePath: yield* publications.databasePath,
          },
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
        return {
          cli: {
            ...cli,
            spawn: (input: CliSpawnInput) =>
              cli.spawn({
                ...input,
                prompt: `${sandboxCompletionInstructions}\n\n${input.prompt}`,
              }),
          },
          sandboxBindingFile: join(root, "binding.json"),
        }
      }).pipe(
        Effect.timeout("5 minutes"),
        (effect) => sandboxStage("dispatch.prepareNative", effect),
        Effect.tapError((cause) =>
          retainSandboxFailure(run.directory, "dispatch.prepareNative", cause),
        ),
      )
    const launch = (run: AgentRunRecord, model: OpenCodeModel) =>
      Effect.gen(function* () {
        const policy = options.policies.find((entry) => entry.alias === run.repository)
        if (policy === undefined || policy.privateBootstrap?.mode === "actions-native")
          return yield* Effect.fail(failure())
        if (
          run.agent !== "sandbox" ||
          (run.resolvedSelection != null && run.resolvedSelection.executor !== options.executorId)
        )
          return yield* Effect.fail(failure())
        const locationIdentity = yield* executor.reserve(run.directory)
        yield* github.verifyWorkflow(policy)
        const sourceSha = yield* github.resolveSource(
          policy,
          policy.publish?.baseRef ?? run.baseRef ?? "HEAD",
        )
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
          submissionCheck: {
            repositoryUrl: github.repositoryUrl(policy),
            databasePath: yield* publications.databasePath,
          },
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
        Effect.onError((cause) =>
          settle(run, {
            state: "operator_required",
            sessionId: run.nativeSessionId,
            finalMessage: null,
            diagnostic: sandboxDiagnostic("dispatch.startup", cause).message,
          }).pipe(Effect.ignore),
        ),
        (effect) => sandboxStage("dispatch.launch", effect),
        Effect.tapError((cause) => retainSandboxFailure(run.directory, "dispatch.launch", cause)),
      )
    const observe = (run: AgentRunRecord) =>
      Effect.gen(function* () {
        // A runner run's executor owns each of its ends and windows (runnerWindows); a run that no
        // executor holds after a restart is settled by the startup sweep.
        if (runnerPolicy(run.repository) !== undefined) return
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
          if (yield* continuePublication(run)) return
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
          observeSandboxTelemetry(
            run.directory,
            provider(sessionId).pipe(
              Effect.flatMap((dedicated) => dedicated.sessionTelemetry({ sessionID: sessionId })),
            ),
          ),
        )
        if (result._tag === "Failure") {
          yield* settle(run, {
            state: "operator_required",
            sessionId: run.nativeSessionId,
            finalMessage: null,
            diagnostic: result.failure.message,
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
      }).pipe(
        (effect) => sandboxStage("dispatch.observe", effect),
        Effect.tapError((cause) => retainSandboxFailure(run.directory, "dispatch.observe", cause)),
      )
    /**
     * The result of a runner run that a daemon before this one dispatched, when the gateway holds
     * it: checked and pushed, as its executor would have, so the run completes with it.
     */
    const recoverRunner = (run: AgentRunRecord) =>
      Effect.gen(function* () {
        const policy = runnerPolicy(run.repository)
        if (policy === undefined || runnerOptions === undefined || runnerExecutor === undefined)
          return
        const read = yield* runnerOptions.gateway.readEvents(run.runId, 0)
        if (read.result && read.ended === null)
          yield* publishRunner(run, runnerExecutor.held(run.runId), policy, true)
      })
    // A new coordinator never resumes an abandoned execution or injects resident tools. A runner
    // run's events are read by no executor of this coordinator: a result that the gateway holds
    // for it is checked and pushed, then its lease is released, which revokes it and cancels its
    // Actions run, and it ends once: completed with that result, or operator_required.
    for (const lease of yield* store.active()) {
      const run = yield* runs.read(lease.run_id)
      if (run !== null && runnerPolicy(run.repository) !== undefined)
        yield* recoverRunner(run).pipe(
          Effect.ignore,
          Effect.andThen(
            finishRunner(run, {
              state: "operator_required",
              finalMessage: null,
              diagnostic: "Sandbox coordinator restarted",
            }),
          ),
          Effect.ignore,
        )
      else if (run !== null)
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
    // The heartbeat of a host sandbox's SSH transport; a runner lease has none, its job posts to
    // the gateway.
    const heartbeat = Effect.gen(function* () {
      for (const lease of yield* store.active())
        if (
          lease.state === "ready" &&
          runnerPolicy(lease.policy.alias) === undefined &&
          (lease.policy.publish === undefined || (yield* publications.read(lease.run_id)) === null)
        )
          yield* leases.heartbeat(lease.run_id).pipe(
            Effect.tapError((cause) =>
              Effect.logError(sandboxDiagnostic("lease.heartbeat", cause).message),
            ),
            Effect.ignore,
          )
    }).pipe((effect) => sandboxStage("dispatch.heartbeat", effect))
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
    }).pipe((effect) => sandboxStage("dispatch.iteration", effect))
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
          (effect) => sandboxStage("dispatch.owns", effect),
        ),
    } satisfies SandboxDispatchPort
  })
