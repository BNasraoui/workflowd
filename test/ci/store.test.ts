import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { makeCiStore } from "../../src/ci/store"
import { runStoreMigrations } from "../../src/store/migrations"

const target = { repository: "owner/repo", sha: "a".repeat(40) }
const run = (name: string, conclusion: string | null, id = 1, attempt = 1) => ({
  id,
  name,
  conclusion,
  attempt,
  status: conclusion === null ? "in_progress" : "completed",
  failingJobs: conclusion === "failure" ? ["unit tests"] : [],
})
test("persists deduplicated ingress and replayable aggregate; missing workflows never pass", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runStoreMigrations
      const store = yield* makeCiStore
      yield* store.watch(target, 2, ["CI", "Build"], 1000)
      const event = {
        _tag: "CiCompletion" as const,
        ...target,
        installationId: 2,
        source: "workflow_run" as const,
        sourceId: 1,
        conclusion: "success",
      }
      expect(yield* store.ingest("delivery-1", event, "{}", 1000)).toBe("accepted")
      expect(yield* store.ingest("delivery-1", event, "{}", 1001)).toBe("duplicate")
      yield* store.snapshot(target, [run("CI", "success")], "etag1", 1002)
      const pending = yield* store.read(target)
      expect(pending?.conclusion).toBe("pending")
      yield* store.snapshot(
        target,
        [run("CI", "success"), run("Build", "failure", 2)],
        "etag2",
        1003,
      )
      const failed = yield* store.read(target)
      expect(failed?.conclusion).toBe("failure")
      expect(failed?.failingJobs).toEqual(["unit tests"])
      expect(yield* store.events(target, pending!.sequence)).toHaveLength(1)
      const reconcilerRow = { ...target, installation_id: 2, etag: "etag2" }
      yield* store.snapshot(
        reconcilerRow,
        [run("CI", "success"), run("Build", "failure", 2)],
        "etag2",
        1003,
      )
      expect(yield* store.outbox()).toHaveLength(2)
      expect(yield* store.deliveryOutbox()).toHaveLength(1)
      yield* store.deliveryPublished("delivery-1")
      expect(yield* store.deliveryOutbox()).toHaveLength(0)
      expect(yield* store.due(1005)).toHaveLength(0)
      yield* store.defer(target, 1005)
      expect(yield* store.due(1005)).toHaveLength(1)
      yield* store.published(failed!.sequence)
      expect(yield* store.outbox()).toHaveLength(1)
      yield* store.snapshot(target, [run("CI", "success"), run("Build", null, 2, 2)], "etag3", 1004)
      expect((yield* store.read(target))?.conclusion).toBe("pending")
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ))

test("changing required workflows invalidates a previously terminal target", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runStoreMigrations
      const store = yield* makeCiStore
      yield* store.watch(target, 2, ["CI"], 1000)
      yield* store.snapshot(target, [run("CI", "success")], "etag", 1001)
      yield* store.watch(target, 2, ["CI", "Build"], 1002)
      expect((yield* store.read(target))?.conclusion).toBe("pending")
      yield* store.snapshot(target, [run("CI", "success")], null, 1003)
      expect((yield* store.read(target))?.conclusion).toBe("pending")
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ))
