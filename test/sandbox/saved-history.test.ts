import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SandboxPolicy } from "../../src/sandbox/config"
import { makeSandboxStore } from "../../src/sandbox/store"
import { makeSandboxPublisher } from "../../src/sandbox/publish"
import { makePublishStore } from "../../src/sandbox/publish-store"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import {
  sandboxMigration,
  sandboxCleanupMigration,
  sandboxOperationMigration,
  sandboxCreationMigration,
  sandboxPublishMigration,
  sandboxPublicationReceiptMigration,
} from "../../src/sandbox/migration"
import { sandboxGithubFixture } from "./harness"
import history from "./fixtures/saved-history.json"

// Frozen values from the named git revisions, including pre-merge development shapes.
// Never build these policies by spreading today's config or relaxing its schema.
const current = Schema.decodeUnknownSync(SandboxPolicy)(history.policies[3]!.policy)
const migrations = Effect.gen(function* () {
  yield* sandboxMigration
  yield* sandboxCleanupMigration
  yield* sandboxOperationMigration
  yield* sandboxCreationMigration
  yield* sandboxPublishMigration
  yield* sandboxPublicationReceiptMigration
})
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))))

const saveLease = (policy: unknown, state = "released") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const encoded = JSON.stringify(policy)
    yield* sql`INSERT INTO sandbox_leases(run_id,lease_id,policy,source_sha,state,actions_run_id,actions_attempt,created_at,heartbeat_at,deadline)
    VALUES('old','lease-1',${encoded},${"b".repeat(40)},${state},41,1,1,1,2)`
    yield* sql`INSERT INTO sandbox_cleanup_runs(repository_id,actions_run_id,actions_attempt,lease_id,policy,state,observed_at,updated_at)
    VALUES(${current.repositoryId},41,1,'lease-1',${encoded},'released',1,1)`
  })

for (const { commit, policy } of history.policies) {
  test(`released custody survives revalidation with saved policy ${commit}`, async () => {
    const fixture = await sandboxGithubFixture(current)
    fixture.mutateRun({
      status: "completed",
      conclusion: "success",
      referenced_workflows: [
        {
          sha: "c".repeat(40),
          path: `BNasraoui/workflowd/.github/workflows/agent-sandbox.yml@${"c".repeat(40)}`,
        },
      ],
    })
    try {
      await run(
        Effect.gen(function* () {
          yield* migrations
          yield* saveLease(policy)
          const store = yield* makeSandboxStore
          const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
          const leases = yield* makeSandboxLeaseService(github)
          expect((yield* store.read("old"))?.policy).toEqual(policy)
          expect((yield* store.cleanupRuns(true))[0]?.policy).toEqual(policy)
          yield* leases.revalidateReleased()
          expect((yield* store.read("old"))?.state).toBe("released")
          expect(yield* store.cleanupRuns()).toEqual([])
          expect(fixture.refCreates).toBe(0)
          const sql = yield* SqlClient.SqlClient
          expect(
            (yield* sql`SELECT owner,creation_pending FROM sandbox_lease_operations`)[0],
          ).toEqual({ owner: null, creation_pending: 0 })
        }),
      )
    } finally {
      await fixture.close()
    }
  })
}

test("inventory skips released history even when the configured policy has changed", async () => {
  const fixture = await sandboxGithubFixture(current)
  fixture.mutateRun({ status: "completed", conclusion: "success" })
  try {
    await run(
      Effect.gen(function* () {
        yield* migrations
        yield* saveLease(history.policies[0]!.policy)
        const store = yield* makeSandboxStore
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        yield* (yield* makeSandboxLeaseService(github)).reconcile([current])
        expect((yield* store.read("old"))?.state).toBe("released")
        expect(fixture.refDeletes).toBe(0)
      }),
    )
  } finally {
    await fixture.close()
  }
})

for (const { commit, metadata, receipt } of history.publications) {
  test(`saved publication ${commit} is readable without rewriting sealed metadata`, async () => {
    await run(
      Effect.gen(function* () {
        yield* migrations
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO sandbox_publications(run_id,actions_run_id,attempt,metadata,phase,deadline,receipt)
        VALUES('old',41,1,${JSON.stringify(metadata)},'operator_required',2,${receipt === null ? null : JSON.stringify(receipt)})`
        const store = yield* makePublishStore
        const saved = yield* store.read("old")
        expect(saved?.metadata).toEqual(metadata)
        expect<unknown>(saved?.receipt).toEqual(receipt)
      }),
    )
  })
}

test("current saved policy round-trips every field; schema changes require a new frozen fixture", async () => {
  // Adding, removing or changing a policy field requires an explicit persistence decision.
  expect(Schema.toJsonSchemaDocument(SandboxPolicy)).toMatchSnapshot()
  expect(Object.keys(SandboxPolicy.fields).sort()).toEqual(
    Object.keys(current).sort().concat("toolingSha").sort(),
  )
  await run(
    Effect.gen(function* () {
      yield* migrations
      const store = yield* makeSandboxStore
      const policy = { ...current, toolingSha: "c".repeat(40) }
      const saved = yield* store.request({
        runId: "new",
        leaseId: "lease-new",
        policy,
        sourceSha: "b".repeat(40),
        now: 1,
      })
      expect(saved.policy).toEqual(policy)
      const sql = yield* SqlClient.SqlClient
      expect((yield* sql`SELECT policy FROM sandbox_leases`)[0]?.policy).toBe(
        Schema.encodeSync(Schema.fromJsonString(SandboxPolicy))(policy),
      )
    }),
  )
})

test("creation migration upgrades pre-creation_pending operation rows without reviving released custody", async () => {
  await run(
    Effect.gen(function* () {
      yield* sandboxMigration
      yield* sandboxCleanupMigration
      yield* saveLease(history.policies[0]!.policy)
      yield* sandboxOperationMigration
      yield* sandboxCreationMigration
      const sql = yield* SqlClient.SqlClient
      expect(
        (yield* sql`SELECT owner,expires_at,creation_pending FROM sandbox_lease_operations`)[0],
      ).toEqual({ owner: null, expires_at: null, creation_pending: 0 })
      expect(yield* (yield* makeSandboxStore).active()).toEqual([])
    }),
  )
})

test("legacy policies cannot authorize a new runner acquisition", async () => {
  const fixture = await sandboxGithubFixture(current)
  try {
    await run(
      Effect.gen(function* () {
        yield* migrations
        yield* saveLease(history.policies[0]!.policy, "requested")
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github)
        const result = yield* Effect.result(leases.acquire("old"))
        expect(result._tag).toBe("Failure")
        expect(fixture.refCreates).toBe(0)
      }),
    )
  } finally {
    await fixture.close()
  }
})

test("historical publication evidence never authorizes a new approval", async () => {
  const fixture = await sandboxGithubFixture(current)
  try {
    await run(
      Effect.gen(function* () {
        yield* migrations
        yield* saveLease(current)
        const sql = yield* SqlClient.SqlClient
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const publisher = yield* makeSandboxPublisher(
          github,
          yield* makeSandboxLeaseService(github),
        )
        for (const { metadata } of history.publications) {
          yield* sql`DELETE FROM sandbox_publications`
          yield* sql`INSERT INTO sandbox_publications(run_id,actions_run_id,attempt,metadata,phase,deadline,base_ref)
          VALUES('old',41,1,${JSON.stringify(metadata)},'sealed',${Date.now() + 60000},'main')`
          expect(yield* publisher.poll("old")).toBe("operator_required")
          expect((yield* (yield* makePublishStore).read("old"))?.phase).toBe("operator_required")
        }
        expect(fixture.tokenRequests).toEqual([])
      }),
    )
  } finally {
    await fixture.close()
  }
})

test("reconciliation preserves an in-flight pre-body publication until its deadline", async () => {
  const fixture = await sandboxGithubFixture(current)
  try {
    await run(
      Effect.gen(function* () {
        yield* migrations
        yield* saveLease(history.policies[2]!.policy, "starting")
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO sandbox_publications(run_id,actions_run_id,attempt,metadata,phase,deadline,base_ref,artifact_id,artifact_digest)
        VALUES('old',41,1,${JSON.stringify(history.publications[2]!.metadata)},'approved',${Date.now() + 60000},'main',52,'sha256:legacy')`
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        yield* (yield* makeSandboxLeaseService(github)).reconcile()
        expect((yield* (yield* makeSandboxStore).read("old"))?.state).toBe("starting")
        expect(fixture.cancellations).toEqual([])
      }),
    )
  } finally {
    await fixture.close()
  }
})
