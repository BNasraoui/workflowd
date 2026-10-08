import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runStoreMigrations } from "../../src/store/migrations"
import { makePublishStore } from "../../src/sandbox/publish-store"

const metadata = {
  sourceSha: "a".repeat(40),
  resultSha: "b".repeat(40),
  branch: "arbitrary/$()\n雪",
  bundleSha256: "c".repeat(64),
  manifestSha256: "d".repeat(64),
}

test("publication custody survives SQLite reopen and fences an ambiguous approval POST", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-publish-store-"))
  const layer = SqliteClient.layer({ filename: join(root, "store.sqlite") })
  const run = <A, E>(
    effect: Effect.Effect<A, E, import("effect/unstable/sql/SqlClient").SqlClient>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer)))
  try {
    await run(
      Effect.gen(function* () {
        yield* runStoreMigrations
        const store = yield* makePublishStore
        const input = {
          runId: "agent-1",
          actionsRunId: 41,
          attempt: 1,
          metadata,
          deadline: Date.now() + 60000,
        }
        yield* store.seal(input)
        yield* store.seal(input)
        expect((yield* store.read(input.runId))?.metadata.branch).toBe(metadata.branch)
        expect(
          (yield* Effect.result(
            store.seal({ ...input, metadata: { ...metadata, resultSha: "f".repeat(40) } }),
          ))._tag,
        ).toBe("Failure")
        const winners = yield* Effect.all(
          [
            store.claimApproval("agent-1", 52, "sha256:" + "e".repeat(64)),
            store.claimApproval("agent-1", 52, "sha256:" + "e".repeat(64)),
          ],
          { concurrency: "unbounded" },
        )
        expect(winners.filter(Boolean)).toHaveLength(1)
      }),
    )
    await run(
      Effect.gen(function* () {
        const store = yield* makePublishStore
        expect((yield* store.read("agent-1"))?.phase).toBe("approving")
        expect(yield* store.claimApproval("agent-1", 53, "sha256:" + "f".repeat(64))).toBe(false)
        yield* store.advance("agent-1", "approving", "approved")
        expect((yield* store.read("agent-1"))?.artifact_id).toBe(52)
        yield* store.advance("agent-1", "approved", "probed")
        expect((yield* store.read("agent-1"))?.phase).toBe("probed")
        expect(yield* store.read("historical-capture-only-run")).toBeNull()
      }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
