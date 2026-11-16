import { createHash, randomBytes } from "node:crypto"
import { maxJtiLength } from "../../deploy/sandbox/capability-limits.mjs"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { renewalReplacements, renewalWindowMs } from "../../deploy/sandbox/renewal.mjs"
import { CapabilityGrant, SessionPolicy } from "../capability-control/protocol"
import type { ReportedUsage } from "./claude"

export class CapabilityRefused extends Schema.TaggedError<CapabilityRefused>()(
  "CapabilityRefused",
  {},
) {}
/**
 * The lease cannot be challenged: it is unknown, its Actions run is not recorded, its run has
 * ended, or its binding is revoked. All of them get the same answer.
 */
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
/** A renewal asked again replaces the successor of one token at most this many times. */
const maxReplacements = renewalReplacements
/** A successor must outlive its predecessor by this much, so renewals near the deadline end. */
const minimumExtensionMs = 60000
type CapabilityBinding = typeof Binding.Type
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
const StoredGrant = Schema.fromJsonString(CapabilityGrant)

/** The gateway's own store: the grants workflowd sent, and the bindings and tokens of each. */
export const makeCapabilityStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const current = Effect.fn("CapabilityStore.current")(function* (runId: string, now: number) {
    const rows = yield* sql<{
      readonly grant_json: string
    }>`SELECT grant_json FROM capability_grants WHERE run_id=${runId} AND revoked=0`
    if (rows.length !== 1 || rows[0] === undefined)
      return yield* Effect.fail(new CapabilityRefused())
    const value = yield* Schema.decodeUnknownEffect(StoredGrant)(rows[0].grant_json)
    if (value.deadline <= now || value.notAfter <= now)
      return yield* Effect.fail(new CapabilityRefused())
    return value
  })
  /** Ends a run: its grant and its binding. A revoked run is never granted again. */
  const revokeRun = (runId: string) =>
    Effect.gen(function* () {
      yield* sql`UPDATE capability_grants SET revoked=1 WHERE run_id=${runId}`
      yield* sql`UPDATE capability_bindings SET revoked=1 WHERE run_id=${runId}`
    })
  /**
   * Holds a grant. A new run is recorded; the same grant again changes nothing. A grant that
   * differs from the one held (a new attempt, another Actions run) revokes the run, as does a
   * lease that another run holds; a revoked run stays revoked.
   */
  const hold = (grant: CapabilityGrant) =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(StoredGrant)(grant)
      const rows = yield* sql<{
        readonly run_id: string
        readonly grant_json: string
        readonly revoked: number
      }>`SELECT run_id,grant_json,revoked FROM capability_grants
        WHERE run_id=${grant.runId} OR lease_id=${grant.leaseId}`
      if (rows.length === 0) {
        yield* sql`INSERT INTO capability_grants(run_id,lease_id,grant_json)
          VALUES(${grant.runId},${grant.leaseId},${encoded})`
        yield* sql`INSERT INTO capability_usage(run_id) VALUES(${grant.runId})`
        return "held" as const
      }
      const row = rows[0]
      if (rows.length === 1 && row?.revoked === 0 && row.grant_json === encoded) return "held"
      for (const { run_id } of rows) yield* revokeRun(run_id)
      return "revoked" as const
    })
  const authorizeGrant = Effect.fn("CapabilityStore.authorizeGrant")(function* (grant: unknown) {
    const value = yield* Schema.decodeUnknownEffect(CapabilityGrant)(grant)
    return { runId: value.runId, held: (yield* sql.withTransaction(hold(value))) === "held" }
  })
  /**
   * Brings the gateway to workflowd's live runs: each grant is held as `authorizeGrant` holds
   * it, and every held run that workflowd did not name is revoked. Returns the revoked runs.
   */
  const reconcileGrants = Effect.fn("CapabilityStore.reconcileGrants")(function* (
    live: ReadonlyArray<unknown>,
  ) {
    const grants = yield* Schema.decodeUnknownEffect(Schema.Array(CapabilityGrant))(live)
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const before = yield* sql<{
          readonly run_id: string
        }>`SELECT run_id FROM capability_grants WHERE revoked=0`
        const named = new Set(grants.map((grant) => grant.runId))
        const revoked = new Set<string>()
        for (const grant of grants) if ((yield* hold(grant)) === "revoked") revoked.add(grant.runId)
        for (const { run_id } of before)
          if (!named.has(run_id)) {
            yield* revokeRun(run_id)
            revoked.add(run_id)
          }
        return [...revoked]
      }),
    )
  })
  /** Whether the runner of this Actions run holds a live session for the run. */
  const sessionBound = Effect.fn("CapabilityStore.sessionBound")(function* (
    runId: string,
    actionsRunId: number,
    actionsAttempt: number,
  ) {
    const rows = yield* sql`SELECT 1 FROM capability_bindings b
      JOIN capability_grants g ON g.run_id=b.run_id
      WHERE b.run_id=${runId} AND b.session>0 AND b.revoked=0 AND g.revoked=0
      AND json_extract(g.grant_json,'$.actionsRunId')=${actionsRunId}
      AND json_extract(g.grant_json,'$.actionsAttempt')=${actionsAttempt}`
    return rows.length === 1
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
    const { row, value } = yield* read(binding, now)
    // Only a runner's session opens a binding; the lease must still be live (read() checks it).
    return row.session > 0
      ? { ...row.authority, session: row.session, budget: value.budget }
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
   * replaces it. A lease that workflowd has not granted, whose grant is revoked or whose binding
   * is revoked gets the same answer whether or not it exists: the runner may ask before workflowd
   * records its Actions run and sends the grant.
   */
  const leaseChallenge = Effect.fn("CapabilityStore.leaseChallenge")(function* (
    leaseId: string,
    now: number,
  ) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(leaseId)) return yield* Effect.fail(new CapabilityRefused())
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly run_id: string
        }>`SELECT run_id FROM capability_grants WHERE lease_id=${leaseId}`
        const runId = rows[0]?.run_id
        if (rows.length !== 1 || runId === undefined)
          return yield* Effect.fail(new CapabilityNotReady())
        // An ended run and a revoked binding answer as an unknown lease does: not ready.
        const value = yield* current(runId, now).pipe(
          Effect.mapError(() => new CapabilityNotReady()),
        )
        const bound = yield* sql`SELECT * FROM capability_bindings WHERE run_id=${runId}`
        const nonce = randomBytes(32).toString("hex")
        const expiresAt = Math.min(now + 60000, value.deadline)
        if (bound.length > 0) {
          const row = yield* Schema.decodeUnknownEffect(Row)(bound[0])
          if (row.revoked !== 0) return yield* Effect.fail(new CapabilityNotReady())
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
    proofExpiresAt: number,
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
          jti.length > maxJtiLength ||
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
    const rows = yield* sql`SELECT b.run_id AS runId,g.lease_id AS leaseId,
      json_extract(g.grant_json,'$.policy') AS policy,
      b.challenge_expires AS challengeExpires,json_extract(b.authority,'$.recipientId') AS recipientId
      FROM capability_bindings b JOIN capability_grants g ON g.run_id=b.run_id
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
  /**
   * Counts a call of a live run that asks `tokens` output tokens, and reserves them against the
   * output tokens that are left. Gives the reservation; "spent" when the budget can never hold the
   * call (its calls are used up, or the output tokens charged and `tokens` pass the budget): the
   * budget is then spent, and each later call of the run is refused; "held" when the call fits
   * only once the run's open reservations settle: nothing is counted or reserved, and the run
   * stays live.
   */
  const reserve = Effect.fn("CapabilityStore.reserve")(function* (
    runId: string,
    tokens: number,
    now: number,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { budget } = yield* current(runId, now)
        const rows = yield* sql`SELECT u.calls,u.output_tokens AS outputTokens,u.spent,
          (SELECT coalesce(sum(r.tokens),0) FROM capability_reservations r
            WHERE r.run_id=u.run_id) AS reserved
          FROM capability_usage u WHERE u.run_id=${runId}`
        if (rows.length !== 1) return yield* Effect.fail(new CapabilityRefused())
        const counts = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            calls: Schema.Int,
            outputTokens: Schema.Int,
            spent: Schema.Int,
            reserved: Schema.Int,
          }),
        )(rows[0])
        if (counts.spent !== 0) return "spent" as const
        if (counts.calls >= budget.calls || counts.outputTokens + tokens > budget.outputTokens) {
          yield* sql`UPDATE capability_usage SET spent=1 WHERE run_id=${runId}`
          return "spent" as const
        }
        if (counts.outputTokens + counts.reserved + tokens > budget.outputTokens)
          return "held" as const
        const reservation = randomBytes(16).toString("hex")
        yield* sql`UPDATE capability_usage SET calls=calls+1 WHERE run_id=${runId}`
        yield* sql`INSERT INTO capability_reservations(id,run_id,tokens)
          VALUES(${reservation},${runId},${tokens})`
        return { reservation }
      }),
    )
  })
  /**
   * Settles a reservation: the run is charged the output tokens that the provider reported, or the
   * whole reservation when it reported none, and the input counts it reported are recorded. A
   * reservation that is settled already changes nothing.
   */
  const settle = Effect.fn("CapabilityStore.settle")(function* (
    reservation: string,
    usage: ReportedUsage | undefined,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT run_id AS runId,tokens FROM capability_reservations WHERE id=${reservation}`
        if (rows.length !== 1) return
        const held = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ runId: Schema.String, tokens: Schema.Int }),
        )(rows[0])
        yield* sql`UPDATE capability_usage SET
          output_tokens=output_tokens+${usage?.outputTokens ?? held.tokens},
          input_tokens=input_tokens+${usage?.inputTokens ?? 0},
          cache_creation_input_tokens=cache_creation_input_tokens+${usage?.cacheCreationInputTokens ?? 0},
          cache_read_input_tokens=cache_read_input_tokens+${usage?.cacheReadInputTokens ?? 0}
          WHERE run_id=${held.runId}`
        yield* sql`DELETE FROM capability_reservations WHERE id=${reservation}`
      }),
    )
  })
  /**
   * Charges in full each reservation that is open: one that an earlier process of the gateway
   * made and did not settle. The gateway runs it once, as it starts, before it serves a call.
   */
  const chargeOpenReservations = Effect.fn("CapabilityStore.chargeOpenReservations")(() =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE capability_usage SET output_tokens=output_tokens+
          (SELECT sum(r.tokens) FROM capability_reservations r WHERE r.run_id=capability_usage.run_id)
          WHERE run_id IN (SELECT run_id FROM capability_reservations)`
        yield* sql`DELETE FROM capability_reservations`
      }),
    ),
  )
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
    authorizeGrant,
    reconcileGrants,
    sessionBound,
    revoke: Effect.fn("CapabilityStore.revoke")((runId: string) =>
      sql.withTransaction(revokeRun(runId)),
    ),
    reserve,
    settle,
    chargeOpenReservations,
  }
})
