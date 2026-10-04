import { Effect, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentRunRefusalError } from "../kernel/agent-run-ingress"
import { AgentRunStore } from "../kernel/agent-run-store"
import { KernelSessionStore } from "../kernel/session-store"
import { WorkSignal } from "../work-signal"
import { RemoteAgentState, agentFragments } from "./agent-contract"
import { RemoteAgentDispatch } from "./agent-services"
import { initAgentTransfers, receiveAgentFragment } from "./agent-transfer"
import { RemoteCommand, RemoteHostId } from "./contract"
import { RemoteTransport } from "./transport"

export const RemoteAgentDispatchLive = (options: {
  readonly hosts: ReadonlyArray<string>
  readonly timeoutMs: number
}) =>
  Layer.effect(
    RemoteAgentDispatch,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const runs = yield* AgentRunStore
      const sessions = yield* KernelSessionStore
      const transport = yield* RemoteTransport
      const signals = yield* WorkSignal
      yield* initAgentTransfers
      yield* sql`CREATE TABLE IF NOT EXISTS remote_agent_probes (
    id TEXT PRIMARY KEY NOT NULL, host TEXT NOT NULL, version INTEGER, checked_at TEXT
  ) STRICT`

      const queue = (command: RemoteCommand) =>
        sql`INSERT INTO remote_agent_outbox (id,envelope)
    VALUES (${command.commandId},${JSON.stringify(command)}) ON CONFLICT DO NOTHING`.pipe(
          Effect.asVoid,
        )
      const flush = Effect.fn("RemoteAgent.flush")(function* () {
        const rows = yield* sql<{
          id: string
          envelope: string
        }>`SELECT id,envelope FROM remote_agent_outbox WHERE published = 0 ORDER BY rowid`
        for (const row of rows) {
          const command = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RemoteCommand))(
            row.envelope,
          )
          // Launch fragments and cancellations have their own durable fence. Probes
          // use the existing runner's generation fence (also understood by old peers).
          if (command.kind === "probe")
            yield* transport.publishFence({
              version: 1,
              kind: "fence",
              jobId: command.jobId,
              generation: 1,
              hostId: command.hostId,
              disposition: "current",
              issuedAt: command.issuedAt,
            })
          yield* transport.publishCommand(command)
          yield* sql`UPDATE remote_agent_outbox SET published = 1 WHERE id = ${row.id}`
        }
      })
      const preflight = Effect.fn("RemoteAgent.preflight")(function* (host: string) {
        yield* Schema.decodeUnknownEffect(RemoteHostId)(host)
        if (!options.hosts.includes(host))
          return yield* new AgentRunRefusalError({
            reason: "host_unavailable",
            detail: `remote launch host ${host} is not configured in WORKFLOWD_AGENT_RUN_HOSTS`,
          })
        // This is protocol readiness, not a per-host model inventory. Always probe
        // the actual target before a new launch; an old runner answers without v1.
        const id = `agent-ready-${crypto.randomUUID()}`
        const now = new Date()
        yield* sql`INSERT INTO remote_agent_probes (id,host) VALUES (${id},${host})`
        yield* queue({
          version: 1,
          kind: "probe",
          commandId: id,
          jobId: id,
          hostId: host,
          attempt: 1,
          generation: 1,
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + options.timeoutMs).toISOString(),
        })
        yield* flush().pipe(
          Effect.mapError(
            (error) =>
              new AgentRunRefusalError({
                reason: "host_unavailable",
                detail: `remote readiness publication failed: ${String(error)}`,
              }),
          ),
        )
        const response = yield* sql<{
          version: number | null
          checked_at: string | null
        }>`SELECT version,checked_at FROM remote_agent_probes WHERE id = ${id}`.pipe(
          Effect.repeat({
            until: (rows) => rows[0]?.checked_at != null,
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeoutOption(options.timeoutMs),
        )
        if (response._tag === "None")
          return yield* new AgentRunRefusalError({
            reason: "host_unavailable",
            detail: `runner ${host} did not answer its readiness probe`,
          })
        if (response.value[0]?.version !== 1)
          return yield* new AgentRunRefusalError({
            reason: "executor_unavailable",
            detail: `runner ${host} does not support agent-run protocol v1; upgrade/enable runner execution`,
          })
      })

      const receive = Effect.fn("RemoteAgent.receive")(function* (
        result: import("./contract").RemoteResult,
      ) {
        if (result.kind === "probe" && result.commandId.startsWith("agent-ready-")) {
          yield* sql`UPDATE remote_agent_probes SET version = ${result.agentRunVersion ?? 0}, checked_at = ${result.observedAt}
        WHERE id = ${result.commandId} AND host = ${result.hostId}`
          return true
        }
        if (result.kind !== "agent_state") return false
        const run = yield* runs.read(result.jobId)
        if (
          run === null ||
          run.resolvedSelection?.host !== result.hostId ||
          result.commandId !== `agent-${run.runId}` ||
          result.generation !== 1 ||
          result.attempt !== 1
        )
          return true
        yield* Effect.gen(function* () {
          const state = yield* receiveAgentFragment(result.fragment, RemoteAgentState)
          if (state === null || state.runId !== run.runId) return
          const current = yield* runs.read(run.runId)
          if (
            current === null ||
            (["completed", "failed", "cancelled", "operator_required"].includes(current.state) &&
              !(current.state === "operator_required" && state.state === "cancelled"))
          )
            return
          if (state.nativeSessionId !== null && current.nativeSessionId === null) {
            const kind = run.resolvedSelection!.executorKind
            const resourceId = `agent-run-resource-${run.runId.slice("agent-run-".length)}`
            const sessionId = `${kind}-session-${state.nativeSessionId}`
            yield* sessions.registerResource({
              resourceId,
              owningHostId: result.hostId,
              absolutePath: state.directory,
              kind: "worktree",
              createdAt: run.createdAt,
            })
            yield* sessions.registerSession({
              sessionId,
              providerKind: kind,
              providerVersion: 1,
              providerId: run.providerId,
              serverId: result.hostId,
              owningHostId: result.hostId,
              endpointAlias: "remote-agent",
              endpointIdentity: `remote-agent://${result.hostId}`,
              nativeSessionId: state.nativeSessionId,
              resourceId,
              createdAt: run.createdAt,
            })
            yield* sql`UPDATE kernel_agent_runs SET directory = ${state.directory} WHERE run_id = ${run.runId}`
            yield* runs.markSpawned({
              runId: run.runId,
              resourceId,
              sessionId,
              nativeSessionId: state.nativeSessionId,
              now: new Date(result.observedAt),
            })
            if (state.outputTokens > 0)
              yield* runs.markVerified({
                runId: run.runId,
                outputTokens: state.outputTokens,
                now: new Date(result.observedAt),
              })
          }
          const now = new Date(result.observedAt)
          if (state.state === "completed")
            yield* runs.complete({ runId: run.runId, now, finalMessage: state.finalMessage })
          else if (state.state === "cancelled")
            yield* runs.cancel({
              runId: run.runId,
              now,
              diagnostic: state.diagnostic ?? "remote cancellation confirmed",
            })
          else if (state.state !== "verified")
            yield* runs.operatorRequired({
              runId: run.runId,
              now,
              diagnostic: state.diagnostic ?? state.refusalReason ?? "remote execution failed",
              finalMessage: state.finalMessage,
            })
        }).pipe(sql.withTransaction, Effect.provideService(SqlClient.SqlClient, sql))
        yield* signals.wake("kernel-job")
        return true
      })

      const waitFor = (runId: string, cancelled = false, alreadyOperatorRequired = false) =>
        runs.read(runId).pipe(
          Effect.repeat({
            until: (run) =>
              run !== null &&
              (cancelled
                ? (alreadyOperatorRequired
                    ? ["completed", "cancelled", "failed"]
                    : ["completed", "cancelled", "failed", "operator_required"]
                  ).includes(run.state)
                : run.nativeSessionId !== null ||
                  ["failed", "operator_required", "cancelled"].includes(run.state)),
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeoutOption(options.timeoutMs),
        )
      const cancelCommand = (run: import("../kernel/agent-run-store").AgentRunRecord, now: Date) =>
        queue({
          version: 1,
          kind: "agent_cancel",
          commandId: `agent-cancel-${run.runId}`,
          jobId: run.runId,
          hostId: run.resolvedSelection!.host,
          attempt: 1,
          generation: 1,
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        })
      const dispatch = Effect.fn("RemoteAgent.dispatch")(function* (
        run: import("../kernel/agent-run-store").AgentRunRecord,
        submission: import("../agent-run-contract").AgentRunSubmission,
        now: Date,
      ) {
        if (run.state === "accepted")
          yield* Effect.gen(function* () {
            yield* runs.claimSpawn({ runId: run.runId, now })
            const fragments = agentFragments(`agent-${run.runId}`, {
              runId: run.runId,
              route: run.route,
              submission,
              selection: run.resolvedSelection,
              createdAt: run.createdAt.toISOString(),
            })
            for (const fragment of fragments)
              yield* queue({
                version: 1,
                kind: "agent_launch",
                commandId: `agent-${run.runId}-${fragment.index}`,
                jobId: run.runId,
                hostId: run.resolvedSelection!.host,
                attempt: 1,
                generation: 1,
                issuedAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + options.timeoutMs).toISOString(),
                fragment,
              })
          }).pipe(sql.withTransaction)
        yield* flush().pipe(
          Effect.mapError(
            (error) =>
              new AgentRunRefusalError({
                reason: "run_conflict",
                detail: `remote launch publication uncertain: ${String(error)}`,
                mailboxId: run.callerMailboxId,
              }),
          ),
        )
        const observed = yield* waitFor(run.runId)
        if (observed._tag === "None") {
          yield* cancelCommand(run, new Date())
          return yield* new AgentRunRefusalError({
            reason: "run_conflict",
            detail:
              "remote launch verification timed out; durable cancellation queued, custody retained; retry this run rather than launching a replacement",
            mailboxId: run.callerMailboxId,
          })
        }
        const current = observed.value
        if (
          current === null ||
          current.nativeSessionId === null ||
          current.lastOutputTokens === 0 ||
          current.state === "cancelled"
        )
          return yield* new AgentRunRefusalError({
            reason: current?.diagnostic?.includes("selection_mismatch")
              ? "model_not_available"
              : "run_conflict",
            detail: current?.diagnostic ?? "remote launch refused",
            mailboxId: run.callerMailboxId,
          })
        return {
          nativeSessionId: current.nativeSessionId,
          outputTokens: current.lastOutputTokens,
          kind: run.resolvedSelection!.executorKind,
        }
      })
      const cancel = Effect.fn("RemoteAgent.cancel")(function* (
        run: import("../kernel/agent-run-store").AgentRunRecord,
        now: Date,
      ) {
        yield* cancelCommand(run, now)
        yield* flush()
        const observed = yield* waitFor(run.runId, true, run.state === "operator_required")
        if (observed._tag === "None")
          return yield* new AgentRunRefusalError({
            reason: "run_conflict",
            detail: "remote cancellation pending; custody retained",
            mailboxId: run.callerMailboxId,
          })
        if (observed.value?.state === "operator_required")
          return yield* new AgentRunRefusalError({
            reason: "run_conflict",
            detail: observed.value.diagnostic ?? "remote cancellation unconfirmed",
            mailboxId: run.callerMailboxId,
          })
      })
      // Transport failures stay typed at this boundary; ingress gets actionable refusals.
      const bind = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.mapError((error) =>
            error instanceof AgentRunRefusalError
              ? error
              : new AgentRunRefusalError({ reason: "run_conflict", detail: String(error) }),
          ),
        )
      return RemoteAgentDispatch.of({
        preflight: (host) => bind(preflight(host)),
        dispatch: (run, input, now) => bind(dispatch(run, input, now)),
        cancel: (run, now) => bind(cancel(run, now)),
        flush: () => bind(flush()),
        receive: (result) => bind(receive(result)),
      })
    }),
  )
