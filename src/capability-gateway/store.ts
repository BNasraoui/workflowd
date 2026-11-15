import { createHash, randomBytes } from "node:crypto"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SandboxTransport } from "../sandbox/transport"
import { authorizeWorker } from "../worker-identity/access"

export class CapabilityRefused extends Schema.TaggedError<CapabilityRefused>()(
  "CapabilityRefused",
  {},
) {}
/** The lease cannot be challenged yet: it is unknown, or its Actions run is not recorded. */
class CapabilityNotReady extends Schema.TaggedError<CapabilityNotReady>()(
  "CapabilityNotReady",
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
const SessionBinding = Schema.Struct({ ...Binding.fields, session: Schema.Int })
/** A run opens at most this many sessions; only a verified proof opens one. */
const maxSessions = 8
/** A run token is renewed only in its last 330 seconds: the relay's 180 to 300, and 30 of slack. */
const renewalWindowMs = 330000
/** A renewal asked again replaces the successor of one token at most this many times. */
const maxReplacements = 3
/** A successor must outlive its predecessor by this much, so renewals near the deadline end. */
const minimumExtensionMs = 60000
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
  revoked: Schema.Int,
  session: Schema.Int,
  nonce: Schema.NullOr(Digest),
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
  const validateBinding = Effect.fn("CapabilityStore.validateBinding")(function* (
    binding: CapabilityBinding,
    now: number,
  ) {
    const { row } = yield* read(binding, now)
    // Only a runner's session opens a binding; the lease must still be live (read() checks it).
    return row.session > 0
      ? { ...row.authority, session: row.session }
      : yield* Effect.fail(new CapabilityRefused())
  })
  const authorize = Effect.fn("CapabilityStore.authorize")(function* (
    binding: CapabilityBinding,
    digest: string,
    now: number,
  ) {
    yield* Schema.decodeUnknownEffect(Digest)(digest)
    const authority = yield* validateBinding(binding, now)
    const tokens =
      yield* sql`SELECT expires_at FROM capability_tokens WHERE digest=${digest} AND run_id=${binding.runId} AND expires_at>${now} AND session=${authority.session}`
    if (tokens.length !== 1) return yield* Effect.fail(new CapabilityRefused())
    const token = yield* Schema.decodeUnknownEffect(Schema.Struct({ expires_at: Schema.Number }))(
      tokens[0],
    )
    return { ...authority, expiresAt: token.expires_at }
  })
  /**
   * The authority of a run token that may be renewed now. A token with more than
   * `renewalWindowMs` left is not renewed, nor one whose successor would not outlive it by
   * `minimumExtensionMs` (near the run's deadline), nor one whose successor has renewed already,
   * nor one whose successor was replaced `maxReplacements` times.
   */
  const renewable = Effect.fn("CapabilityStore.renewable")(function* (
    binding: CapabilityBinding,
    predecessor: string,
    /** The successor's expiry, or its longest for the run's deadline before it is minted. */
    successor: (deadline: number) => number,
    now: number,
  ) {
    const authority = yield* authorize(binding, predecessor, now)
    const successorExpiresAt = successor(authority.deadline)
    if (
      authority.expiresAt - now > renewalWindowMs ||
      !Number.isSafeInteger(successorExpiresAt) ||
      successorExpiresAt < authority.expiresAt + minimumExtensionMs ||
      successorExpiresAt > authority.deadline
    )
      return yield* Effect.fail(new CapabilityRefused())
    const successors =
      yield* sql`SELECT digest FROM capability_tokens WHERE predecessor=${predecessor}`
    const earlier = successors[0]?.digest
    if (typeof earlier === "string") {
      const renewed = yield* sql`SELECT 1 FROM capability_tokens WHERE predecessor=${earlier}`
      const replaced =
        yield* sql`SELECT 1 FROM capability_tokens WHERE digest=${predecessor} AND replaced>=${maxReplacements}`
      if (renewed.length > 0 || replaced.length > 0)
        return yield* Effect.fail(new CapabilityRefused())
    }
    return { ...authority, earlier: typeof earlier === "string" ? earlier : undefined }
  })
  /**
   * Renews a run token. A renewal asked again for the same predecessor (its answer was lost)
   * replaces the successor that has not renewed itself, so exactly one successor stays valid; it
   * does so at most `maxReplacements` times for one predecessor.
   */
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
        const { session, earlier } = yield* renewable(binding, predecessor, () => expiresAt, now)
        if (earlier !== undefined) {
          yield* sql`DELETE FROM capability_tokens WHERE digest=${earlier}`
          yield* sql`UPDATE capability_tokens SET replaced=replaced+1 WHERE digest=${predecessor}`
        }
        yield* sql`INSERT INTO capability_tokens(digest,run_id,predecessor,expires_at,session) VALUES(${successor},${binding.runId},${predecessor},${expiresAt},${session})`
      }),
    )
  })
  /** Deletes expired run tokens, unlinking their successors first, and expired used proofs. */
  const sweep = Effect.fn("CapabilityStore.sweep")((now: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE capability_tokens SET predecessor=NULL WHERE predecessor IN
          (SELECT digest FROM capability_tokens WHERE expires_at<=${now})`
        yield* sql`DELETE FROM capability_tokens WHERE expires_at<=${now}`
        yield* sql`DELETE FROM capability_proofs WHERE expires_at<=${now}`
      }),
    ),
  )
  /**
   * A runner's challenge for its lease. While an unused challenge is alive, every request gets
   * that same nonce and expiry back, so asking again costs the run nothing; otherwise a new nonce
   * replaces it. A lease that does not exist and a lease whose Actions run is not recorded yet get
   * the same answer: the runner may ask before the daemon records its run.
   */
  const leaseChallenge = Effect.fn("CapabilityStore.leaseChallenge")(function* (
    leaseId: string,
    now: number,
  ) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(leaseId)) return yield* Effect.fail(new CapabilityRefused())
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly run_id: unknown
          readonly actions_run_id: unknown
        }>`SELECT run_id,actions_run_id FROM sandbox_leases
          WHERE lease_id=${leaseId} AND json_extract(policy,'$.privateBootstrap.mode')='actions-native'`
        const runId = rows[0]?.run_id
        if (
          rows.length !== 1 ||
          typeof runId !== "string" ||
          typeof rows[0]?.actions_run_id !== "number"
        )
          return yield* Effect.fail(new CapabilityNotReady())
        const value = yield* current(runId, now)
        const bound = yield* sql`SELECT * FROM capability_bindings WHERE run_id=${runId}`
        const nonce = randomBytes(32).toString("hex")
        const expiresAt = Math.min(now + 60000, value.deadline)
        if (bound.length > 0) {
          const row = yield* Schema.decodeUnknownEffect(Row)(bound[0])
          if (row.revoked !== 0) return yield* Effect.fail(new CapabilityRefused())
          if (row.nonce !== null && row.challenge_expires > now)
            return { channel: row.channel, nonce: row.nonce, expiresAt: row.challenge_expires }
          yield* sql`UPDATE capability_bindings
            SET challenge=${capabilityDigest(nonce)},nonce=${nonce},challenge_expires=${expiresAt}
            WHERE run_id=${runId}`
          return { channel: row.channel, nonce, expiresAt }
        }
        const authority = yield* Schema.decodeUnknownEffect(Authority)({ ...value, peerId: "" })
        const channel = randomBytes(32).toString("hex")
        yield* sql`INSERT INTO capability_bindings(run_id,channel,challenge,nonce,challenge_expires,authority)
          VALUES(${runId},${channel},${capabilityDigest(nonce)},${nonce},${expiresAt},${JSON.stringify(authority)})`
        return { channel, nonce, expiresAt }
      }),
    )
  })
  /**
   * A verified proof for the current unused challenge opens the run's next session: the jti is
   * recorded once, the challenge is used, and every token of an earlier session stops being valid.
   */
  const bindSession = Effect.fn("CapabilityStore.bindSession")(function* (
    challenge: typeof Challenge.Type,
    jti: string,
    digest: string,
    expiresAt: number,
    now: number,
    /** When the proof itself expires; until then its jti stays recorded. */
    proofExpiresAt = now + 610000,
  ) {
    yield* Schema.decodeUnknownEffect(Challenge)(challenge)
    yield* Schema.decodeUnknownEffect(Digest)(digest)
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { row } = yield* read(challenge, now)
        const proof = capabilityDigest(jti)
        const used = yield* sql`SELECT 1 FROM capability_proofs WHERE jti_digest=${proof}`
        if (
          used.length > 0 ||
          row.challenge !== capabilityDigest(challenge.nonce) ||
          row.challenge_expires <= now ||
          row.session >= maxSessions ||
          row.authority.recipientId !== challenge.recipientId ||
          !jti ||
          jti.length > 256 ||
          !Number.isSafeInteger(expiresAt) ||
          expiresAt <= now ||
          expiresAt > row.authority.deadline
        )
          return yield* Effect.fail(new CapabilityRefused())
        const session = row.session + 1
        yield* sql`INSERT INTO capability_proofs(jti_digest,run_id,expires_at) VALUES(${proof},${row.run_id},${proofExpiresAt})`
        yield* sql`UPDATE capability_bindings SET session=${session},challenge_expires=0,nonce=NULL WHERE run_id=${row.run_id}`
        yield* sql`INSERT INTO capability_tokens(digest,run_id,expires_at,session) VALUES(${digest},${row.run_id},${expiresAt},${session})`
        return { runId: row.run_id, channel: row.channel, session }
      }),
    )
  })
  /**
   * What a session proof must match. The channel, nonce and jti come from the unverified proof:
   * they only select, and refuse before any key is fetched or token minted. A proof for a nonce
   * that is not the live one, a used proof and a run whose sessions are spent go no further.
   */
  const sessionContext = Effect.fn("CapabilityStore.sessionContext")(function* (
    proof: { readonly channel: string; readonly nonce: string; readonly jti: string },
    now: number,
  ) {
    const rows = yield* sql`SELECT b.run_id AS runId,l.lease_id AS leaseId,l.policy,
      b.challenge_expires AS challengeExpires,json_extract(b.authority,'$.recipientId') AS recipientId
      FROM capability_bindings b JOIN sandbox_leases l ON l.run_id=b.run_id
      WHERE b.channel=${proof.channel} AND b.challenge=${capabilityDigest(proof.nonce)}
      AND b.session<${maxSessions} AND b.revoked=0`
    if (rows.length !== 1) return yield* Effect.fail(new CapabilityRefused())
    const used =
      yield* sql`SELECT 1 FROM capability_proofs WHERE jti_digest=${capabilityDigest(proof.jti)}`
    if (used.length > 0) return yield* Effect.fail(new CapabilityRefused())
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
  /** The binding of a valid run token, with the session that token belongs to. */
  const bindingFor = Effect.fn("CapabilityStore.bindingFor")(function* (
    digest: string,
    now: number,
  ) {
    yield* Schema.decodeUnknownEffect(Digest)(digest)
    const rows = yield* sql`SELECT b.run_id AS runId,b.channel,b.session FROM capability_tokens t
      JOIN capability_bindings b ON b.run_id=t.run_id AND b.session=t.session
      WHERE t.digest=${digest} AND t.expires_at>${now} AND b.revoked=0`
    if (rows.length !== 1) return yield* Effect.fail(new CapabilityRefused())
    return yield* Schema.decodeUnknownEffect(SessionBinding)(rows[0])
  })
  /**
   * Of these streams, those whose binding is revoked or has moved to a later session, or whose
   * run token is gone (a renewal asked again replaced it).
   */
  const staleAmong = Effect.fn("CapabilityStore.staleAmong")(function* <
    Stream extends { readonly runId: string; readonly session: number; readonly digest: string },
  >(streams: ReadonlyArray<Stream>) {
    if (streams.length === 0) return []
    const rows = yield* sql`SELECT run_id AS runId,session,revoked FROM capability_bindings
      WHERE run_id IN ${sql.in([...new Set(streams.map((stream) => stream.runId))])}`
    const bindings = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({ runId: Schema.String, session: Schema.Int, revoked: Schema.Int }),
      ),
    )(rows)
    const tokens = yield* sql`SELECT digest FROM capability_tokens
      WHERE digest IN ${sql.in([...new Set(streams.map((stream) => stream.digest))])}`
    const live = new Set(tokens.map((row) => row.digest))
    return streams.filter((stream) => {
      const binding = bindings.find((row) => row.runId === stream.runId)
      return (
        binding === undefined ||
        binding.revoked === 1 ||
        binding.session !== stream.session ||
        !live.has(stream.digest)
      )
    })
  })
  return {
    leaseChallenge,
    sessionContext,
    bindingFor,
    staleAmong,
    bindSession,
    authorize,
    validateBinding,
    renewable,
    renew,
    sweep,
    revoke: Effect.fn("CapabilityStore.revoke")((runId: string) =>
      sql`UPDATE capability_bindings SET revoked=1 WHERE run_id=${runId}`.pipe(Effect.asVoid),
    ),
  }
})
