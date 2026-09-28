import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { makeCiWorkers } from "../../src/ci/service"
import { CiProvider } from "../../src/ci/provider"
import { runStoreMigrations } from "../../src/store/migrations"
const repositories = [{ repository: "o/r", installationId: 1, workflows: ["CI"] }]
test("ingress registers reconciliation and outbox retries retain durable observations", () => {
  const publications: string[] = []
  let unavailable = true
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* runStoreMigrations
      const { port, publish, reconcile } = yield* makeCiWorkers(repositories)
      yield* port.ingest(
        "d1",
        {
          _tag: "CiCompletion",
          repository: "o/r",
          sha: "a".repeat(40),
          source: "workflow_run",
          sourceId: 1,
          conclusion: "success",
          installationId: 1,
        },
        "{}",
        Date.now(),
      )
      expect(yield* port.due(Date.now())).toHaveLength(1)
      expect((yield* Effect.result(publish))._tag).toBe("Failure")
      expect(yield* port.deliveryOutbox()).toHaveLength(1)
      unavailable = false
      yield* publish
      expect(yield* port.deliveryOutbox()).toHaveLength(0)
      yield* reconcile
      expect((yield* port.read({ repository: "o/r", sha: "a".repeat(40) }))?.conclusion).toBe(
        "success",
      )
      yield* publish
      expect(publications).toEqual(["ci-delivery:d1", "ci:1"])
    }).pipe(
      Effect.provide(
        Layer.merge(
          SqliteClient.layer({ filename: ":memory:" }),
          Layer.succeed(CiProvider, {
            publish: (_subject, _body, id) =>
              unavailable
                ? Effect.fail(new Error("offline"))
                : Effect.sync(() => {
                    publications.push(id)
                  }),
            request: () =>
              Effect.succeed(async () => ({
                status: 200,
                etag: "e1",
                data: {
                  total_count: 1,
                  workflow_runs: [
                    {
                      id: 1,
                      name: "CI",
                      run_attempt: 1,
                      head_sha: "a".repeat(40),
                      status: "completed",
                      conclusion: "success",
                    },
                  ],
                },
              })),
          }),
        ),
      ),
    ),
  )
})
