import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { runStoreMigrations } from "../../src/store/migrations"
import { makeSandboxStore } from "../../src/sandbox/store"
import { makePublishStore } from "../../src/sandbox/publish-store"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxPublisher } from "../../src/sandbox/publish"
import { sandboxGithubFixture, sandboxPublicationFixture } from "./harness"

const policy = {
  alias: "workflowd",
  repository: "BNasraoui/workflowd",
  repositoryId: 1306107007,
  installationId: 147573449,
  workflowSha: "a".repeat(40),
  appActorId: 306741873,
  tailscaleClientId: "fixture",
  tailscaleAudience: "fixture",
  publish: {
    baseRef: "main",
    environmentId: 9,
    publisherAppId: 5232172,
    publisherActorId: 339414993,
  },
}
const metadata = {
  sourceSha: "b".repeat(40),
  resultSha: "c".repeat(40),
  branch: "no/name/rules '$()\n雪",
  bundleSha256: "d".repeat(64),
  manifestSha256: "e".repeat(64),
}

for (const fault of [
  "none",
  "lost approval",
  "foreign artifact",
  "rerun",
  "bad job",
  "wrong environment",
  "expired",
  "wrong approval",
  "artifact replaced",
])
  test(`poll-only canary approval: ${fault}`, async () => {
    const fixture = await sandboxGithubFixture(policy)
    const publication = sandboxPublicationFixture(fixture, policy, "lease-1", fault)
    if (fault === "rerun") fixture.mutateRun({ run_attempt: 2 })
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* runStoreMigrations
          const leases = yield* makeSandboxStore
          yield* leases.request({
            runId: "run-1",
            leaseId: "lease-1",
            policy,
            sourceSha: metadata.sourceSha,
            now: Date.now(),
          })
          yield* leases.beginStart("run-1")
          yield* leases.recordRun("run-1", 41, 1)
          const store = yield* makePublishStore
          yield* store.seal({
            runId: "run-1",
            actionsRunId: 41,
            attempt: 1,
            metadata,
            deadline: Date.now() + (fault === "expired" ? -1 : 60000),
          })
          const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
          const remote = yield* makeSandboxLeaseService(github)
          const publisher = yield* makeSandboxPublisher(github, remote)
          yield* publisher.poll("run-1").pipe(Effect.result)
          if (fault === "none" || fault === "lost approval") {
            // Reopening the service must read the exact approval, never POST again.
            const resumed = yield* makeSandboxPublisher(github, remote)
            yield* resumed.poll("run-1")
            expect(publication.posts).toBe(1)
            expect((yield* store.read("run-1"))?.phase).toBe("probed")
            expect(JSON.stringify(publication.reviews)).toContain(metadata.manifestSha256)
            expect(fixture.tokenRequests).toContainEqual({
              repository_ids: [policy.repositoryId],
              permissions: { actions: "read", deployments: "write" },
            })
          } else if (["wrong approval", "artifact replaced"].includes(fault)) {
            const resumed = yield* makeSandboxPublisher(github, remote)
            expect((yield* Effect.result(resumed.poll("run-1")))._tag).toBe("Failure")
            expect(publication.posts).toBe(1)
            expect((yield* store.read("run-1"))?.phase).not.toBe("probed")
          } else expect(publication.posts).toBe(0)
          expect(publication.downloads).toBe(0)
          expect((yield* store.read("run-1"))?.metadata.branch).toBe(metadata.branch)
          expect((yield* Effect.result(publisher.poll("unknown")))._tag).toBe("Failure")
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
      )
    } finally {
      await fixture.close()
    }
  })
