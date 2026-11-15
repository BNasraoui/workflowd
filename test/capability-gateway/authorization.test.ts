import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { AgentRunStoreLive, AgentRunStore } from "../../src/kernel/agent-run-store"
import { makeCapabilityStore } from "../../src/capability-gateway/store"
import { bindRunSession, seedCapabilityRun, transport } from "./fixture"
import { capabilitySession } from "../../src/store/0040-capability-session"

const now = Date.now()
const seed = Effect.gen(function* () {
  return { ...(yield* seedCapabilityRun(now, true)), store: yield* makeCapabilityStore }
})
const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | typeof AgentRunStore.Identifier>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(AgentRunStoreLive),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  )

test("a session proof is single-use and tokens bind existing run, recipient and attempt", async () => {
  await run(
    Effect.gen(function* () {
      const { store, sql } = yield* seed
      const { binding } = yield* bindRunSession(now, {
        digest: "a".repeat(64),
        expiresAt: now + 3600000,
      })
      expect((yield* store.authorize(binding, "a".repeat(64), now)).modelId).toBe("fixture-model")
      const again = yield* store.leaseChallenge("lease", now)
      expect(again.channel).toBe(binding.channel)
      expect(
        (yield* Effect.result(
          store.bindSession(
            { ...again, runId: "run", recipientId: "managed:fixture-controller:run" },
            "fixture-jti",
            "b".repeat(64),
            now + 3600000,
            now,
          ),
        ))._tag,
      ).toBe("Failure")
      expect(
        (yield* Effect.result(
          store.authorize({ ...binding, channel: "other" }, "a".repeat(64), now),
        ))._tag,
      ).toBe("Failure")
      expect((yield* Effect.result(store.authorize(binding, "b".repeat(64), now)))._tag).toBe(
        "Failure",
      )
      yield* sql`UPDATE directory_managed SET recipient_id='other-recipient' WHERE run_id='run'`
      expect((yield* Effect.result(store.authorize(binding, "a".repeat(64), now)))._tag).toBe(
        "Failure",
      )
    }),
  )
})

test("renewal cannot resurrect expiry or survive durable revocation and restart", async () => {
  await run(
    Effect.gen(function* () {
      const { store, runs } = yield* seed
      const { binding } = yield* bindRunSession(now, {
        digest: "a".repeat(64),
        expiresAt: now + 60000,
      })
      yield* store.renew(binding, "a".repeat(64), "b".repeat(64), now + 3600000, now + 1)
      expect((yield* store.authorize(binding, "b".repeat(64), now + 2)).expiresAt).toBe(
        now + 3600000,
      )
      expect(
        (yield* Effect.result(
          store.renew(binding, "a".repeat(64), "c".repeat(64), now + 7200000, now + 2),
        ))._tag,
      ).toBe("Failure")
      expect(
        (yield* Effect.result(
          store.renew(binding, "a".repeat(64), "c".repeat(64), now + 7200000, now + 60000),
        ))._tag,
      ).toBe("Failure")
      yield* runs.cancel({ runId: "run", now: new Date(now + 3) })
      expect((yield* Effect.result(store.authorize(binding, "b".repeat(64), now + 4)))._tag).toBe(
        "Failure",
      )
      // A restart revokes nothing by itself; the durable cancellation still holds.
      const restarted = yield* makeCapabilityStore
      expect(
        (yield* Effect.result(restarted.authorize(binding, "b".repeat(64), now + 4)))._tag,
      ).toBe("Failure")
    }),
  )
})

test("accepted grant rejects each durable identity/context swap with adjacent rollback controls", async () => {
  await run(
    Effect.gen(function* () {
      const { store, sql } = yield* seed
      const { binding } = yield* bindRunSession(now, {
        jti: "abac-jti",
        digest: "a".repeat(64),
        expiresAt: now + 60000,
      })
      const swaps = [
        sql`UPDATE kernel_agent_runs SET provider_id='other' WHERE run_id='run'`,
        sql`UPDATE kernel_agent_runs SET model_id='other' WHERE run_id='run'`,
        sql`UPDATE kernel_agent_runs SET attempt=attempt+1 WHERE run_id='run'`,
        sql`UPDATE kernel_agent_runs SET repository='other' WHERE run_id='run'`,
        sql`UPDATE directory_managed SET recipient_id='other' WHERE run_id='run'`,
        sql`UPDATE sandbox_leases SET actions_run_id=79 WHERE run_id='run'`,
        sql`UPDATE sandbox_leases SET actions_attempt=2 WHERE run_id='run'`,
        sql`UPDATE sandbox_leases SET source_sha=${"e".repeat(40)} WHERE run_id='run'`,
        sql`UPDATE sandbox_leases SET deadline=deadline+1 WHERE run_id='run'`,
        sql`UPDATE sandbox_leases SET policy=json_set(policy,'$.repositoryId',99) WHERE run_id='run'`,
      ]
      for (const swap of swaps) {
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* swap
              expect(
                (yield* Effect.result(store.authorize(binding, "a".repeat(64), now)))._tag,
              ).toBe("Failure")
              expect(
                (yield* Effect.result(
                  store.renew(binding, "a".repeat(64), "b".repeat(64), now + 60000, now),
                ))._tag,
              ).toBe("Failure")
              return yield* Effect.fail("fixture rollback")
            }),
          )
          .pipe(Effect.result)
        expect((yield* store.authorize(binding, "a".repeat(64), now)).runId).toBe("run")
      }
      expect(
        (yield* Effect.result(store.authorize(binding, "a".repeat(64), now + 60000)))._tag,
      ).toBe("Failure")
      const races = yield* Effect.all(
        [
          store
            .renew(binding, "a".repeat(64), "b".repeat(64), now + 60000, now + 1)
            .pipe(Effect.result),
          store
            .renew(binding, "a".repeat(64), "c".repeat(64), now + 60000, now + 1)
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      )
      expect(races.filter((value) => value._tag === "Success")).toHaveLength(1)
      yield* Effect.all(
        [
          store.revoke("run"),
          store
            .renew(binding, "b".repeat(64), "d".repeat(64), now + 60000, now + 2)
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      )
      for (const digest of ["a", "b", "c", "d"])
        expect(
          (yield* Effect.result(store.authorize(binding, digest.repeat(64), now + 3)))._tag,
        ).toBe("Failure")
    }),
  )
})

test("the session migration keeps bindings, their tokens and revocation triggers", async () => {
  await run(
    Effect.gen(function* () {
      const { store, leases, sql } = yield* seed
      yield* sql`PRAGMA foreign_keys = ON`
      const { binding } = yield* bindRunSession(now, {
        digest: "a".repeat(64),
        expiresAt: now + 60000,
      })
      yield* store.renew(binding, "a".repeat(64), "b".repeat(64), now + 60000, now + 1)
      const count = () =>
        sql`SELECT (SELECT count(*) FROM capability_tokens) AS tokens,
          (SELECT count(*) FROM sqlite_master WHERE name='capability_tokens_run') AS indexes`
      expect(yield* count()).toEqual([{ tokens: 2, indexes: 1 }])
      // Back to the schema before 0040's columns, then rebuild again, with foreign keys on, over
      // a bound row and a renewal chain.
      yield* sql`DROP TABLE capability_proofs`
      yield* sql`ALTER TABLE capability_tokens DROP COLUMN session`
      yield* sql`ALTER TABLE capability_bindings DROP COLUMN session`
      yield* sql`ALTER TABLE capability_bindings DROP COLUMN challenges`
      yield* sql.withTransaction(capabilitySession)
      expect(yield* count()).toEqual([{ tokens: 2, indexes: 1 }])
      expect(yield* sql`SELECT session,challenges FROM capability_bindings`).toEqual([
        { session: 0, challenges: 0 },
      ])
      expect(yield* sql`SELECT DISTINCT session FROM capability_tokens`).toEqual([{ session: 0 }])
      expect(yield* sql`SELECT count(*) AS proofs FROM capability_proofs`).toEqual([{ proofs: 0 }])
      // A binding from before the session columns has no session, so it authorizes nothing.
      expect((yield* Effect.result(store.authorize(binding, "b".repeat(64), now + 2)))._tag).toBe(
        "Failure",
      )
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([])
      yield* leases.beginRelease("run")
      expect(yield* sql`SELECT revoked FROM capability_bindings`).toEqual([{ revoked: 1 }])
    }),
  )
})

test("a new session ends every token of the earlier one, and a proof opens one session", async () => {
  await run(
    Effect.gen(function* () {
      yield* seedCapabilityRun(now, true)
      const store = yield* makeCapabilityStore
      const recipientId = "managed:fixture-controller:run"
      const first = yield* store.leaseChallenge("lease", now)
      const binding = yield* store.bindSession(
        { runId: "run", channel: first.channel, nonce: first.nonce, recipientId },
        "jti-1",
        "a".repeat(64),
        now + 60000,
        now,
      )
      expect(binding).toEqual({ runId: "run", channel: first.channel, session: 1 })
      const { session: _, ...run } = binding
      yield* store.renew(run, "a".repeat(64), "b".repeat(64), now + 60000, now + 1)
      expect((yield* store.authorize(run, "b".repeat(64), now + 2)).session).toBe(1)
      // The used challenge, and the used proof on a new challenge, open nothing.
      expect(
        (yield* Effect.result(
          store.bindSession(
            { runId: "run", channel: first.channel, nonce: first.nonce, recipientId },
            "jti-2",
            "c".repeat(64),
            now + 60000,
            now + 3,
          ),
        ))._tag,
      ).toBe("Failure")
      const second = yield* store.leaseChallenge("lease", now + 3)
      expect(second.channel).toBe(first.channel)
      const challenge = { runId: "run", channel: second.channel, nonce: second.nonce, recipientId }
      expect(
        (yield* Effect.result(
          store.bindSession(challenge, "jti-1", "c".repeat(64), now + 60000, now + 4),
        ))._tag,
      ).toBe("Failure")
      expect(
        (yield* store.bindSession(challenge, "jti-2", "c".repeat(64), now + 60000, now + 4))
          .session,
      ).toBe(2)
      for (const digest of ["a", "b"]) {
        expect((yield* Effect.result(store.authorize(run, digest.repeat(64), now + 5)))._tag).toBe(
          "Failure",
        )
        expect((yield* Effect.result(store.bindingFor(digest.repeat(64), now + 5)))._tag).toBe(
          "Failure",
        )
      }
      expect(
        (yield* Effect.result(
          store.renew(run, "b".repeat(64), "d".repeat(64), now + 60000, now + 5),
        ))._tag,
      ).toBe("Failure")
      expect((yield* store.bindingFor("c".repeat(64), now + 5)).session).toBe(2)
      expect(
        yield* store.staleAmong([
          { runId: "run", session: 1 },
          { runId: "run", session: 2 },
          { runId: "gone", session: 1 },
        ]),
      ).toEqual([
        { runId: "run", session: 1 },
        { runId: "gone", session: 1 },
      ])
      // An SSH challenge cannot replace a session binding.
      expect((yield* Effect.result(store.challenge("run", transport, now + 6)))._tag).toBe(
        "Failure",
      )
      yield* store.revoke("run")
      expect(yield* store.staleAmong([{ runId: "run", session: 2 }])).toEqual([
        { runId: "run", session: 2 },
      ])
      expect((yield* Effect.result(store.leaseChallenge("lease", now + 7)))._tag).toBe("Failure")
    }),
  )
})
