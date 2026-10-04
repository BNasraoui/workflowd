import { Effect, Layer, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentRunIngress, AgentRunRefusalError } from "../kernel/agent-run-ingress"
import { AgentRunStore } from "../kernel/agent-run-store"
import { AgentRunWatchdog } from "../kernel/agent-run-watchdog"
import { RemoteAgentLaunch, RemoteAgentState, agentFragments } from "./agent-contract"
import { RemoteAgentRunner } from "./agent-services"
import { initAgentTransfers, receiveAgentFragment } from "./agent-transfer"
import { RemoteResult, type RemoteCommand } from "./contract"
import { RemoteTransport } from "./transport"

export const RemoteAgentRunnerLive = (host: string) =>
  Layer.effect(
    RemoteAgentRunner,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const ingress = yield* AgentRunIngress
      const runs = yield* AgentRunStore
      const transport = yield* RemoteTransport
      const watchdog = yield* Effect.serviceOption(AgentRunWatchdog)
      const ticking = yield* Semaphore.make(1)
      yield* initAgentTransfers
      yield* sql`CREATE TABLE IF NOT EXISTS remote_agent_launches (
    run_id TEXT PRIMARY KEY NOT NULL, document TEXT, state TEXT NOT NULL,
    cancelled INTEGER NOT NULL DEFAULT 0, reported TEXT, expires_at TEXT
  ) STRICT`

      const report = (state: RemoteAgentState) =>
        Effect.gen(function* () {
          // A bounded terminal result is transported whole; oversized answers retain
          // the native session reference instead of overflowing the broker envelope.
          const finalMessage =
            state.finalMessage !== null &&
            (Buffer.byteLength(state.finalMessage) > 131072 ||
              Buffer.byteLength(JSON.stringify(state.finalMessage)) > 700000)
              ? null
              : state.finalMessage
          for (const fragment of agentFragments(`agent-state-${state.runId}-${state.state}`, {
            ...state,
            finalMessage,
          })) {
            const result: RemoteResult = {
              version: 1,
              kind: "agent_state",
              status: "succeeded",
              commandId: `agent-${state.runId}`,
              jobId: state.runId,
              resultId: `${fragment.transferId}-${fragment.index}`,
              hostId: host,
              attempt: 1,
              generation: 1,
              observedAt: new Date().toISOString(),
              fragment,
            }
            yield* sql`INSERT INTO remote_agent_outbox (id,envelope) VALUES (${result.resultId},${JSON.stringify(result)}) ON CONFLICT DO NOTHING`
          }
          yield* sql`UPDATE remote_agent_launches SET reported = ${state.state} WHERE run_id = ${state.runId}`
        }).pipe(sql.withTransaction)
      const stopped = (
        runId: string,
        diagnostic: string,
        state: "cancelled" | "operator_required" = "operator_required",
      ) =>
        report({
          runId,
          state,
          nativeSessionId: null,
          directory: "",
          outputTokens: 0,
          diagnostic,
          finalMessage: null,
        })

      const tick = Effect.fn("RemoteAgentRunner.tick")(function* () {
        if (watchdog._tag === "Some") yield* watchdog.value.iteration
        const rows = yield* sql<{
          run_id: string
          document: string | null
          state: string
          cancelled: number
          reported: string | null
          expires_at: string | null
        }>`SELECT * FROM remote_agent_launches WHERE state != 'terminal' ORDER BY rowid`
        for (const row of rows) {
          let run = yield* runs.read(row.run_id)
          if (row.cancelled === 1) {
            if (run === null || run.state === "accepted") {
              if (
                run === null &&
                (row.reported === "operator_required" || row.state === "launching")
              ) {
                yield* stopped(
                  row.run_id,
                  "remote cancellation unconfirmed: spent launch has no process custody",
                )
                yield* sql`UPDATE remote_agent_launches SET state = 'terminal' WHERE run_id = ${row.run_id}`
                continue
              }
              if (run !== null) yield* runs.cancel({ runId: row.run_id, now: new Date() })
              yield* stopped(row.run_id, "cancelled before launch", "cancelled")
              yield* sql`UPDATE remote_agent_launches SET state = 'terminal' WHERE run_id = ${row.run_id}`
              continue
            }
            if (["spawning", "spawned", "verified", "operator_required"].includes(run.state))
              yield* ingress.cancel(row.run_id, new Date()).pipe(
                Effect.catch((error) =>
                  runs.operatorRequired({
                    runId: row.run_id,
                    now: new Date(),
                    diagnostic: `remote cancellation unconfirmed: ${String(error)}`,
                  }),
                ),
              )
            run = yield* runs.read(row.run_id)
          } else if (row.state === "pending" && row.document !== null) {
            if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now()) {
              yield* stopped(row.run_id, "expired remote launch refused before execution")
              yield* sql`UPDATE remote_agent_launches SET state = 'terminal' WHERE run_id = ${row.run_id}`
              continue
            }
            const launch = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(RemoteAgentLaunch),
            )(row.document)
            const claimed =
              yield* sql`UPDATE remote_agent_launches SET state = 'launching' WHERE run_id = ${row.run_id} AND state = 'pending' RETURNING run_id`
            if (claimed.length === 0) continue
            const outcome = yield* (
              ingress.registerFrozen === undefined
                ? Effect.fail(
                    new AgentRunRefusalError({
                      reason: "executor_unavailable",
                      detail: "runner frozen launch is unavailable",
                    }),
                  )
                : ingress.registerFrozen(launch, new Date())
            ).pipe(Effect.result)
            run = yield* runs.read(row.run_id)
            if (
              outcome._tag === "Failure" &&
              (run === null || !["failed", "cancelled", "operator_required"].includes(run.state))
            ) {
              const diagnostic =
                outcome.failure instanceof AgentRunRefusalError
                  ? `${outcome.failure.reason}: ${outcome.failure.detail}`
                  : String(outcome.failure)
              if (run !== null)
                yield* runs.operatorRequired({ runId: row.run_id, now: new Date(), diagnostic })
              else yield* stopped(row.run_id, diagnostic)
              run = yield* runs.read(row.run_id)
              if (run === null)
                yield* sql`UPDATE remote_agent_launches SET state = 'terminal' WHERE run_id = ${row.run_id}`
            }
            yield* sql`UPDATE remote_agent_launches SET state = 'running' WHERE run_id = ${row.run_id} AND state = 'launching'`
          } else if (row.state === "launching" && (run === null || run.state === "accepted")) {
            // A spent claim with no custody is an uncertain effect, never permission
            // to repeat external execution after a crash.
            if (run === null) {
              yield* stopped(row.run_id, "execution_interrupted: remote launch custody is missing")
              yield* sql`UPDATE remote_agent_launches SET state = 'terminal' WHERE run_id = ${row.run_id}`
            } else {
              yield* runs.operatorRequired({
                runId: run.runId,
                now: new Date(),
                diagnostic:
                  "execution_interrupted: remote launch claim was spent before native custody",
              })
              run = yield* runs.read(row.run_id)
            }
          }
          if (run === null || ["accepted", "spawning", "spawned"].includes(run.state)) continue
          const state = yield* Schema.decodeUnknownEffect(RemoteAgentState)({
            runId: run.runId,
            state: run.state,
            nativeSessionId: run.nativeSessionId,
            directory: run.directory,
            outputTokens: run.lastOutputTokens,
            diagnostic: run.diagnostic,
            finalMessage: null,
          })
          if (row.reported !== state.state) {
            const message = yield* sql<{
              prompt: string
            }>`SELECT prompt FROM resident_inbox WHERE id = ${"agent-run-end-" + row.run_id}`
            const terminal =
              message[0] === undefined
                ? null
                : yield* Schema.decodeUnknownEffect(
                    Schema.fromJsonString(
                      Schema.Struct({ final_message: Schema.NullOr(Schema.String) }),
                    ),
                  )(message[0].prompt)
            yield* report({ ...state, finalMessage: terminal?.final_message ?? null })
          }
          if (state.state !== "verified")
            yield* sql`UPDATE remote_agent_launches SET state = 'terminal' WHERE run_id = ${row.run_id}`
        }
        const outbox = yield* sql<{
          id: string
          envelope: string
        }>`SELECT id,envelope FROM remote_agent_outbox WHERE published = 0 ORDER BY rowid`
        for (const item of outbox) {
          const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RemoteResult))(
            item.envelope,
          )
          yield* transport.publishResult(result)
          yield* sql`UPDATE remote_agent_outbox SET published = 1 WHERE id = ${item.id}`
        }
      })
      const receive = Effect.fn("RemoteAgentRunner.receive")(function* (command: RemoteCommand) {
        if (command.hostId !== host || command.generation !== 1 || command.attempt !== 1) return
        if (command.kind === "agent_cancel") {
          yield* sql`INSERT INTO remote_agent_launches (run_id,state,cancelled) VALUES (${command.jobId},'pending',1)
        ON CONFLICT(run_id) DO UPDATE SET cancelled = 1, state = CASE WHEN state = 'terminal' THEN 'running' ELSE state END`
          return
        }
        if (command.kind !== "agent_launch") return
        const known =
          yield* sql`SELECT run_id FROM remote_agent_launches WHERE run_id = ${command.jobId}`
        if (known.length === 0 && Date.parse(command.expiresAt) <= Date.now()) {
          yield* sql`INSERT INTO remote_agent_launches (run_id,state) VALUES (${command.jobId},'terminal') ON CONFLICT DO NOTHING`
          yield* stopped(command.jobId, "expired remote launch refused")
          return
        }
        yield* Effect.gen(function* () {
          const launch = yield* receiveAgentFragment(command.fragment, RemoteAgentLaunch)
          if (launch === null) return
          if (launch.runId !== command.jobId || launch.selection.host !== host)
            return yield* new AgentRunRefusalError({
              reason: "host_unavailable",
              detail: "remote launch target/identity mismatch",
            })
          const existing = yield* sql<{
            document: string | null
          }>`SELECT document FROM remote_agent_launches WHERE run_id = ${launch.runId}`
          if (existing[0]?.document != null && existing[0].document !== JSON.stringify(launch))
            return yield* new AgentRunRefusalError({
              reason: "run_conflict",
              detail: "remote launch snapshot changed",
            })
          yield* sql`INSERT INTO remote_agent_launches (run_id,document,state,expires_at) VALUES (${launch.runId},${JSON.stringify(launch)},'pending',${command.expiresAt}) ON CONFLICT DO NOTHING`
        }).pipe(sql.withTransaction)
      })
      const bind = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        effect.pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError((error) =>
            error instanceof AgentRunRefusalError
              ? error
              : new AgentRunRefusalError({ reason: "run_conflict", detail: String(error) }),
          ),
        )
      return RemoteAgentRunner.of({
        receive: (command) => bind(receive(command)),
        tick: () => bind(Semaphore.withPermit(ticking)(tick())),
      })
    }),
  )
