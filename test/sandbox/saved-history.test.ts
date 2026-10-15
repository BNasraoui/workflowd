import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Logger, Schema, type SchemaAST } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SandboxPolicy } from "../../src/sandbox/config"
import { makeSandboxStore } from "../../src/sandbox/store"
import { makeSandboxPublisher } from "../../src/sandbox/publish"
import {
  makePublishStore,
  ResultMetadata,
  PublicationReceipt,
} from "../../src/sandbox/publish-store"
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
import { sandboxGithubFixture, sandboxPublicationFixture } from "./harness"
import history from "./fixtures/saved-history.json"

// Frozen values from the named git revisions, including pre-merge development shapes.
// Never build these policies by spreading today's config or relaxing its schema.
const current = Schema.decodeUnknownSync(SandboxPolicy)(history.policies[3]!.policy)
const validMetadata = Schema.decodeUnknownSync(ResultMetadata)({
  ...history.publications[4]!.metadata,
  commitMessage: "Agent message",
})

// Inspect every nested struct independently of snapshots, which can be updated blindly.
const expectEveryField = (ast: SchemaAST.AST, value: unknown, path: string) => {
  if (ast._tag !== "Objects") return
  expect(value, path).toBeObject()
  const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value)
  expect(Object.keys(object).sort(), path).toEqual(
    ast.propertySignatures.map((field) => String(field.name)).sort(),
  )
  for (const field of ast.propertySignatures)
    expectEveryField(field.type, object[String(field.name)], `${path}.${String(field.name)}`)
}
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
  const policy = { ...current, toolingSha: "c".repeat(40) }
  expectEveryField(SandboxPolicy.ast, policy, "policy")
  expectEveryField(ResultMetadata.ast, validMetadata, "metadata")
  expectEveryField(
    PublicationReceipt.ast,
    { ...history.publications[4]!.receipt, cause: "historical cause" },
    "receipt",
  )
  await run(
    Effect.gen(function* () {
      yield* migrations
      const store = yield* makeSandboxStore
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

for (const [name, policy] of [
  ["missing agentImage", history.policies[2]!.policy],
  ["untrusted agentImage", { ...current, agentImage: "docker.io/attacker/image:latest" }],
  ["invalid coAuthor", { ...current, publish: { ...current.publish, coAuthor: "invalid" } }],
] as const) {
  test(`ready leases fail closed with ${name}`, async () => {
    const fixture = await sandboxGithubFixture(current)
    try {
      await run(
        Effect.gen(function* () {
          yield* migrations
          yield* saveLease(policy, "starting")
          const sql = yield* SqlClient.SqlClient
          const transport = {
            leaseId: "lease-1",
            peerId: "peer-1",
            repositoryPath: "/workspace/repository",
            address: "runner",
            port: 22,
            knownHostsFile: "/tmp/known-hosts",
            identityFile: "/tmp/identity",
          }
          yield* sql`UPDATE sandbox_leases SET state='ready',peer_id='peer-1',transport=${JSON.stringify(transport)} WHERE run_id='old'`
          const store = yield* makeSandboxStore
          const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
          const leases = yield* makeSandboxLeaseService(github)
          expect((yield* Effect.result(leases.acquire("old")))._tag).toBe("Failure")
          expect((yield* store.read("old"))?.state).toBe("ready")
          expect(fixture.tokenRequests).toEqual([])
          expect(fixture.refCreates).toBe(0)
        }),
      )
    } finally {
      await fixture.close()
    }
  })
}

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
        // Valid current metadata isolates the policy gate from the metadata gate.
        for (const { policy } of history.policies.slice(1, 3)) {
          yield* sql`DELETE FROM sandbox_publications`
          yield* sql`DELETE FROM sandbox_leases`
          yield* sql`DELETE FROM sandbox_cleanup_runs`
          yield* saveLease(policy)
          yield* sql`INSERT INTO sandbox_publications(run_id,actions_run_id,attempt,metadata,phase,deadline,base_ref)
          VALUES('old',41,1,${JSON.stringify(validMetadata)},'sealed',${Date.now() + 60000},'main')`
          const result = yield* publisher.poll("old").pipe(Effect.result)
          expect(fixture.tokenRequests).toEqual([])
          expect(result).toMatchObject({ _tag: "Success", success: "operator_required" })
          expect((yield* (yield* makePublishStore).read("old"))?.phase).toBe("operator_required")
          expect(yield* publisher.poll("old")).toBe("operator_required")
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

test("reconciliation retains a saved receipt without commitSha without attempting PR recovery", async () => {
  const policy = { ...current, publish: { ...current.publish!, environmentId: 9 } }
  const fixture = await sandboxGithubFixture(policy)
  const publication = sandboxPublicationFixture(
    fixture,
    policy,
    "lease-1",
    "saved receipt",
    validMetadata.branch,
  )
  const messages: unknown[] = []
  try {
    await run(
      Effect.gen(function* () {
        yield* migrations
        yield* saveLease(policy, "starting")
        const store = yield* makePublishStore
        yield* store.seal({
          runId: "old",
          actionsRunId: 41,
          attempt: 1,
          metadata: validMetadata,
          baseRef: "main",
          deadline: Date.now() + 60000,
        })
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const publisher = yield* makeSandboxPublisher(
          github,
          yield* makeSandboxLeaseService(github),
        )
        expect(yield* publisher.poll("old")).toBe("approved")
        const sql = yield* SqlClient.SqlClient
        const receipt = history.publications[1]!.receipt
        yield* sql`UPDATE sandbox_publications SET receipt=${JSON.stringify(receipt)} WHERE run_id='old'`
        expect(yield* publisher.poll("old")).toBe("operator_required")
        expect<unknown>((yield* store.read("old"))?.receipt).toEqual(receipt)
        expect(publication.posts).toBe(1)
        expect(messages).toEqual([])
      }).pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => messages.push(message))]))),
    )
  } finally {
    await fixture.close()
  }
})
