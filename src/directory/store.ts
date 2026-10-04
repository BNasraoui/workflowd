import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  AgentRecipient,
  DirectoryError,
  ExternalRegistration,
  type RegistrationReceipt,
  runnerIdForHost,
} from "./contract"
import { externalRecipientId } from "./proof"
import { canonicalJson } from "../kernel/session-store-support"
import { claimExternalOwner } from "./ownership"

export const DirectoryStore = Context.Service<{
  readonly bindLocalHost: (hostId: string) => Effect.Effect<void, DirectoryError>
  readonly unavailableManaged: (
    runId: string,
    nativeSessionId: string,
  ) => Effect.Effect<void, DirectoryError>
  readonly invalidateResidentBindings: (runId?: string) => Effect.Effect<void, DirectoryError>
  readonly observeManaged: (
    runId: string,
    nativeSessionId: string,
    now: Date,
  ) => Effect.Effect<void, DirectoryError>
  readonly managed: (
    now: Date,
    leaseMs: number,
  ) => Effect.Effect<ReadonlyArray<AgentRecipient>, DirectoryError>
  readonly external: (now: Date) => Effect.Effect<ReadonlyArray<AgentRecipient>, DirectoryError>
  readonly registrations: () => Effect.Effect<ReadonlyArray<ExternalRegistration>, DirectoryError>
  readonly registerExternal: (
    input: ExternalRegistration,
    now: Date,
    leaseMs: number,
  ) => Effect.Effect<RegistrationReceipt, DirectoryError>
  readonly externalUnavailable: (input: ExternalRegistration) => Effect.Effect<void, DirectoryError>
}>("workflowd/DirectoryStore")

export const DirectoryStoreLive = Layer.effect(
  DirectoryStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const bindLocalHost = Effect.fn("DirectoryStore.bindLocalHost")(
      function* (hostId: string) {
        yield* sql`INSERT INTO directory_local_identity(singleton, host_id) VALUES(1, ${hostId}) ON CONFLICT DO NOTHING`
        const rows = yield* sql`SELECT host_id FROM directory_local_identity WHERE singleton = 1`
        if (rows[0]?.host_id !== hostId)
          return yield* Effect.fail(new DirectoryError({ reason: "ownership_conflict" }))
        yield* sql`INSERT INTO directory_managed(run_id, recipient_id, host_id)
      SELECT r.run_id, 'managed:' || ${hostId} || ':' || r.run_id, ${hostId} FROM kernel_agent_runs r
      WHERE NOT EXISTS (SELECT 1 FROM kernel_sessions s WHERE s.session_id = r.session_id AND s.owning_host_id <> ${hostId})
      ON CONFLICT DO NOTHING`
      },
      (effect) =>
        effect.pipe(
          sql.withTransaction,
          Effect.mapError((error) =>
            error instanceof DirectoryError ? error : new DirectoryError({ reason: "unavailable" }),
          ),
        ),
    )
    const managed = Effect.fn("DirectoryStore.managed")(
      function* (now: Date, leaseMs: number) {
        const rows =
          yield* sql`SELECT d.*, r.state, r.executor_kind, r.native_session_id, r.updated_at, r.last_progress_at, r.resource_id, r.directory,
      s.provider_kind, s.resource_id AS custody_resource_id, s.endpoint_identity, s.state AS session_state, s.native_session_id AS custody_native_session_id, w.state AS resource_state, w.absolute_path,
      t.thread_id, t.closure_confirmed, t.state AS thread_state
      FROM directory_managed d JOIN kernel_agent_runs r ON r.run_id = d.run_id
      LEFT JOIN kernel_sessions s ON s.session_id = r.session_id AND s.owning_host_id = d.host_id
      LEFT JOIN kernel_working_resources w ON w.resource_id = s.resource_id AND w.owning_host_id = d.host_id
      LEFT JOIN resident_threads t ON t.run_id = r.run_id ORDER BY d.recipient_id`
        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const value = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                recipient_id: Schema.String,
                host_id: Schema.String,
                run_id: Schema.String,
                state: Schema.String,
                executor_kind: Schema.Literals(["opencode", "codex", "claude"]),
                provider_kind: Schema.NullOr(Schema.String),
                resource_id: Schema.NullOr(Schema.String),
                custody_resource_id: Schema.NullOr(Schema.String),
                directory: Schema.String,
                absolute_path: Schema.NullOr(Schema.String),
                native_session_id: Schema.NullOr(Schema.String),
                updated_at: Schema.String,
                last_progress_at: Schema.NullOr(Schema.String),
                endpoint_observed_at: Schema.NullOr(Schema.String),
                verified_native_session_id: Schema.NullOr(Schema.String),
                binding_version: Schema.Int,
                endpoint_identity: Schema.NullOr(Schema.String),
                session_state: Schema.NullOr(Schema.String),
                custody_native_session_id: Schema.NullOr(Schema.String),
                resource_state: Schema.NullOr(Schema.String),
                thread_id: Schema.NullOr(Schema.String),
                closure_confirmed: Schema.NullOr(Schema.Int),
                thread_state: Schema.NullOr(Schema.String),
              }),
            )(row)
            const observedAt =
              value.endpoint_observed_at !== null ? value.endpoint_observed_at : value.updated_at
            const expiresAt = new Date(Date.parse(observedAt) + leaseMs).toISOString()
            const verifiedBinding =
              value.native_session_id !== null &&
              value.native_session_id === value.verified_native_session_id &&
              value.native_session_id === value.custody_native_session_id &&
              value.executor_kind === value.provider_kind &&
              value.resource_id === value.custody_resource_id &&
              value.directory === value.absolute_path &&
              (value.executor_kind !== "codex" ||
                value.thread_id === null ||
                value.thread_id === value.native_session_id) &&
              value.resource_state === "reserved" &&
              (value.session_state === "ready" || value.session_state === "active")
            const status =
              value.state === "accepted"
                ? "accepted"
                : value.state === "spawning" || value.state === "spawned"
                  ? "launching"
                  : value.state !== "verified" || !verifiedBinding
                    ? "unavailable"
                    : Date.parse(expiresAt) <= now.getTime()
                      ? "expired"
                      : "active"
            const transport =
              value.executor_kind === "opencode"
                ? "opencode-http"
                : value.executor_kind === "codex" && value.thread_id !== null
                  ? "codex-app-server"
                  : "cli-session"
            const endpoint =
              value.state === "verified" &&
              verifiedBinding &&
              value.native_session_id !== null &&
              value.endpoint_identity !== null
                ? ({
                    harness: value.executor_kind,
                    transport,
                    address: value.endpoint_identity,
                    nativeSessionId: value.native_session_id,
                  } as const)
                : null
            return yield* Schema.decodeUnknownEffect(AgentRecipient)({
              recipientId: value.recipient_id,
              hostId: value.host_id,
              runnerId: runnerIdForHost(value.host_id),
              origin: "managed",
              runId: value.run_id,
              status,
              endpoint,
              bindingVersion: value.binding_version,
              observedAt,
              expiresAt,
              deliverable:
                status === "active" &&
                endpoint !== null &&
                (transport === "opencode-http"
                  ? value.session_state === "ready" || value.session_state === "active"
                  : transport === "codex-app-server" &&
                    value.closure_confirmed === 0 &&
                    (value.thread_state === "active" || value.thread_state === "waiting")),
            })
          }),
        )
      },
      (effect) => effect.pipe(Effect.mapError(() => new DirectoryError({ reason: "unavailable" }))),
    )
    const observeManaged = Effect.fn("DirectoryStore.observeManaged")(
      function* (runId: string, nativeSessionId: string, now: Date) {
        yield* sql`UPDATE directory_managed SET verified_native_session_id = ${nativeSessionId}, endpoint_observed_at = ${now.toISOString()}
          WHERE run_id = ${runId} AND (endpoint_observed_at IS NULL OR endpoint_observed_at <= ${now.toISOString()}) AND EXISTS (
            SELECT 1 FROM kernel_agent_runs r
            JOIN kernel_sessions s ON s.session_id = r.session_id AND s.native_session_id = r.native_session_id AND s.owning_host_id = directory_managed.host_id
            JOIN kernel_working_resources w ON w.resource_id = s.resource_id AND w.owning_host_id = directory_managed.host_id
            LEFT JOIN resident_threads t ON t.run_id = r.run_id
            WHERE r.run_id = directory_managed.run_id AND r.native_session_id = ${nativeSessionId} AND r.state = 'verified'
              AND r.executor_kind = s.provider_kind AND r.resource_id = s.resource_id AND r.directory = w.absolute_path
              AND s.state IN ('ready','active') AND w.state = 'reserved'
              AND (r.executor_kind = 'opencode' OR (t.provider_kind = 'codex' AND t.thread_id = ${nativeSessionId} AND t.closure_confirmed = 0 AND t.state IN ('active','waiting')))
          )`
      },
      (effect) => effect.pipe(Effect.mapError(() => new DirectoryError({ reason: "unavailable" }))),
    )
    const invalidateResidentBindings = Effect.fn("DirectoryStore.invalidateResidentBindings")(
      (runId?: string) =>
        sql`UPDATE directory_managed SET verified_native_session_id = NULL, endpoint_observed_at = NULL WHERE run_id IN (SELECT run_id FROM resident_threads WHERE provider_kind = 'codex') AND (${runId ?? null} IS NULL OR run_id = ${runId ?? null})`.pipe(
          Effect.asVoid,
        ),
      (effect) => effect.pipe(Effect.mapError(() => new DirectoryError({ reason: "unavailable" }))),
    )
    const unavailableManaged = Effect.fn("DirectoryStore.unavailableManaged")(
      (runId: string, nativeSessionId: string) =>
        sql`UPDATE directory_managed SET verified_native_session_id = NULL
        WHERE run_id = ${runId} AND EXISTS (SELECT 1 FROM kernel_agent_runs r WHERE r.run_id = directory_managed.run_id AND r.native_session_id = ${nativeSessionId})`.pipe(
          Effect.asVoid,
        ),
      (effect) => effect.pipe(Effect.mapError(() => new DirectoryError({ reason: "unavailable" }))),
    )
    const externalRows = () =>
      sql`SELECT e.* FROM directory_external e JOIN directory_owner_bindings o ON o.recipient_id = e.recipient_id AND o.host_id = e.host_id AND o.revision = e.revision ORDER BY e.recipient_id`.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            Schema.decodeUnknownEffect(
              Schema.Struct({
                recipient_id: Schema.String,
                registration_json: Schema.String,
                observed_at: Schema.String,
                expires_at: Schema.String,
                unavailable: Schema.Int,
              }),
            )(row).pipe(
              Effect.flatMap((value) =>
                Schema.decodeUnknownEffect(Schema.fromJsonString(ExternalRegistration))(
                  value.registration_json,
                ).pipe(Effect.map((registration) => ({ ...value, registration }))),
              ),
            ),
          ),
        ),
      )
    const external = Effect.fn("DirectoryStore.external")(
      function* (now: Date) {
        return (yield* externalRows()).map((row): AgentRecipient => ({
          recipientId: row.recipient_id,
          hostId: row.registration.hostId,
          runnerId: runnerIdForHost(row.registration.hostId),
          origin: "external",
          runId: null,
          status:
            row.unavailable === 1
              ? "unavailable"
              : Date.parse(row.expires_at) <= now.getTime()
                ? "expired"
                : "active",
          endpoint: row.registration.endpoint,
          bindingVersion: row.registration.revision,
          observedAt: row.observed_at,
          expiresAt: row.expires_at,
          deliverable: row.unavailable === 0 && Date.parse(row.expires_at) > now.getTime(),
        }))
      },
      (effect) => effect.pipe(Effect.mapError(() => new DirectoryError({ reason: "unavailable" }))),
    )
    const registerExternal = Effect.fn("DirectoryStore.registerExternal")(
      function* (input: ExternalRegistration, now: Date, leaseMs: number) {
        const recipientId = externalRecipientId(input.publicKey)
        if (!(yield* claimExternalOwner(sql, input)))
          return yield* Effect.fail(new DirectoryError({ reason: "stale_binding" }))
        const rows =
          yield* sql`SELECT revision, registration_json FROM directory_external WHERE recipient_id = ${recipientId}`
        const existing = rows[0]
        if (
          existing !== undefined &&
          (typeof existing.revision !== "number" ||
            existing.revision > input.revision ||
            (existing.revision === input.revision &&
              existing.registration_json !== canonicalJson(input)))
        )
          return yield* Effect.fail(new DirectoryError({ reason: "stale_binding" }))
        const collisions =
          yield* sql`SELECT recipient_id FROM directory_external WHERE endpoint_address = ${input.endpoint.address} AND recipient_id <> ${recipientId}`
        if (collisions.length > 0)
          return yield* Effect.fail(new DirectoryError({ reason: "ownership_conflict" }))
        yield* sql`INSERT INTO directory_external(recipient_id,host_id,revision,registration_json,endpoint_address,observed_at,expires_at)
      VALUES(${recipientId},${input.hostId},${input.revision},${canonicalJson(input)},${input.endpoint.address},${now.toISOString()},${new Date(now.getTime() + leaseMs).toISOString()})
      ON CONFLICT(recipient_id) DO UPDATE SET host_id = excluded.host_id, revision = excluded.revision, registration_json = excluded.registration_json,
      endpoint_address = excluded.endpoint_address, observed_at = excluded.observed_at, expires_at = excluded.expires_at, unavailable = 0`
        return {
          recipientId,
          status:
            existing !== undefined && existing.revision === input.revision
              ? ("duplicate" as const)
              : ("registered" as const),
        }
      },
      (effect) =>
        effect.pipe(
          sql.withTransaction,
          Effect.mapError((error) =>
            error instanceof DirectoryError ? error : new DirectoryError({ reason: "unavailable" }),
          ),
        ),
    )
    const externalUnavailable = Effect.fn("DirectoryStore.externalUnavailable")(
      (input: ExternalRegistration) =>
        sql`UPDATE directory_external SET unavailable = 1 WHERE recipient_id = ${externalRecipientId(input.publicKey)} AND registration_json = ${canonicalJson(input)}`.pipe(
          Effect.asVoid,
          Effect.mapError(() => new DirectoryError({ reason: "unavailable" })),
        ),
    )
    return DirectoryStore.of({
      observeManaged,
      unavailableManaged,
      invalidateResidentBindings,
      bindLocalHost,
      managed,
      external,
      registerExternal,
      externalUnavailable,
      registrations: Effect.fn("DirectoryStore.registrations")(() =>
        externalRows().pipe(
          Effect.map((rows) => rows.map((row) => row.registration)),
          Effect.mapError(() => new DirectoryError({ reason: "unavailable" })),
        ),
      ),
    })
  }),
)
