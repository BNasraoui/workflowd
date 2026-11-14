import { expect, test } from "bun:test"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { Effect, Fiber } from "effect"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { makeCapabilityTransport } from "../../src/sandbox/capability-transport"
import { runStoreMigrations } from "../../src/store/migrations"
import { transport } from "../capability-gateway/fixture"
import { exchangeJobProof } from "../../src/sandbox/bootstrap"
import { ownedPromise } from "../../src/capability-gateway/owned"

test("S2: failed relay spawn releases the acquired Unix server and directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "transport-failure-"))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runStoreMigrations
        const gateway = yield* makeCapabilityGateway({
          noscope: { binary: fixtureExecutable("noscope"), configHome: root },
          providerId: "anthropic",
          credentialRole: "fixture",
          maxStreams: 1,
          maxStreamsPerRun: 1,
        })
        const channel = yield* makeCapabilityTransport(
          gateway,
          join(root, "nonexistent-node"),
          root,
        )
        expect(
          (yield* Effect.result(
            channel.connect({ runId: "fixture", channel: "a".repeat(64) }, transport),
          ))._tag,
        ).toBe("Failure")
        expect(yield* Effect.promise(() => readdir(root))).toEqual([])
        yield* channel.disconnect("fixture")
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("S3: interrupted private exchange joins an in-progress proof callback", async () => {
  const accepted = Promise.withResolvers<void>()
  let cleaned = false
  await Effect.runPromise(
    Effect.gen(function* () {
      const exchange = ownedPromise((signal) =>
        exchangeJobProof(
          [process.execPath, "-e", 'process.stdout.write("{}\\n");setInterval(()=>{},1000)'],
          { audience: "workflowd:fixture", peerId: "fixture" },
          async (_, signal) => {
            accepted.resolve()
            return await Effect.runPromise(
              Effect.never.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    cleaned = true
                  }),
                ),
              ),
              { signal },
            )
          },
          signal,
        ),
      )
      const pending = yield* exchange.pipe(Effect.forkScoped)
      yield* Effect.promise(() => accepted.promise)
      yield* Fiber.interrupt(pending)
      expect(cleaned).toBe(true)
    }).pipe(Effect.scoped),
  )
}, 3000)
