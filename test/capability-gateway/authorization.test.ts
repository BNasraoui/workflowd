import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { AgentRunStoreLive, AgentRunStore } from "../../src/kernel/agent-run-store"
import { makeCapabilityStore } from "../../src/capability-gateway/store"
import { seedCapabilityRun, transport } from "./fixture"

const now = Date.now()
const seed = Effect.gen(function* () {
  return { ...(yield* seedCapabilityRun(now)), store: yield* makeCapabilityStore }
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

test("a challenge is single-use and tokens bind existing run, recipient, attempt and transport", async () => {
  await run(
    Effect.gen(function* () {
      const { store, leases, sql } = yield* seed
      const challenge = yield* store.challenge("run", transport, now)
      expect(challenge.recipientId).toBe("managed:fixture-controller:run")
      const binding = yield* store.bind(
        challenge,
        "fixture-jti",
        "a".repeat(64),
        now + 3600000,
        now,
      )
      yield* leases.bind("run", 78, 1, transport)
      expect((yield* store.authorize(binding, "a".repeat(64), now)).modelId).toBe("fixture-model")
      expect(
        (yield* Effect.result(
          store.bind(challenge, "fixture-jti", "b".repeat(64), now + 3600000, now),
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
      const { store, leases, runs } = yield* seed
      const challenge = yield* store.challenge("run", transport, now)
      const binding = yield* store.bind(challenge, "fixture-jti", "a".repeat(64), now + 60000, now)
      yield* leases.bind("run", 78, 1, transport)
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
      const restarted = yield* makeCapabilityStore
      yield* restarted.revokeAll()
      expect(
        (yield* Effect.result(restarted.authorize(binding, "b".repeat(64), now + 4)))._tag,
      ).toBe("Failure")
    }),
  )
})

test("accepted grant rejects each durable identity/context swap with adjacent rollback controls", async () => {
  await run(
    Effect.gen(function* () {
      const { store, leases, sql } = yield* seed
      const challenge = yield* store.challenge("run", transport, now)
      const binding = yield* store.bind(challenge, "abac-jti", "a".repeat(64), now + 60000, now)
      yield* leases.bind("run", 78, 1, transport)
      const swaps = [
        sql`UPDATE kernel_agent_runs SET provider_id='other' WHERE run_id='run'`,
        sql`UPDATE kernel_agent_runs SET model_id='other' WHERE run_id='run'`,
        sql`UPDATE kernel_agent_runs SET attempt=attempt+1 WHERE run_id='run'`,
        sql`UPDATE kernel_agent_runs SET repository='other' WHERE run_id='run'`,
        sql`UPDATE directory_managed SET recipient_id='other' WHERE run_id='run'`,
        sql`UPDATE sandbox_leases SET actions_run_id=79 WHERE run_id='run'`,
        sql`UPDATE sandbox_leases SET actions_attempt=2 WHERE run_id='run'`,
        sql`UPDATE sandbox_leases SET source_sha=${"e".repeat(40)} WHERE run_id='run'`,
        sql`UPDATE sandbox_leases SET peer_id='other' WHERE run_id='run'`,
        sql`UPDATE sandbox_leases SET transport=json_set(transport,'$.knownHostsFile','/other') WHERE run_id='run'`,
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
          store.revokeAll(),
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
