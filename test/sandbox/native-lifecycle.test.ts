import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeNativeExecutionStore } from "../../src/sandbox/native-execution"
import { makeNativeResultStore } from "../../src/sandbox/native-result"
import { seedCapabilityRun, transport } from "../capability-gateway/fixture"
import { makeCapabilityStore, capabilityDigest } from "../../src/capability-gateway/store"
import { runLifetime } from "../../src/store/run-lifetime"

test("native-assigned session replaces only the first reservation and survives resume", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { leases, sql } = yield* seedCapabilityRun(Date.now(), true)
      const capabilities = yield* makeCapabilityStore
      yield* capabilities.bind(
        yield* capabilities.challenge("run", transport, Date.now()),
        "jti",
        capabilityDigest("fixture"),
        Date.now() + 60000,
        Date.now(),
      )
      yield* leases.bind("run", 78, 1, transport)
      const native = yield* makeNativeExecutionStore
      const first = yield* native.reserve("run")
      yield* leases.attachSession("run", first.session_id)
      const session = "ses_0123456789abcdefghijklmnop"
      yield* sql`CREATE TRIGGER reject_session_attachment BEFORE UPDATE OF session_id ON sandbox_leases
        BEGIN SELECT RAISE(FAIL, 'fixture attach failure'); END`
      expect(
        (yield* native.acknowledge("run", first.nonce, session).pipe(Effect.result))._tag,
      ).toBe("Failure")
      yield* sql`DROP TRIGGER reject_session_attachment`
      expect(yield* native.read("run")).toEqual(first)
      expect(yield* sql`SELECT session_id FROM sandbox_leases`).toEqual([
        { session_id: first.session_id },
      ])
      const rollback = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* native.acknowledge("run", first.nonce, session)
            expect((yield* native.read("run"))?.state).toBe("running")
            expect(yield* sql`SELECT session_id FROM sandbox_leases`).toEqual([
              { session_id: session },
            ])
            return yield* Effect.fail("outer rollback")
          }),
        )
        .pipe(Effect.result)
      expect(rollback).toMatchObject({ _tag: "Failure", failure: "outer rollback" })
      expect(yield* native.read("run")).toEqual(first)
      expect(yield* sql`SELECT session_id FROM sandbox_leases`).toEqual([
        { session_id: first.session_id },
      ])
      yield* native.acknowledge("run", first.nonce, session)
      expect((yield* native.read("run"))?.session_id).toBe(session)
      expect(yield* sql`SELECT session_id FROM sandbox_leases WHERE run_id='run'`).toEqual([
        { session_id: session },
      ])
      yield* native.closed("run", first.nonce, "paused", null)
      const resumed = yield* native.resume("run", first.nonce)
      expect(resumed.session_id).toBe(session)
      expect(
        (yield* native
          .acknowledge("run", resumed.nonce, "ses_foreign0123456789abcdef")
          .pipe(Effect.result))._tag,
      ).toBe("Failure")
      yield* runLifetime(sql).withPermit(native.acknowledge("run", resumed.nonce, session))
      expect((yield* native.read("run"))?.state).toBe("running")
    }).pipe(
      Effect.provide(AgentRunStoreLive),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      Effect.scoped,
    ),
  )
})

for (const operation of ["uncertain", "closed"] as const) {
  test(`native ${operation} composes with SQL fences through rollback and commit`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { leases, sql } = yield* seedCapabilityRun(Date.now(), true)
        const capabilities = yield* makeCapabilityStore
        const binding = yield* capabilities.bind(
          yield* capabilities.challenge("run", transport, Date.now()),
          "jti",
          capabilityDigest("fixture"),
          Date.now() + 60000,
          Date.now(),
        )
        yield* leases.bind("run", 78, 1, transport)
        const native = yield* makeNativeExecutionStore
        const results = yield* makeNativeResultStore
        const invocation = yield* native.reserve("run")
        yield* native.acknowledge("run", invocation.nonce)
        yield* results.submit(binding, {
          revision: 0,
          completion: {
            branch: "chosen/result",
            title: "Result",
            body: "Result",
            commitMessage: "Result",
          },
        })
        const lifetime = runLifetime(sql)
        const mutate =
          operation === "uncertain"
            ? native.uncertain("run")
            : native.closed("run", invocation.nonce, "completed", 1)
        const changed = Effect.gen(function* () {
          expect(yield* sql`SELECT revoked FROM capability_bindings`).toEqual([{ revoked: 1 }])
          expect((yield* native.read("run"))?.state).toBe(
            operation === "uncertain" ? "uncertain" : "stopped",
          )
          expect((yield* results.read("run"))?.frozen).toBe(operation === "closed" ? 1 : 0)
        })
        const rollbackFence = operation === "uncertain" ? lifetime.withPermit : sql.withTransaction
        const commitFence = operation === "uncertain" ? sql.withTransaction : lifetime.withPermit
        const rolledBack = yield* rollbackFence(
          Effect.gen(function* () {
            yield* mutate
            yield* changed
            return yield* Effect.fail("intentional outer rollback")
          }),
        ).pipe(Effect.result)
        expect(rolledBack).toMatchObject({ _tag: "Failure", failure: "intentional outer rollback" })
        expect(yield* sql`SELECT revoked FROM capability_bindings`).toEqual([{ revoked: 0 }])
        expect((yield* native.read("run"))?.state).toBe("running")
        expect((yield* results.read("run"))?.frozen).toBe(0)
        yield* commitFence(mutate)
        yield* changed
        // A completed native root must also leave the original fence usable.
        yield* native.uncertain("run")
        yield* lifetime.withPermit(changed)
      }).pipe(
        Effect.provide(AgentRunStoreLive),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.scoped,
      ),
    )
  })
}

for (const refusal of [
  "revoked",
  "terminal",
  "frozen",
  "expired",
  "uncertain",
  "generation limit",
  "concurrent",
] as const) {
  test(`paused native resume preserves custody under ${refusal}`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { leases, sql } = yield* seedCapabilityRun(Date.now(), true)
        const capabilities = yield* makeCapabilityStore
        const binding = yield* capabilities.bind(
          yield* capabilities.challenge("run", transport, Date.now()),
          "jti",
          capabilityDigest("fixture"),
          Date.now() + 60000,
          Date.now(),
        )
        yield* leases.bind("run", 78, 1, transport)
        const native = yield* makeNativeExecutionStore
        const results = yield* makeNativeResultStore
        const first = yield* native.reserve("run")
        yield* native.acknowledge("run", first.nonce)
        yield* results.submit(binding, {
          revision: 0,
          completion: {
            branch: "chosen/result",
            title: "Result",
            body: "Result",
            commitMessage: "Result",
          },
        })
        yield* native.closed("run", first.nonce, "paused", null)
        if (refusal === "revoked") yield* capabilities.revoke("run")
        else if (refusal === "terminal")
          yield* sql`UPDATE kernel_agent_runs SET state='cancelled' WHERE run_id='run'`
        else if (refusal === "frozen")
          yield* sql`UPDATE sandbox_native_results SET frozen=1 WHERE run_id='run'`
        else if (refusal === "expired")
          yield* sql`UPDATE sandbox_native_executions SET deadline=1 WHERE run_id='run'`
        else if (refusal === "uncertain") yield* native.uncertain("run")
        else if (refusal === "generation limit")
          yield* sql`UPDATE sandbox_native_executions SET generation=100 WHERE run_id='run'`
        const attempts = yield* Effect.all(
          [
            native.resume("run", first.nonce).pipe(Effect.result),
            native.resume("run", first.nonce).pipe(Effect.result),
          ],
          { concurrency: 2 },
        )
        expect(attempts.filter((value) => value._tag === "Success")).toHaveLength(
          refusal === "concurrent" ? 1 : 0,
        )
        const current = yield* native.read("run")
        expect(current?.session_id).toBe(first.session_id)
        expect(current?.container_nonce).toBe(first.container_nonce)
        expect(current?.nonce === first.nonce).toBe(refusal !== "concurrent")
        expect((yield* results.read("run"))?.revision).toBe(1)
      }).pipe(
        Effect.provide(AgentRunStoreLive),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.scoped,
      ),
    )
  })
}

test("explicit resume requires a clean durable pause and preserves session, selection, workspace custody and deadline", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { leases, sql } = yield* seedCapabilityRun(Date.now(), true)
      const capabilities = yield* makeCapabilityStore
      const binding = yield* capabilities.bind(
        yield* capabilities.challenge("run", transport, Date.now()),
        "jti",
        capabilityDigest("fixture"),
        Date.now() + 60000,
        Date.now(),
      )
      yield* leases.bind("run", 78, 1, transport)
      const native = yield* makeNativeExecutionStore
      const results = yield* makeNativeResultStore
      const first = yield* native.reserve("run")
      yield* native.acknowledge("run", first.nonce)
      yield* native.observeResponse("run", first.nonce, first.model, 3)
      yield* results.submit(binding, {
        revision: 0,
        completion: {
          branch: "chosen/result",
          title: "Initial",
          body: "Result",
          commitMessage: "Result",
        },
      })
      yield* native.closed("run", first.nonce, "paused", null)
      expect((yield* native.read("run"))?.state).toBe("paused")
      expect((yield* results.read("run"))?.frozen).toBe(0)
      expect(yield* sql`SELECT revoked FROM capability_bindings`).toEqual([{ revoked: 0 }])
      expect((yield* native.resume("run", "foreign").pipe(Effect.result))._tag).toBe("Failure")
      const second = yield* native.resume("run", first.nonce)
      expect(second.nonce).not.toBe(first.nonce)
      for (const key of [
        "session_id",
        "channel",
        "model",
        "effort",
        "deadline",
        "container_nonce",
      ] as const)
        expect(second[key]).toBe(first[key])
      expect((yield* native.resume("run", first.nonce).pipe(Effect.result))._tag).toBe("Failure")
      expect(
        (yield* native.closed("run", first.nonce, "paused", null).pipe(Effect.result))._tag,
      ).toBe("Failure")
      yield* native.acknowledge("run", second.nonce)
      yield* native.uncertain("run")
      expect((yield* native.resume("run", second.nonce).pipe(Effect.result))._tag).toBe("Failure")
      expect(
        (yield* native.closed("run", second.nonce, "paused", null).pipe(Effect.result))._tag,
      ).toBe("Failure")
    }).pipe(
      Effect.provide(AgentRunStoreLive),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      Effect.scoped,
    ),
  )
})

test("native launch custody prevents replay and freezes the corrected result only after exact shutdown", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { leases } = yield* seedCapabilityRun(Date.now())
      const capabilities = yield* makeCapabilityStore
      const job = yield* capabilities.challenge("run", transport, Date.now())
      const binding = yield* capabilities.bind(
        job,
        "jti",
        capabilityDigest("fixture"),
        Date.now() + 60000,
        Date.now(),
      )
      yield* leases.bind("run", 78, 1, transport)
      const native = yield* makeNativeExecutionStore
      const results = yield* makeNativeResultStore
      const first = yield* native.reserve("run")
      expect(first.channel).toBe(binding.channel)
      expect(first.model).toBe("fixture-model")
      expect((yield* native.reserve("run").pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* native.acknowledge("run", "foreign").pipe(Effect.result))._tag).toBe("Failure")
      yield* native.acknowledge("run", first.nonce)
      const completion = {
        branch: "agent/picked",
        title: "Result",
        body: "Useful result",
        commitMessage: "Result",
      }
      yield* results.submit(binding, { revision: 0, completion })
      yield* results.submit(binding, {
        revision: 1,
        completion: { ...completion, title: "Correction" },
      })
      expect(
        (yield* native.closed("run", first.nonce, "completed", 1).pipe(Effect.result))._tag,
      ).toBe("Failure")
      yield* native.closed("run", first.nonce, "completed", 2)
      expect((yield* results.read("run"))?.frozen).toBe(1)
      expect(yield* results.submit(binding, { revision: 2, completion })).toBeNull()
      expect((yield* native.read("run"))?.state).toBe("stopped")
      expect((yield* native.acknowledge("run", first.nonce).pipe(Effect.result))._tag).toBe(
        "Failure",
      )
    }).pipe(
      Effect.provide(AgentRunStoreLive),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      Effect.scoped,
    ),
  )
})

test("native launch acknowledgement loss retains custody and rejects late acknowledgements", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { leases } = yield* seedCapabilityRun(Date.now())
      const capabilities = yield* makeCapabilityStore
      const job = yield* capabilities.challenge("run", transport, Date.now())
      yield* capabilities.bind(
        job,
        "jti",
        capabilityDigest("fixture"),
        Date.now() + 60000,
        Date.now(),
      )
      yield* leases.bind("run", 78, 1, transport)
      const native = yield* makeNativeExecutionStore
      const first = yield* native.reserve("run")
      yield* native.uncertain("run")
      expect((yield* native.acknowledge("run", first.nonce).pipe(Effect.result))._tag).toBe(
        "Failure",
      )
      expect((yield* native.reserve("run").pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* native.read("run"))?.nonce).toBe(first.nonce)
      yield* native.closed("run", first.nonce, "cancelled", null)
      expect((yield* native.read("run"))?.outcome).toBe("cancelled")
    }).pipe(
      Effect.provide(AgentRunStoreLive),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      Effect.scoped,
    ),
  )
})
