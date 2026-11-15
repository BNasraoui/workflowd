import { createHash, randomBytes } from "node:crypto"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SandboxTransport } from "../sandbox/transport"
import { authorizeWorker } from "../worker-identity/access"

export class CapabilityRefused extends Schema.TaggedError<CapabilityRefused>()(
  "CapabilityRefused",
  {},
) {}
export const capabilityDigest = (value: string) => createHash("sha256").update(value).digest("hex")
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Authority = Schema.Struct({
  runId: Schema.String,
  recipientId: Schema.String,
  attempt: Schema.Int,
  repository: Schema.String,
  repositoryId: Schema.Int,
  repositoryName: Schema.String,
  installationId: Schema.Int,
  sourceSha: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
  peerId: Schema.String,
  actionsRunId: Schema.Int,
  actionsAttempt: Schema.Int,
  deadline: Schema.Number,
})
const Binding = Schema.Struct({ runId: Schema.String, channel: Digest })
const SessionPolicy = Schema.Struct({
  privateBootstrap: Schema.Struct({
    mode: Schema.Literal("actions-native"),
    repositoryOwnerId: Schema.Int,
  }),
  repository: Schema.String,
  repositoryId: Schema.Int,
  appActorId: Schema.Int,
  workflowSha: Schema.String,
  toolingSha: Schema.optionalKey(Schema.String),
})
export type CapabilityBinding = typeof Binding.Type
const Challenge = Schema.Struct({ ...Binding.fields, nonce: Digest, recipientId: Schema.String })
const Row = Schema.Struct({
  run_id: Schema.String,
  channel: Digest,
  challenge: Digest,
  challenge_expires: Schema.Number,
  authority: Schema.fromJsonString(Authority),
  transport_digest: Schema.NullOr(Digest),
  jti_digest: Schema.NullOr(Digest),
  revoked: Schema.Int,
})
const Current = Schema.Struct({
  runId: Schema.String,
  recipientId: Schema.String,
  attempt: Schema.Int,
  repository: Schema.String,
  repositoryId: Schema.Int,
  repositoryName: Schema.String,
  installationId: Schema.Int,
  sourceSha: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
  actionsRunId: Schema.Int,
  actionsAttempt: Schema.Int,
  deadline: Schema.Number,
  state: Schema.String,
  createdAt: Schema.String,
  leaseState: Schema.String,
  peerId: Schema.NullOr(Schema.String),
  transport: Schema.NullOr(Schema.fromJsonString(SandboxTransport)),
})

/** Durable authority joins the existing managed recipient/run/lease; it creates no new identity. */
export const makeCapabilityStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const current = Effect.fn("CapabilityStore.current")(function* (runId: string, now: number) {
    const rows = yield* sql`SELECT a.run_id AS runId,d.recipient_id AS recipientId,a.attempt,
      a.repository,a.provider_id AS providerId,a.model_id AS modelId,a.state,a.created_at AS createdAt,
      json_extract(l.policy,'$.repositoryId') AS repositoryId,l.source_sha AS sourceSha,
      json_extract(l.policy,'$.repository') AS repositoryName,
      json_extract(l.policy,'$.installationId') AS installationId,
      l.actions_run_id AS actionsRunId,l.actions_attempt AS actionsAttempt,l.deadline,
      l.state AS leaseState,l.peer_id AS peerId,l.transport
      FROM kernel_agent_runs a JOIN sandbox_leases l ON l.run_id=a.run_id
      JOIN directory_managed d ON d.run_id=a.run_id
      WHERE a.run_id=${runId} AND a.repository=json_extract(l.policy,'$.alias')`
    if (rows.length !== 1) return yield* Effect.fail(new CapabilityRefused())
    const value = yield* Schema.decodeUnknownEffect(Current)(rows[0])
    if (
      !authorizeWorker({ state: value.state, createdAt: new Date(value.createdAt) }, now) ||
      value.deadline <= now ||
      !["starting", "ready"].includes(value.leaseState)
    )
      return yield* Effect.fail(new CapabilityRefused())
    return value
  })
  const read = Effect.fn("CapabilityStore.read")(function* (
    binding: CapabilityBinding,
    now: number,
  ) {
    yield* Schema.decodeUnknownEffect(Binding)(binding)
    const rows =
      yield* sql`SELECT * FROM capability_bindings WHERE run_id=${binding.runId} AND channel=${binding.channel} AND revoked=0`
    if (rows.length !== 1) return yield* Effect.fail(new CapabilityRefused())
    const row = yield* Schema.decodeUnknownEffect(Row)(rows[0])
    const value = yield* current(binding.runId, now)
    for (const key of [
      "runId",
      "recipientId",
      "attempt",
      "repository",
      "repositoryId",
      "repositoryName",
      "installationId",
      "sourceSha",
      "providerId",
      "modelId",
      "actionsRunId",
      "actionsAttempt",
      "deadline",
    ] as const)
      if (row.authority[key] !== value[key]) return yield* Effect.fail(new CapabilityRefused())
    return { row, value }
  })
  /** A null transport is the gateway's own session: the run token alone carries the binding. */
  const challenge = Effect.fn("CapabilityStore.challenge")(function* (
    runId: string,
    transport: SandboxTransport | null,
    now: number,
  ) {
    const encodedTransport =
      transport === null
        ? null
        : yield* Schema.encodeEffect(Schema.fromJsonString(SandboxTransport))(transport)
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const value = yield* current(runId, now)
        if (value.leaseState !== "starting") return yield* Effect.fail(new CapabilityRefused())
        const authority = yield* Schema.decodeUnknownEffect(Authority)({
          ...value,
          peerId: transport?.peerId ?? "",
        })
        const channel = randomBytes(32).toString("hex")
        const nonce = randomBytes(32).toString("hex")
        // A fresh challenge may replace only an unconsumed bootstrap, never a revoked grant.
        const kept =
          yield* sql`SELECT 1 FROM capability_bindings WHERE run_id=${runId} AND (jti_digest IS NOT NULL OR revoked=1)`
        if (kept.length > 0) return yield* Effect.fail(new CapabilityRefused())
        yield* sql`DELETE FROM capability_bindings WHERE run_id=${runId} AND jti_digest IS NULL AND revoked=0`
        yield* sql`INSERT INTO capability_bindings(run_id,channel,challenge,challenge_expires,authority,transport_digest)
        VALUES(${runId},${channel},${capabilityDigest(nonce)},${Math.min(now + 60000, authority.deadline)},${JSON.stringify(authority)},${encodedTransport === null ? null : capabilityDigest(encodedTransport)})`
        return {
          runId,
          channel,
          nonce,
          recipientId: authority.recipientId,
          deadline: authority.deadline,
          expiresAt: Math.min(now + 60000, authority.deadline),
        }
      }),
    )
  })
  const consume = Effect.fn("CapabilityStore.consume")(function* (
    challenge: typeof Challenge.Type,
    jti: string,
    now: number,
  ) {
    yield* Schema.decodeUnknownEffect(Challenge)(challenge)
    const { row } = yield* read(challenge, now)
    if (
      row.jti_digest !== null ||
      row.challenge !== capabilityDigest(challenge.nonce) ||
      row.challenge_expires <= now ||
      row.authority.recipientId !== challenge.recipientId ||
      !jti ||
      jti.length > 256
    )
      return yield* Effect.fail(new CapabilityRefused())
    yield* sql`UPDATE capability_bindings SET jti_digest=${capabilityDigest(jti)} WHERE run_id=${row.run_id}`
    return row
  })
  const acceptProof = Effect.fn("CapabilityStore.acceptProof")(
    (challenge: typeof Challenge.Type, jti: string, now: number) =>
      sql.withTransaction(consume(challenge, jti, now)).pipe(Effect.asVoid),
  )
  const bind = Effect.fn("CapabilityStore.bind")(function* (
    challenge: typeof Challenge.Type,
    jti: string,
    digest: string,
    expiresAt: number,
    now: number,
  ) {
    yield* Schema.decodeUnknownEffect(Digest)(digest)
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* consume(challenge, jti, now)
        if (
          !Number.isSafeInteger(expiresAt) ||
          expiresAt <= now ||
          expiresAt > row.authority.deadline
        )
          return yield* Effect.fail(new CapabilityRefused())
        yield* sql`INSERT INTO capability_tokens(digest,run_id,expires_at) VALUES(${digest},${row.run_id},${expiresAt})`
        return { runId: row.run_id, channel: row.channel }
      }),
    )
  })
  const validateBinding = Effect.fn("CapabilityStore.validateBinding")(function* (
    binding: CapabilityBinding,
    now: number,
  ) {
    const { row, value } = yield* read(binding, now)
    if (row.jti_digest === null) return yield* Effect.fail(new CapabilityRefused())
    // A session binding has no SSH peer to compare; the lease must still be live (current()).
    if (row.transport_digest === null) return row.authority
    if (
      value.leaseState !== "ready" ||
      value.peerId !== row.authority.peerId ||
      value.transport === null ||
      capabilityDigest(JSON.stringify(value.transport)) !== row.transport_digest
    )
      return yield* Effect.fail(new CapabilityRefused())
    return row.authority
  })
  const authorize = Effect.fn("CapabilityStore.authorize")(function* (
    binding: CapabilityBinding,
    digest: string,
    now: number,
  ) {
    yield* Schema.decodeUnknownEffect(Digest)(digest)
    const authority = yield* validateBinding(binding, now)
    const tokens =
      yield* sql`SELECT expires_at FROM capability_tokens WHERE digest=${digest} AND run_id=${binding.runId} AND expires_at>${now}`
    if (tokens.length !== 1) return yield* Effect.fail(new CapabilityRefused())
    const token = yield* Schema.decodeUnknownEffect(Schema.Struct({ expires_at: Schema.Number }))(
      tokens[0],
    )
    return { ...authority, expiresAt: token.expires_at }
  })
  const renew = Effect.fn("CapabilityStore.renew")(function* (
    binding: CapabilityBinding,
    predecessor: string,
    successor: string,
    expiresAt: number,
    now: number,
  ) {
    yield* Schema.decodeUnknownEffect(Digest)(successor)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const authority = yield* authorize(binding, predecessor, now)
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > authority.deadline)
          return yield* Effect.fail(new CapabilityRefused())
        yield* sql`INSERT INTO capability_tokens(digest,run_id,predecessor,expires_at) VALUES(${successor},${binding.runId},${predecessor},${expiresAt})`
      }),
    )
  })
  const leaseChallenge = Effect.fn("CapabilityStore.leaseChallenge")(function* (
    leaseId: string,
    now: number,
  ) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(leaseId)) return yield* Effect.fail(new CapabilityRefused())
    const rows = yield* sql`SELECT run_id FROM sandbox_leases WHERE lease_id=${leaseId}
      AND json_extract(policy,'$.privateBootstrap.mode')='actions-native'`
    const runId = rows[0]?.run_id
    if (rows.length !== 1 || typeof runId !== "string")
      return yield* Effect.fail(new CapabilityRefused())
    const issued = yield* challenge(runId, null, now)
    return { channel: issued.channel, nonce: issued.nonce, expiresAt: issued.expiresAt }
  })
  /** What a session proof must match. The channel comes from an unverified audience: it only selects. */
  const sessionContext = Effect.fn("CapabilityStore.sessionContext")(function* (
    channel: string,
    now: number,
  ) {
    const rows = yield* sql`SELECT b.run_id AS runId,l.lease_id AS leaseId,l.policy,
      b.challenge_expires AS challengeExpires,json_extract(b.authority,'$.recipientId') AS recipientId
      FROM capability_bindings b JOIN sandbox_leases l ON l.run_id=b.run_id
      WHERE b.channel=${channel} AND b.revoked=0 AND b.jti_digest IS NULL AND b.transport_digest IS NULL`
    if (rows.length !== 1) return yield* Effect.fail(new CapabilityRefused())
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        runId: Schema.String,
        leaseId: Schema.String,
        policy: Schema.fromJsonString(SessionPolicy),
        challengeExpires: Schema.Number,
        recipientId: Schema.String,
      }),
    )(rows[0])
    if (row.challengeExpires <= now) return yield* Effect.fail(new CapabilityRefused())
    const value = yield* current(row.runId, now)
    return {
      ...row,
      actionsRunId: value.actionsRunId,
      actionsAttempt: value.actionsAttempt,
      deadline: value.deadline,
    }
  })
  const bindingFor = Effect.fn("CapabilityStore.bindingFor")(function* (
    digest: string,
    now: number,
  ) {
    yield* Schema.decodeUnknownEffect(Digest)(digest)
    const rows = yield* sql`SELECT b.run_id AS runId,b.channel FROM capability_tokens t
      JOIN capability_bindings b ON b.run_id=t.run_id
      WHERE t.digest=${digest} AND t.expires_at>${now} AND b.revoked=0`
    if (rows.length !== 1) return yield* Effect.fail(new CapabilityRefused())
    return yield* Schema.decodeUnknownEffect(Binding)(rows[0])
  })
  /** Of these runs, those whose binding another process revoked. */
  const revokedAmong = Effect.fn("CapabilityStore.revokedAmong")(function* (
    runIds: ReadonlyArray<string>,
  ) {
    if (runIds.length === 0) return []
    const rows = yield* sql`SELECT run_id FROM capability_bindings
      WHERE revoked=1 AND run_id IN ${sql.in(runIds)}`
    return rows.flatMap((row) => (typeof row.run_id === "string" ? [row.run_id] : []))
  })
  return {
    challenge,
    leaseChallenge,
    sessionContext,
    bindingFor,
    revokedAmong,
    acceptProof,
    bind,
    authorize,
    validateBinding,
    renew,
    revoke: Effect.fn("CapabilityStore.revoke")((runId: string) =>
      sql`UPDATE capability_bindings SET revoked=1 WHERE run_id=${runId}`.pipe(Effect.asVoid),
    ),
  }
})
