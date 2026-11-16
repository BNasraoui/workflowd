import { expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { AgentRunStoreLive, AgentRunStore } from "../../src/kernel/agent-run-store"
import { CapabilityRefused, makeCapabilityStore } from "../../src/capability-gateway/store"
import {
  bindRunSession,
  fixtureSessionKey,
  grantLiveRuns,
  renewalSignature,
  seedCapabilityRun,
} from "./fixture"

const now = Date.now()
const seed = Effect.gen(function* () {
  return { ...(yield* seedCapabilityRun(now, true)), store: yield* makeCapabilityStore }
})
/** The failure of `result`, or undefined when it succeeded. */
const refusal = <A, E>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure : undefined
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
        refusal(
          yield* Effect.result(
            store.bindSession(
              { ...again, runId: "run", recipientId: "managed:fixture-controller:run" },
              "fixture-jti",
              "b".repeat(64),
              now + 3600000,
              now,
              now + 610000,
              fixtureSessionKey.publicKey,
            ),
          ),
        ),
      ).toBeInstanceOf(CapabilityRefused)
      expect(
        refusal(
          yield* Effect.result(
            store.authorize({ ...binding, channel: "f".repeat(64) }, "a".repeat(64), now),
          ),
        ),
      ).toBeInstanceOf(CapabilityRefused)
      expect(
        refusal(yield* Effect.result(store.authorize(binding, "b".repeat(64), now))),
      ).toBeInstanceOf(CapabilityRefused)
      yield* sql`UPDATE directory_managed SET recipient_id='other-recipient' WHERE run_id='run'`
      // workflowd sends the changed grant; the gateway revokes the run.
      yield* grantLiveRuns(now)
      expect(
        refusal(yield* Effect.result(store.authorize(binding, "a".repeat(64), now))),
      ).toBeInstanceOf(CapabilityRefused)
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
      yield* store.renew(
        binding,
        "a".repeat(64),
        renewalSignature(binding, "a".repeat(64)),
        "b".repeat(64),
        now + 3600000,
        now + 1,
      )
      expect((yield* store.authorize(binding, "b".repeat(64), now + 2)).expiresAt).toBe(
        now + 3600000,
      )
      // Asked again, the renewal replaces the successor that has not renewed itself.
      yield* store.renew(
        binding,
        "a".repeat(64),
        renewalSignature(binding, "a".repeat(64)),
        "c".repeat(64),
        now + 7200000,
        now + 2,
      )
      expect(
        refusal(yield* Effect.result(store.authorize(binding, "b".repeat(64), now + 2))),
      ).toBeInstanceOf(CapabilityRefused)
      expect((yield* store.authorize(binding, "c".repeat(64), now + 2)).expiresAt).toBe(
        now + 7200000,
      )
      expect(
        refusal(
          yield* Effect.result(
            store.renew(
              binding,
              "a".repeat(64),
              renewalSignature(binding, "a".repeat(64)),
              "d".repeat(64),
              now + 7200000,
              now + 60000,
            ),
          ),
        ),
      ).toBeInstanceOf(CapabilityRefused)
      yield* runs.cancel({ runId: "run", now: new Date(now + 3) })
      yield* grantLiveRuns(now + 3)
      expect(
        refusal(yield* Effect.result(store.authorize(binding, "c".repeat(64), now + 4))),
      ).toBeInstanceOf(CapabilityRefused)
      // A restart revokes nothing by itself; the durable cancellation still holds.
      const restarted = yield* makeCapabilityStore
      expect(
        refusal(yield* Effect.result(restarted.authorize(binding, "c".repeat(64), now + 4))),
      ).toBeInstanceOf(CapabilityRefused)
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
              // workflowd sends the changed grant, or none for a run that is no longer live.
              yield* grantLiveRuns(now)
              expect(
                refusal(yield* Effect.result(store.authorize(binding, "a".repeat(64), now))),
              ).toBeInstanceOf(CapabilityRefused)
              expect(
                refusal(
                  yield* Effect.result(
                    store.renew(
                      binding,
                      "a".repeat(64),
                      renewalSignature(binding, "a".repeat(64)),
                      "b".repeat(64),
                      now + 200000,
                      now,
                    ),
                  ),
                ),
              ).toBeInstanceOf(CapabilityRefused)
              return yield* Effect.fail("fixture rollback")
            }),
          )
          .pipe(Effect.result)
        expect((yield* store.authorize(binding, "a".repeat(64), now)).runId).toBe("run")
      }
      expect(
        refusal(yield* Effect.result(store.authorize(binding, "a".repeat(64), now + 60000))),
      ).toBeInstanceOf(CapabilityRefused)
      // Two renewals of one predecessor: the later replaces the earlier, so one successor is valid.
      yield* Effect.all(
        [
          store
            .renew(
              binding,
              "a".repeat(64),
              renewalSignature(binding, "a".repeat(64)),
              "b".repeat(64),
              now + 200000,
              now + 1,
            )
            .pipe(Effect.result),
          store
            .renew(
              binding,
              "a".repeat(64),
              renewalSignature(binding, "a".repeat(64)),
              "c".repeat(64),
              now + 200000,
              now + 1,
            )
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      )
      const valid = []
      for (const digest of ["b", "c"])
        if (
          (yield* Effect.result(store.authorize(binding, digest.repeat(64), now + 2)))._tag ===
          "Success"
        )
          valid.push(digest)
      expect(valid).toHaveLength(1)
      yield* Effect.all(
        [
          store.revoke("run"),
          store
            .renew(
              binding,
              valid[0]!.repeat(64),
              renewalSignature(binding, valid[0]!.repeat(64)),
              "d".repeat(64),
              now + 400000,
              now + 2,
            )
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      )
      for (const digest of ["a", "b", "c", "d"])
        expect(
          refusal(yield* Effect.result(store.authorize(binding, digest.repeat(64), now + 3))),
        ).toBeInstanceOf(CapabilityRefused)
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
        now + 610000,
        fixtureSessionKey.publicKey,
      )
      expect(binding).toEqual({ runId: "run", channel: first.channel, session: 1 })
      const { session: _, ...run } = binding
      yield* store.renew(
        run,
        "a".repeat(64),
        renewalSignature(run, "a".repeat(64)),
        "b".repeat(64),
        now + 200000,
        now + 1,
      )
      expect((yield* store.authorize(run, "b".repeat(64), now + 2)).session).toBe(1)
      // The used challenge, and the used proof on a new challenge, open nothing.
      expect(
        refusal(
          yield* Effect.result(
            store.bindSession(
              { runId: "run", channel: first.channel, nonce: first.nonce, recipientId },
              "jti-2",
              "c".repeat(64),
              now + 60000,
              now + 3,
              now + 610000,
              fixtureSessionKey.publicKey,
            ),
          ),
        ),
      ).toBeInstanceOf(CapabilityRefused)
      const second = yield* store.leaseChallenge("lease", now + 3)
      expect(second.channel).toBe(first.channel)
      const challenge = { runId: "run", channel: second.channel, nonce: second.nonce, recipientId }
      expect(
        refusal(
          yield* Effect.result(
            store.bindSession(
              challenge,
              "jti-1",
              "c".repeat(64),
              now + 60000,
              now + 4,
              now + 610000,
              fixtureSessionKey.publicKey,
            ),
          ),
        ),
      ).toBeInstanceOf(CapabilityRefused)
      expect(
        (yield* store.bindSession(
          challenge,
          "jti-2",
          "c".repeat(64),
          now + 60000,
          now + 4,
          now + 610000,
          fixtureSessionKey.publicKey,
        )).session,
      ).toBe(2)
      for (const digest of ["a", "b"]) {
        expect(
          refusal(yield* Effect.result(store.authorize(run, digest.repeat(64), now + 5))),
        ).toBeInstanceOf(CapabilityRefused)
        expect(
          refusal(yield* Effect.result(store.bindingFor(digest.repeat(64), now + 5))),
        ).toBeInstanceOf(CapabilityRefused)
      }
      expect(
        refusal(
          yield* Effect.result(
            store.renew(
              run,
              "b".repeat(64),
              renewalSignature(run, "b".repeat(64)),
              "d".repeat(64),
              now + 400000,
              now + 5,
            ),
          ),
        ),
      ).toBeInstanceOf(CapabilityRefused)
      expect((yield* store.bindingFor("c".repeat(64), now + 5)).session).toBe(2)
      expect(
        yield* store.staleAmong([
          { runId: "run", session: 1, digest: "c".repeat(64) },
          { runId: "run", session: 2, digest: "c".repeat(64) },
          { runId: "run", session: 2, digest: "e".repeat(64) },
          { runId: "gone", session: 1, digest: "c".repeat(64) },
        ]),
      ).toEqual([
        { runId: "run", session: 1, digest: "c".repeat(64) },
        { runId: "run", session: 2, digest: "e".repeat(64) },
        { runId: "gone", session: 1, digest: "c".repeat(64) },
      ])
      yield* store.revoke("run")
      expect(
        yield* store.staleAmong([{ runId: "run", session: 2, digest: "c".repeat(64) }]),
      ).toEqual([{ runId: "run", session: 2, digest: "c".repeat(64) }])
      // A revoked binding gets the not-ready answer of an unknown lease, not a refusal.
      expect(refusal(yield* Effect.result(store.leaseChallenge("lease", now + 7)))).toMatchObject({
        _tag: "CapabilityNotReady",
      })
    }),
  )
})

test("a run token with exactly 330 seconds left is renewed, and one with 330 seconds and 1 ms left is refused", async () => {
  await run(
    Effect.gen(function* () {
      const { store } = yield* seed
      const { binding, expiresAt } = yield* bindRunSession(now, { digest: "a".repeat(64) })
      const opens = expiresAt - 330000
      const early = yield* Effect.result(
        store.renew(
          binding,
          "a".repeat(64),
          renewalSignature(binding, "a".repeat(64)),
          "b".repeat(64),
          expiresAt + 600000,
          opens - 1,
        ),
      )
      expect(refusal(early)).toBeInstanceOf(CapabilityRefused)
      expect(
        refusal(yield* Effect.result(store.authorize(binding, "b".repeat(64), opens - 1))),
      ).toBeInstanceOf(CapabilityRefused)
      yield* store.renew(
        binding,
        "a".repeat(64),
        renewalSignature(binding, "a".repeat(64)),
        "b".repeat(64),
        expiresAt + 600000,
        opens,
      )
      expect((yield* store.authorize(binding, "b".repeat(64), opens)).expiresAt).toBe(
        expiresAt + 600000,
      )
    }),
  )
})
