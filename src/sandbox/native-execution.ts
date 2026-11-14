import { randomBytes, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { Effect, Exit, Schema, Scope } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { runLifetime } from "../store/run-lifetime"
import { makeNativeResultStore } from "./native-result"
import { SandboxError } from "./store"
import { sandboxSshArguments, type SandboxTransport } from "./transport"
import type { CliEvent, CliPort, CliRunProcess } from "../kernel/cli-process-contract"
import { WorkspaceError } from "../workspace/errors"
import { ownedPromise } from "../capability-gateway/owned"
import { makeCapabilityStore, type CapabilityBinding } from "../capability-gateway/store"

const Invocation = Schema.Struct({
  run_id: Schema.String,
  channel: Schema.String,
  nonce: Schema.String,
  container_nonce: Schema.String,
  predecessor: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  session_id: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  response_sequence: Schema.Int,
  output_tokens: Schema.Int,
  finalize_revision: Schema.NullOr(Schema.Int),
  finalize_claimed: Schema.Int,
  deadline: Schema.Number,
  state: Schema.Literals(["launching", "running", "paused", "uncertain", "stopped"]),
  outcome: Schema.NullOr(
    Schema.Literals(["completed", "paused", "cancelled", "operator_required"]),
  ),
})
const refused = () =>
  new SandboxError({ message: "Native execution custody refused", uncertain: true })

const observations = new WeakMap<object, Map<string, (tokens: number) => void>>()

// Provider progress coalesces into one slot. Lifecycle has only started/closed;
// producer volume can never grow an unbounded observer queue.
function nativeEvents() {
  const pending: CliEvent[] = []
  let closed = false,
    wake: (() => void) | undefined
  return {
    push(event: CliEvent) {
      if (closed) return
      const prior = pending.findIndex((value) => value.type === "provider.response")
      if (event.type === "provider.response" && prior !== -1) pending[prior] = event
      else {
        if (pending.length >= 8) throw new Error("Native observer capacity")
        pending.push(event)
      }
      wake?.()
      wake = undefined
    },
    close() {
      closed = true
      wake?.()
      wake = undefined
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (!closed || pending.length) {
          if (pending.length) yield pending.shift()!
          else
            await new Promise<void>((resolve) => {
              wake = resolve
            })
        }
      },
    },
  }
}

/** A durable intent precedes every remote side effect. Lost acknowledgements never replay prompts. */
export const makeNativeExecutionStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const lifetime = runLifetime(sql)
  // rc.112 masks acquisition and gives each wrapper a private nesting semaphore.
  // Only native roots use interruptible reservation; their bodies use plain SQL.
  const rootTransaction = SqlClient.makeWithTransaction({
    transactionService: sql.transactionService,
    spanAttributes: [],
    acquireConnection: Effect.gen(function* () {
      const scope = yield* Scope.make()
      const connection = yield* sql.reserve.pipe(
        Scope.provide(scope),
        Effect.interruptible,
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
      )
      return [scope, connection] as const
    }),
    begin: (connection) => connection.executeUnprepared("BEGIN IMMEDIATE", [], undefined),
    savepoint: (connection, id) =>
      connection.executeUnprepared(`SAVEPOINT effect_native_${id}`, [], undefined),
    commit: (connection) => connection.executeUnprepared("COMMIT", [], undefined),
    rollback: (connection) => connection.executeUnprepared("ROLLBACK", [], undefined),
    rollbackSavepoint: (connection, id) =>
      connection.executeUnprepared(`ROLLBACK TO SAVEPOINT effect_native_${id}`, [], undefined),
  })
  const transaction: typeof sql.withTransaction = (effect) =>
    Effect.flatMap(Effect.serviceOption(sql.transactionService), (current) =>
      current._tag === "Some" ? sql.withTransaction(effect) : rootTransaction(effect),
    )
  let listeners = observations.get(sql)
  if (!listeners) {
    listeners = new Map()
    observations.set(sql, listeners)
  }
  const observeResponse = Effect.fn("NativeExecution.observeResponse")(function* (
    runId: string,
    nonce: string,
    model: string,
    tokens: number,
  ) {
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 10000000)
      return yield* Effect.fail(refused())
    const rows = yield* sql.withTransaction(
      sql`UPDATE sandbox_native_executions SET response_sequence=response_sequence+1,output_tokens=output_tokens+${tokens}
      WHERE run_id=${runId} AND nonce=${nonce} AND model=${model} AND state IN ('launching','running') AND deadline>${Date.now()}
      AND output_tokens+${tokens}<=1000000000
       AND EXISTS(SELECT 1 FROM capability_bindings b WHERE b.run_id=${runId} AND b.revoked=0) RETURNING output_tokens`,
    )
    if (rows.length !== 1) return yield* Effect.fail(refused())
    listeners.get(runId)?.(Number(rows[0]!.output_tokens))
  })
  const listen = (runId: string, receive: (tokens: number) => void) => {
    if (listeners.has(runId)) throw refused()
    listeners.set(runId, receive)
    return () => listeners.delete(runId)
  }
  const results = yield* makeNativeResultStore
  const capabilities = yield* makeCapabilityStore
  const read = Effect.fn("NativeExecution.read")(function* (runId: string) {
    const rows = yield* sql`SELECT * FROM sandbox_native_executions WHERE run_id=${runId}`
    return rows.length === 0 ? null : yield* Schema.decodeUnknownEffect(Invocation)(rows[0])
  })
  const reserve = Effect.fn("NativeExecution.reserve")((runId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if ((yield* read(runId)) !== null) return yield* Effect.fail(refused())
        const nonce = randomBytes(32).toString("hex")
        const session = randomUUID()
        const inserted =
          yield* sql`INSERT INTO sandbox_native_executions(run_id,channel,nonce,container_nonce,session_id,model,effort,deadline,state)
      SELECT b.run_id,b.channel,${nonce},${nonce},${session},json_extract(b.authority,'$.modelId'),
        coalesce(json_extract(r.resolved_selection,'$.thinking.effort'),'high'),l.deadline,'launching'
      FROM capability_bindings b JOIN sandbox_leases l ON l.run_id=b.run_id
      JOIN kernel_agent_runs r ON r.run_id=b.run_id
      WHERE b.run_id=${runId} AND b.revoked=0 AND b.jti_digest IS NOT NULL
        AND l.state='ready' AND l.deadline>${Date.now()} AND r.state IN ('spawning','spawned','verified')
      RETURNING *`
        if (inserted.length !== 1) return yield* Effect.fail(refused())
        return yield* Schema.decodeUnknownEffect(Invocation)(inserted[0])
      }),
    ),
  )
  const resume = Effect.fn("NativeExecution.resume")(function* (
    runId: string,
    predecessor: string,
  ) {
    const rows =
      yield* sql`UPDATE sandbox_native_executions SET predecessor=nonce,nonce=${randomBytes(32).toString("hex")},
      generation=generation+1,response_sequence=0,state='launching',outcome=NULL
      WHERE run_id=${runId} AND nonce=${predecessor} AND state='paused' AND outcome='paused' AND deadline>${Date.now()} AND generation<100 AND finalize_revision IS NULL
      AND EXISTS(SELECT 1 FROM capability_bindings b JOIN sandbox_leases l ON l.run_id=b.run_id JOIN kernel_agent_runs r ON r.run_id=b.run_id
        WHERE b.run_id=${runId} AND b.revoked=0 AND l.state='ready' AND l.deadline=sandbox_native_executions.deadline
        AND r.state IN ('spawning','spawned','verified'))
      AND NOT EXISTS(SELECT 1 FROM sandbox_native_results WHERE run_id=${runId} AND frozen=1) RETURNING *`
    if (rows.length !== 1) return yield* Effect.fail(refused())
    return yield* Schema.decodeUnknownEffect(Invocation)(rows[0])
  })
  const acknowledge = Effect.fn("NativeExecution.acknowledge")(function* (
    runId: string,
    nonce: string,
    session?: string,
  ) {
    if (session !== undefined && !/^(?:[a-f0-9-]{36}|ses_[A-Za-z0-9]{20,64})$/.test(session))
      return yield* Effect.fail(refused())
    yield* transaction(
      Effect.gen(function* () {
        const rows =
          yield* sql`UPDATE sandbox_native_executions SET state='running',session_id=coalesce(${session ?? null},session_id)
      WHERE run_id=${runId} AND nonce=${nonce} AND state='launching' AND deadline>${Date.now()}
      AND (${session ?? null} IS NULL OR generation=1 OR session_id=${session ?? null})
      AND EXISTS(SELECT 1 FROM capability_bindings b WHERE b.run_id=${runId} AND b.revoked=0) RETURNING run_id`
        if (rows.length !== 1) return yield* Effect.fail(refused())
        if (session !== undefined) {
          const attached =
            yield* sql`UPDATE sandbox_leases SET session_id=${session} WHERE run_id=${runId} AND state='ready'
        AND NOT EXISTS(SELECT 1 FROM sandbox_leases other WHERE other.run_id!=${runId} AND other.session_id=${session}) RETURNING run_id`
          if (attached.length !== 1) return yield* Effect.fail(refused())
        }
      }),
    )
  })
  const requestFinalization = Effect.fn("NativeExecution.requestFinalization")(function* (
    binding: CapabilityBinding,
    nonce: string,
    generation: number,
    revision: number,
  ) {
    const rows = yield* sql`UPDATE sandbox_native_executions SET finalize_revision=${revision}
      WHERE run_id=${binding.runId} AND channel=${binding.channel} AND nonce=${nonce} AND generation=${generation}
      AND state='running' AND deadline>${Date.now()} AND response_sequence>0
      AND (finalize_revision IS NULL OR finalize_revision=${revision})
      AND EXISTS(SELECT 1 FROM sandbox_native_results r WHERE r.run_id=${binding.runId}
        AND r.channel=${binding.channel} AND r.revision=${revision} AND r.frozen=0) RETURNING finalize_revision`
    return rows.length === 1 ? revision : null
  })
  const claimFinalization = Effect.fn("NativeExecution.claimFinalization")((runId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const invocation = yield* read(runId)
        if (
          !invocation ||
          invocation.finalize_revision === null ||
          invocation.finalize_claimed ||
          invocation.state !== "running"
        )
          return null
        const authority = yield* capabilities.validateBinding(
          { runId, channel: invocation.channel },
          Date.now(),
        )
        if (invocation.model !== authority.modelId) return yield* Effect.fail(refused())
        const rows = yield* sql`UPDATE sandbox_native_executions SET finalize_claimed=1
        WHERE run_id=${runId} AND nonce=${invocation.nonce} AND generation=${invocation.generation}
        AND state='running' AND deadline>${Date.now()} AND finalize_claimed=0
        AND EXISTS(SELECT 1 FROM sandbox_native_results r WHERE r.run_id=${runId}
          AND r.channel=sandbox_native_executions.channel AND r.revision=sandbox_native_executions.finalize_revision AND r.frozen=0)
        RETURNING *`
        return rows.length === 1 ? yield* Schema.decodeUnknownEffect(Invocation)(rows[0]) : null
      }),
    ),
  )
  const uncertain = Effect.fn("NativeExecution.uncertain")((runId: string) =>
    lifetime.change(
      runId,
      Effect.gen(function* () {
        yield* sql`UPDATE capability_bindings SET revoked=1 WHERE run_id=${runId}`
        yield* sql`UPDATE sandbox_native_executions SET state='uncertain' WHERE run_id=${runId} AND state!='stopped'`
      }),
      transaction,
    ),
  )
  const closed = Effect.fn("NativeExecution.closed")(
    (
      runId: string,
      nonce: string,
      outcome: "completed" | "paused" | "cancelled" | "operator_required",
      revision: number | null,
    ) =>
      lifetime.change(
        runId,
        Effect.gen(function* () {
          const invocation = yield* read(runId)
          if (!invocation || invocation.nonce !== nonce) return yield* Effect.fail(refused())
          if (outcome === "paused") {
            if (invocation.state !== "running" || invocation.deadline <= Date.now())
              return yield* Effect.fail(refused())
            const paused =
              yield* sql`UPDATE sandbox_native_executions SET state='paused',outcome='paused'
              WHERE run_id=${runId} AND finalize_revision IS NULL AND EXISTS(SELECT 1 FROM capability_bindings WHERE run_id=${runId} AND revoked=0) RETURNING run_id`
            if (paused.length !== 1) return yield* Effect.fail(refused())
            return
          }
          const result = yield* results.read(runId)
          if (
            outcome === "completed" &&
            (!["running", "stopped"].includes(invocation.state) ||
              !result ||
              result.channel !== invocation.channel ||
              result.revision !== revision)
          )
            return yield* Effect.fail(refused())
          if (invocation.state === "stopped" && invocation.outcome !== outcome)
            return yield* Effect.fail(refused())
          yield* sql`UPDATE sandbox_native_results SET frozen=1 WHERE run_id=${runId}`
          yield* sql`UPDATE capability_bindings SET revoked=1 WHERE run_id=${runId}`
          yield* sql`UPDATE sandbox_native_executions SET state='stopped',outcome=${outcome} WHERE run_id=${runId}`
        }),
        transaction,
      ),
  )
  return {
    reserve,
    resume,
    acknowledge,
    uncertain,
    closed,
    read,
    observeResponse,
    listen,
    requestFinalization,
    claimFinalization,
  }
})

const NativeEvent = Schema.Struct({
  event: Schema.Literals(["started", "closed"]),
  nonce: Schema.String,
  session: Schema.String,
  outcome: Schema.optionalKey(
    Schema.Literals(["completed", "paused", "cancelled", "operator_required"]),
  ),
  stopped: Schema.optionalKey(Schema.Boolean),
})
const nativeFailure = (
  cause: unknown = new Error("Native execution unconfirmed; custody retained"),
) =>
  new WorkspaceError({
    operation: "native sandbox custody",
    cause: cause instanceof Error ? cause : new Error("Native custody failed", { cause }),
  })
const completionInstructions =
  "Work in /workdir. Submit a result candidate by running python3 /opt/workflowd/claude-interactive.py submit with JSON on stdin: " +
  '{"revision":0,"completion":{"branch":"your chosen valid branch","title":"PR title","commitMessage":"squash message","body":"Markdown description"}}. ' +
  "A successful response returns the new revision. Correct mistakes by submitting another candidate using that revision; identical retries are idempotent. " +
  'When the latest candidate is ready, request finalization through the same helper with JSON {"operation":"finalize","revision":LATEST_REVISION}. ' +
  "This selects that exact candidate and ends corrections. Stop work after requesting finalization. The controller will close the native process, stop the container, and capture before publication. " +
  "Submission alone does not finish the task. Finalization is a request, not proof of completion or publication approval. Do not push.\n\n"

/** One scoped SSH invocation. Attach never launches or resends a prompt. */
export const makeNativeCli = (options: {
  runId: string
  invocation: typeof Invocation.Type
  transport: SandboxTransport
  sshArguments?: ReadonlyArray<string>
  client?: "claude" | "codex" | "opencode"
  provider?: string
}) =>
  Effect.gen(function* () {
    const store = yield* makeNativeExecutionStore
    const results = yield* makeNativeResultStore
    let process: CliRunProcess | null = null
    let launched = false
    yield* Effect.addFinalizer(() =>
      process === null ? Effect.void : process.cancel.pipe(Effect.orDie),
    )
    const cli: CliPort = {
      ownership: "transient-exec",
      preflight: Effect.void,
      executionId: () => options.invocation.session_id,
      attach: ({ runId }) =>
        runId === options.runId ? Effect.succeed(process) : Effect.fail(nativeFailure()),
      spawn: (input) =>
        Effect.gen(function* () {
          const saved = yield* store.read(options.runId)
          if (
            launched ||
            input.runId !== options.runId ||
            input.model !== options.invocation.model ||
            saved?.nonce !== options.invocation.nonce ||
            saved.state !== "launching"
          )
            return yield* Effect.fail(nativeFailure())
          launched = true
          const args = [
            ...(options.sshArguments ?? sandboxSshArguments(options.transport).slice(0, -1)),
            "exec /usr/local/bin/runner-control native-execute",
          ]
          const child = spawn(args[0]!, args.slice(1), {
            env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
            stdio: ["pipe", "pipe", "pipe"],
          })
          const exited = new Promise<number>((resolve) => {
            child.once("error", () => resolve(-1))
            child.once("exit", (code) => resolve(code ?? -1))
          })
          child.stdin.on("error", () => {})
          const queue = nativeEvents()
          let tokens = 0
          let revision: number | null = null
          let pauseRequested = false
          const unlisten = store.listen(input.runId, (count) => {
            tokens = count
            queue.push({ type: "provider.response", model: saved.model, outputTokens: count })
          })
          let confirmed = false
          let session = saved.session_id
          let started = false
          let closureReceived = false
          const pumpLifetime = new AbortController()
          const persist = <A, E>(effect: Effect.Effect<A, E>, signal = pumpLifetime.signal) =>
            Effect.runPromise(effect.pipe(Effect.timeout("2 seconds")), { signal })
          const stop = () => {
            pumpLifetime.abort()
            child.kill("SIGKILL")
          }
          const stderr = (async () => {
            let bytes = 0
            for await (const chunk of child.stderr) {
              if (!Buffer.isBuffer(chunk)) throw new Error("Invalid SSH diagnostics")
              bytes += chunk.length
              if (bytes > 4096) throw new Error("SSH diagnostic capacity")
            }
            return true
          })().catch(() => {
            child.kill("SIGKILL")
            return false
          })
          const pump = (async () => {
            let buffer = "",
              count = 0
            let outcome: "completed" | "paused" | "cancelled" | "operator_required" | undefined
            try {
              for await (const chunk of child.stdout) {
                if (!Buffer.isBuffer(chunk)) throw new Error("Invalid SSH control")
                buffer += chunk.toString("utf8")
                if (buffer.length > 65536) throw new Error("Native control capacity")
                let boundary
                while ((boundary = buffer.indexOf("\n")) !== -1) {
                  const line = buffer.slice(0, boundary)
                  buffer = buffer.slice(boundary + 1)
                  const event = await Effect.runPromise(
                    Schema.decodeUnknownEffect(Schema.fromJsonString(NativeEvent))(line, {
                      onExcessProperty: "error",
                    }),
                  )
                  if (
                    ++count > 32 ||
                    event.nonce !== saved.nonce ||
                    ((started ||
                      options.client === undefined ||
                      options.client === "claude" ||
                      saved.generation > 1) &&
                      event.session !== session) ||
                    closureReceived
                  )
                    throw new Error("Native receipt binding refused")
                  if (event.event === "started" && !started) {
                    await persist(store.acknowledge(input.runId, saved.nonce, event.session))
                    session = event.session
                    started = true
                    queue.push({
                      type: "thread.started",
                      threadId: session,
                    })
                  } else if (
                    event.event === "closed" &&
                    event.stopped === true &&
                    event.outcome !== undefined
                  ) {
                    outcome =
                      event.outcome === "completed" && revision === null
                        ? "operator_required"
                        : event.outcome === "paused" && !pauseRequested
                          ? "operator_required"
                          : event.outcome
                    closureReceived = true
                  } else throw new Error("Native lifecycle refused")
                }
              }
              if (buffer || !closureReceived || !outcome || (await exited) !== 0 || !(await stderr))
                throw new Error("Native closure unconfirmed")
              await persist(store.closed(input.runId, saved.nonce, outcome, revision))
              confirmed = true
              if (outcome === "completed")
                queue.push({ type: "turn.completed", outputTokens: tokens })
              else if (outcome !== "paused")
                queue.push({ type: "turn.failed", message: "Native execution did not complete" })
              return {
                exitCode: outcome === "completed" || outcome === "paused" ? 0 : 1,
                stderr: "",
                ...(outcome === "paused" ? { paused: true as const } : {}),
              }
            } catch (cause) {
              child.kill("SIGKILL")
              try {
                await persist(store.uncertain(input.runId))
              } catch (durableFailure) {
                throw nativeFailure(
                  new AggregateError([cause, durableFailure], "Native custody unconfirmed"),
                )
              } finally {
                child.kill("SIGKILL")
                await exited
                await stderr
              }
              throw nativeFailure(cause)
            } finally {
              unlisten()
              queue.close()
            }
          })()
          // Install a handler immediately; exited still exposes the original failure.
          void pump.catch(() => undefined)
          child.stdin.write(
            JSON.stringify({
              nonce: saved.nonce,
              container: saved.container_nonce,
              predecessor: saved.predecessor,
              resume: saved.generation > 1,
              session: saved.session_id,
              deadline: saved.deadline,
              model: saved.model,
              effort: saved.effort,
              prompt: (saved.generation === 1 ? completionInstructions : "") + input.prompt,
              ...(options.client === undefined || options.client === "claude"
                ? {}
                : { client: options.client, provider: options.provider }),
            }) + "\n",
          )
          const cancel = ownedPromise(async (signal) => {
            signal.addEventListener("abort", stop, { once: true })
            try {
              signal.throwIfAborted()
              if (!confirmed) {
                await persist(store.uncertain(input.runId), signal)
                child.stdin.write('{"operation":"cancel"}\n')
              }
              await pump
            } finally {
              signal.removeEventListener("abort", stop)
              // A failed durable mark must never bypass owned-process teardown.
              stop()
              await exited
              await pump.catch(() => undefined)
              await stderr
            }
          }).pipe(Effect.timeout("15 seconds"), Effect.mapError(nativeFailure))
          process = {
            executionId: saved.session_id,
            events: queue.iterable,
            cancel,
            pause: Effect.gen(function* () {
              const current = yield* store.read(input.runId)
              if (
                confirmed ||
                closureReceived ||
                revision !== null ||
                pauseRequested ||
                current?.state !== "running" ||
                current.finalize_revision !== null ||
                current.nonce !== saved.nonce
              )
                return yield* Effect.fail(nativeFailure())
              pauseRequested = true
              child.stdin.write('{"operation":"pause"}\n')
              yield* ownedPromise(async (signal) => {
                signal.addEventListener("abort", stop, { once: true })
                try {
                  signal.throwIfAborted()
                  await pump
                } finally {
                  signal.removeEventListener("abort", stop)
                }
              }).pipe(Effect.timeout("15 seconds"))
            }).pipe(Effect.timeout("15 seconds"), Effect.mapError(nativeFailure)),
            finish: (selectedRevision) =>
              Effect.gen(function* () {
                const current = yield* store.read(input.runId)
                const candidate = yield* results.read(input.runId)
                if (
                  confirmed ||
                  closureReceived ||
                  pauseRequested ||
                  revision !== null ||
                  current?.state !== "running" ||
                  current.nonce !== saved.nonce ||
                  current.response_sequence <= 0 ||
                  !candidate ||
                  candidate.frozen ||
                  candidate.channel !== saved.channel ||
                  candidate.revision !== selectedRevision
                )
                  return yield* Effect.fail(nativeFailure())
                revision = selectedRevision
                child.stdin.write('{"operation":"finish"}\n')
              }).pipe(Effect.timeout("2 seconds"), Effect.mapError(nativeFailure)),
            exited: Effect.tryPromise({ try: () => pump, catch: nativeFailure }),
          }
          return process
        }).pipe(Effect.mapError(nativeFailure)),
    }
    return cli
  })
