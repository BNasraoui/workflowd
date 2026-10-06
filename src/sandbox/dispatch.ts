import { Context, Effect, Schedule, Schema } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { AgentRunStore, type AgentRunRecord } from "../kernel/agent-run-store"
import type { OpenCodeModel, OpenCodeAdapter } from "../opencode/adapter"
import { makeSandboxStore, SandboxError } from "./store"
import type { SandboxPolicy } from "./config"
import type { makeSandboxGithub } from "./github"
import type { makeSandboxLeaseService } from "./lease"
import { createSandboxProvider } from "./provider"
import {
  readSandboxEndpoint,
  saveSandboxFile,
  startSandboxOpenCode,
  stopSandboxOpenCode,
} from "./opencode"

export type SandboxDispatchPort = {
  readonly launch: (
    run: AgentRunRecord,
    model: OpenCodeModel,
  ) => Effect.Effect<
    {
      readonly nativeSessionId: string
      readonly endpoint: string
    },
    SandboxError
  >
  readonly cancel: (run: AgentRunRecord) => Effect.Effect<void, SandboxError>
  readonly observe: (run: AgentRunRecord) => Effect.Effect<void, SandboxError>
  readonly owns: (runId: string) => Effect.Effect<boolean, SandboxError>
  readonly provider: (sessionId: string) => Effect.Effect<OpenCodeAdapter, SandboxError>
  readonly heartbeat: Effect.Effect<void, SandboxError>
  readonly iteration: Effect.Effect<void, SandboxError>
}

export const SandboxDispatch = Context.Service<SandboxDispatchPort>("workflowd/SandboxDispatch")

const failure = () =>
  new SandboxError({ message: "Sandbox custody operation failed; reconciliation required" })
const Terminal = Schema.Struct({
  state: Schema.Literals(["completed", "cancelled", "operator_required"]),
  sessionId: Schema.NullOr(Schema.String),
  finalMessage: Schema.NullOr(Schema.String),
  diagnostic: Schema.String,
})

export const makeSandboxDispatch = (options: {
  readonly policies: ReadonlyArray<SandboxPolicy>
  readonly github: Effect.Success<ReturnType<typeof makeSandboxGithub>>
  readonly leases: Effect.Success<ReturnType<typeof makeSandboxLeaseService>>
  readonly binary: string
  readonly authFile: string
  readonly providers: Readonly<Record<string, unknown>>
}) =>
  Effect.gen(function* () {
    const store = yield* makeSandboxStore
    const runs = yield* AgentRunStore
    const { github, leases } = options
    const provider = (sessionId: string) =>
      Effect.gen(function* () {
        const lease = yield* store.bySession(sessionId)
        if (lease === null || lease.state !== "ready") return yield* Effect.fail(failure())
        const run = yield* runs.read(lease.run_id)
        if (run === null) return yield* Effect.fail(failure())
        const endpoint = yield* Effect.tryPromise(() => readSandboxEndpoint(run.directory))
        if (endpoint.unit !== lease.unit || endpoint.invocationId !== lease.invocation)
          return yield* Effect.fail(failure())
        return createSandboxProvider(endpoint)
      }).pipe(Effect.mapError(failure))
    const stop = (run: AgentRunRecord) =>
      Effect.gen(function* () {
        const lease = yield* store.read(run.runId)
        if (lease === null) return
        const { unit, invocation } = lease
        if (unit !== null && invocation !== null) {
          yield* Effect.tryPromise(() => stopSandboxOpenCode({ unit, invocationId: invocation }))
          return
        }
        const exists = yield* Effect.tryPromise(() =>
          Bun.file(join(run.directory, "endpoint.json")).exists(),
        )
        if (!exists) {
          if (lease.unit !== null) return yield* Effect.fail(failure())
          return
        }
        const endpoint = yield* Effect.tryPromise(() => readSandboxEndpoint(run.directory))
        if (
          endpoint.unit !== `workflowd-sandbox-${lease.lease_id}` ||
          (lease.invocation !== null && endpoint.invocationId !== lease.invocation)
        )
          return yield* Effect.fail(failure())
        yield* Effect.tryPromise(() => stopSandboxOpenCode(endpoint))
      })
    const publish = (run: AgentRunRecord) =>
      Effect.gen(function* () {
        const lease = yield* store.read(run.runId)
        if (lease !== null && lease.state !== "released") return
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
        if (terminal.state === "completed")
          yield* runs.complete({ runId: run.runId, finalMessage: terminal.finalMessage, now })
        else if (terminal.state === "cancelled")
          yield* runs.cancel({ runId: run.runId, diagnostic: terminal.diagnostic, now })
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
        const pending = yield* Effect.tryPromise(() =>
          Bun.file(join(run.directory, "terminal.json")).exists(),
        )
        if (!pending) {
          yield* Effect.tryPromise(() => mkdir(run.directory, { recursive: true, mode: 0o700 }))
          let result = terminal
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
            Effect.ignore,
            Effect.andThen(leases.release(run.runId).pipe(Effect.ignore)),
          ),
        ),
        Effect.tapError(() => store.recordError(run.runId)),
        Effect.mapError(failure),
      )
    const cancel = (run: AgentRunRecord) =>
      settle(run, {
        state: "cancelled",
        sessionId: run.nativeSessionId,
        finalMessage: null,
        diagnostic: "Sandbox cancellation requested",
      })
    const launch = (run: AgentRunRecord, model: OpenCodeModel) =>
      Effect.gen(function* () {
        const policy = options.policies.find((entry) => entry.alias === run.repository)
        if (policy === undefined) return yield* Effect.fail(failure())
        yield* Effect.tryPromise(() => mkdir(run.directory, { recursive: true, mode: 0o700 }))
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
        const server = yield* Effect.tryPromise({
          try: (signal) =>
            startSandboxOpenCode({
              directory: run.directory,
              binary: options.binary,
              authFile: options.authFile,
              providers: { [model.providerID]: options.providers[model.providerID] ?? {} },
              transport: lease.transport!,
              signal,
              onStarted: (endpoint) =>
                Effect.runPromise(
                  store.attachUnit(run.runId, endpoint.unit, endpoint.invocationId),
                ),
            }),
          catch: failure,
        })
        const dedicated = createSandboxProvider(server)
        const models = yield* dedicated.listModels({
          directory: join(run.directory, "home/.config/opencode"),
        })
        if (
          !models.some(
            (candidate) =>
              candidate.providerID === model.providerID && candidate.id === model.modelID,
          )
        )
          return yield* Effect.fail(failure())
        const session = yield* dedicated.createSession({
          directory: join(run.directory, "home/.config/opencode"),
          title: `workflowd ${run.runId}`,
          agent: "sandbox",
          model,
        })
        yield* store.attachSession(run.runId, session.id)
        return { nativeSessionId: session.id, endpoint: server.url }
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
      const activeRuns = yield* runs.listActiveByExecutor("opencode")
      for (const run of activeRuns)
        if ((yield* store.read(run.runId))?.state === "released") yield* observe(run)
    }).pipe(Effect.mapError(failure))
    return {
      launch,
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
