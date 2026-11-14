import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { seedCapabilityRun, transport } from "./fixture"
import { makeNativeExecutionStore } from "../../src/sandbox/native-execution"
import { runLifetime } from "../../src/store/run-lifetime"

test("native result candidates are correctable, idempotent and bound to current run authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-result-"))
  await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
  await writeFile(
    join(root, "noscope/providers/run-capability.toml"),
    `contract_version = 1\n[commands]\nmint = "${process.execPath} ${resolve("src/capability-gateway/noscope-provider.ts")} run {ttl}"\n`,
    { mode: 0o600 },
  )
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { sql, runs, leases } = yield* seedCapabilityRun(Date.now(), true)
        const gateway = yield* makeCapabilityGateway({
          noscope: { binary: fixtureExecutable("noscope"), configHome: root },
          providerId: "anthropic",
          credentialRole: "fixture",
          maxStreams: 4,
          maxStreamsPerRun: 4,
        })
        const grant = yield* gateway.bind(yield* gateway.challenge("run", transport), "result-jti")
        yield* leases.bind("run", 78, 1, transport)
        const native = yield* makeNativeExecutionStore
        const invocation = yield* native.reserve("run")
        yield* native.acknowledge("run", invocation.nonce)
        const completion = {
          branch: "my/arbitrary-branch",
          title: "Result",
          body: "## Result\n\nUseful work.",
          commitMessage: "Implement result",
        }
        const submit = (body: unknown, binding = grant.binding, signal?: AbortSignal) =>
          gateway.handle(
            binding,
            new Request("http://capability.invalid/capabilities/v1/result", {
              method: "POST",
              headers: {
                authorization: `Bearer ${grant.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
              ...(signal ? { signal } : {}),
            }),
          )
        expect((yield* submit({ revision: 0, completion })).status).toBe(200)
        // A lost response can retry identically without creating another revision.
        const retried = yield* submit({ revision: 0, completion })
        expect(yield* Effect.promise(() => retried.json())).toEqual({ revision: 1 })
        const corrected = { ...completion, title: "Corrected result" }
        expect((yield* submit({ revision: 1, completion: corrected })).status).toBe(200)
        expect((yield* submit({ revision: 0, completion })).status).toBe(409)
        for (const invalid of [
          { revision: 2, completion: { ...corrected, environmentId: "foreign" } },
          { revision: 2, completion: { ...corrected, body: "Closes #1" } },
          { revision: 2, completion: { ...corrected, branch: "--help" } },
          { revision: 2, completion: { ...corrected, branch: "bad..ref" } },
          { revision: 2, completion: { ...corrected, body: "x".repeat(65537) } },
          { revision: 2, completion: corrected, runId: "other" },
        ])
          expect((yield* submit(invalid)).status).toBe(400)
        expect(
          (yield* submit(
            { revision: 2, completion },
            { ...grant.binding, channel: "e".repeat(64) },
          )).status,
        ).toBe(403)
        const saved =
          yield* sql`SELECT channel, revision, completion FROM sandbox_native_results WHERE run_id='run'`
        expect(saved).toHaveLength(1)
        expect(saved[0]?.channel).toBe(grant.binding.channel)
        expect(saved[0]?.revision).toBe(2)
        expect(JSON.parse(String(saved[0]?.completion))).toEqual(corrected)
        for (const ending of ["pause/resume", "request abort", "finalize pause/resume"] as const) {
          // Delay only the result commit permit, after decoding. SQL operations
          // and the pause/resume transitions still execute on the real database.
          const authority = runLifetime(sql)
          const withPermit = authority.withPermit
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const controller = new AbortController()
          const origin = yield* native.read("run")
          yield* native.observeResponse("run", origin!.nonce, origin!.model, 1)
          let permits = 0
          authority.withPermit = (effect) =>
            Effect.gen(function* () {
              if (++permits === 3) {
                entered.resolve()
                yield* Effect.promise(() => release.promise)
              }
              return yield* withPermit(effect)
            })
          const pending = Effect.runPromise(
            submit(
              ending === "finalize pause/resume"
                ? { operation: "finalize", revision: 2 }
                : { revision: 2, completion: { ...corrected, title: "Stale request" } },
              grant.binding,
              controller.signal,
            ),
          )
          try {
            yield* Effect.promise(() => entered.promise)
            authority.withPermit = withPermit
            if (ending !== "request abort") {
              yield* native.closed("run", origin!.nonce, "paused", null)
              expect((yield* submit({ operation: "finalize", revision: 2 })).status).toBe(403)
              const successor = yield* native.resume("run", origin!.nonce)
              expect(successor.nonce).not.toBe(origin!.nonce)
              yield* native.acknowledge("run", successor.nonce)
            } else controller.abort()
            release.resolve()
            expect((yield* Effect.promise(() => pending)).status).toBe(409)
            expect(yield* sql`SELECT revision FROM sandbox_native_results`).toEqual([
              { revision: 2 },
            ])
          } finally {
            authority.withPermit = withPermit
            release.resolve()
            yield* Effect.promise(() => pending)
          }
        }
        expect(
          (yield* submit({ revision: 2, completion: { ...corrected, title: "Successor request" } }))
            .status,
        ).toBe(200)
        const current = yield* native.read("run")
        yield* native.observeResponse("run", current!.nonce, current!.model, 3)
        for (const invalid of [
          { operation: "finalize", revision: 0 },
          { operation: "finalize", revision: 3, nonce: current!.nonce },
          { operation: "finish", revision: 3 },
        ])
          expect((yield* submit(invalid)).status).toBe(400)
        expect((yield* submit({ operation: "finalize", revision: 2 })).status).toBe(409)
        for (let retry = 0; retry < 2; retry++) {
          const intent = yield* submit({ operation: "finalize", revision: 3 })
          expect(intent.status).toBe(200)
          expect(yield* Effect.promise(() => intent.json())).toEqual({ revision: 3 })
        }
        expect((yield* submit({ revision: 3, completion })).status).toBe(409)
        expect(yield* sql`SELECT revision,frozen FROM sandbox_native_results`).toEqual([
          { revision: 3, frozen: 0 },
        ])
        const claims = yield* Effect.all(
          [native.claimFinalization("run"), native.claimFinalization("run")],
          { concurrency: 2 },
        )
        expect(claims.filter((value) => value !== null)).toHaveLength(1)
        expect(claims.find((value) => value !== null)?.finalize_revision).toBe(3)
        expect((yield* submit({ operation: "finalize", revision: 3 })).status).toBe(200)
        yield* runs.cancel({ runId: "run", now: new Date() })
        expect((yield* submit({ revision: 3, completion })).status).toBe(403)
        expect((yield* submit({ operation: "finalize", revision: 3 })).status).toBe(403)
        expect(yield* sql`SELECT revision FROM sandbox_native_results`).toEqual([{ revision: 3 }])
      }).pipe(
        Effect.provide(AgentRunStoreLive),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.scoped,
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
