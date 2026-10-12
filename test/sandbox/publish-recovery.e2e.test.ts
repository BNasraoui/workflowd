import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runStoreMigrations } from "../../src/store/migrations"
import { makePublishStore, type PublishIntent } from "../../src/sandbox/publish-store"
import { approvalComment } from "../../src/sandbox/publish"

const metadata = {
  sourceSha: "a".repeat(40),
  resultSha: "b".repeat(40),
  treeSha: "1".repeat(40),
  title: "Agent title",
  commitMessage: "Agent message\n\nDetails",
  body: "## Result\n\nReadable agent description.",
  branch: "arbitrary/$()\n雪",
  bundleSha256: "c".repeat(64),
  manifestSha256: "d".repeat(64),
}

test("approval binding fits 900 bytes with maximum IDs and agent metadata", () => {
  const intent: PublishIntent = {
    run_id: "agent-1",
    actions_run_id: Number.MAX_SAFE_INTEGER,
    attempt: 1,
    artifact_id: Number.MAX_SAFE_INTEGER,
    artifact_digest: "sha256:" + "f".repeat(64),
    metadata: { ...metadata, title: "雪".repeat(200), commitMessage: "m".repeat(10240) },
    base_ref: "main",
    deadline: Number.MAX_SAFE_INTEGER,
    phase: "approving",
    receipt: null,
  }
  const comment = approvalComment(intent)
  expect(Buffer.byteLength(comment)).toBeLessThanOrEqual(900)
  expect(JSON.parse(comment)).toEqual({
    v: 4,
    run: intent.actions_run_id,
    attempt: 1,
    artifact: intent.artifact_id,
    digest: intent.artifact_digest,
    source: metadata.sourceSha,
    result: metadata.resultSha,
    manifest: metadata.manifestSha256,
    tree: metadata.treeSha,
    base: "main",
  })
  // The remaining capacity bounds the only variable-length field, including JSON escaping.
  const maximum = "b".repeat(900 - Buffer.byteLength(comment) + 4)
  expect(Buffer.byteLength(approvalComment({ ...intent, base_ref: maximum }))).toBe(900)
  expect(() => approvalComment({ ...intent, base_ref: maximum + "b" })).toThrow()
  expect(() => approvalComment({ ...intent, base_ref: "雪".repeat(maximum.length) })).toThrow()
})

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
          baseRef: "main",
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

test("publication receipt and recorded base survive reopening without authorizing another write", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-publish-receipt-"))
  const layer = SqliteClient.layer({ filename: join(root, "store.sqlite") })
  const run = <A, E>(
    effect: Effect.Effect<A, E, import("effect/unstable/sql/SqlClient").SqlClient>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer)))
  try {
    await run(
      Effect.gen(function* () {
        yield* runStoreMigrations
        const store = yield* makePublishStore
        yield* store.seal({
          runId: "one",
          actionsRunId: 41,
          attempt: 1,
          metadata,
          baseRef: "reviewed/base",
          deadline: Date.now() + 60000,
        })
        yield* store.claimApproval("one", 52, "sha256:" + "e".repeat(64))
        yield* store.advance("one", "approving", "approved")
        yield* store.saveReceipt("one", {
          stage: "creating_pr",
          pr: null,
          revoked: true,
          commitSha: "2".repeat(40),
        })
      }),
    )
    await run(
      Effect.gen(function* () {
        const store = yield* makePublishStore
        expect((yield* store.read("one"))?.base_ref).toBe("reviewed/base")
        expect((yield* store.read("one"))?.receipt).toEqual({
          stage: "creating_pr",
          pr: null,
          revoked: true,
          commitSha: "2".repeat(40),
        })
        expect(yield* store.claimApproval("one", 52, "sha256:" + "e".repeat(64))).toBe(false)
        yield* store.saveReceipt("one", {
          stage: "published",
          pr: 17,
          revoked: true,
          commitSha: "2".repeat(40),
        })
        yield* store.saveReceipt("one", {
          stage: "creating_pr",
          pr: null,
          revoked: true,
          commitSha: "2".repeat(40),
        })
        expect((yield* store.read("one"))?.receipt).toEqual({
          stage: "published",
          pr: 17,
          revoked: true,
          commitSha: "2".repeat(40),
        })
      }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("receipt migration preserves historical canaries and their immutable intent", async () => {
  const { sandboxPublishMigration, sandboxPublicationReceiptMigration } =
    await import("../../src/sandbox/migration")
  const { SqlClient } = await import("effect/unstable/sql")
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sandboxPublishMigration
      yield* sql`INSERT INTO sandbox_publications(run_id,actions_run_id,attempt,metadata,phase,artifact_id,artifact_digest,deadline)
      VALUES('legacy',41,1,${JSON.stringify(metadata)},'probed',52,${"sha256:" + "e".repeat(64)},100)`
      yield* sandboxPublicationReceiptMigration
      const store = yield* makePublishStore
      expect(yield* store.read("legacy")).toMatchObject({
        phase: "probed",
        base_ref: null,
        receipt: null,
        metadata,
      })
      expect(
        (yield* Effect.result(
          sql`UPDATE sandbox_publications SET base_ref='main' WHERE run_id='legacy'`,
        ))._tag,
      ).toBe("Failure")
      expect(
        (yield* Effect.result(
          sql`UPDATE sandbox_publications SET phase='published' WHERE run_id='legacy'`,
        ))._tag,
      ).toBe("Failure")
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  )
})
