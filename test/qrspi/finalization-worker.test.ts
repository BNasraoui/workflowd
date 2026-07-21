import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { runPullRequestPublishIterationWith } from "../../src/qrspi/finalization-worker"
import type { FinalPullRequestIntent, FinalPullRequestObservation } from "../../src/qrspi/ports"
import type { FinalizationOperationLease } from "../../src/qrspi/store"

const repositoryReference = {
  providerInstanceId: "github",
  repositoryId: "42",
  repositoryFullName: "owner/repo",
}
const body = "Delivery evidence"
const intent: FinalPullRequestIntent = {
  repository: repositoryReference,
  baseRef: "main",
  headRef: "feature/ticket",
  headSha: "f".repeat(40),
  title: "Finish ticket",
  body,
  bodySha256: createHash("sha256").update(body).digest("hex"),
  draft: false,
}
const work: FinalizationOperationLease = {
  operationId: "workflow:1:PullRequestPublish:1",
  operationRevision: 1,
  attempt: 1,
  leaseToken: "11111111-1111-4111-8111-111111111111",
  scope: { _tag: "GenerationScope", workflowId: "workflow", generation: 1 },
  kind: "PullRequestPublish",
  input: {
    ...intent,
    checkpoint: {
      repository: repositoryReference,
      workflowId: "workflow",
      generation: 1,
      stageKey: "implementation",
      stageRevision: 1,
      checkpointId: "checkpoint-1",
      baseSha: "a".repeat(40),
      finalSha: intent.headSha,
      commits: [
        {
          position: 1,
          commitSha: intent.headSha,
          parentSha: "a".repeat(40),
          changedPaths: ["src/change.ts"],
          operationId: "publish:1",
        },
      ],
      changedPaths: ["src/change.ts"],
      preparedDeliveryEvidenceSha256: "b".repeat(64),
    },
    preparedDeliveryEvidence: {
      summary: "Scenario passes",
      scenarios: [{ scenario: 0, evidence: "Focused tests pass" }],
    },
    verificationOperationId: "verify:1",
  },
  repository: repositoryReference,
  baseRef: intent.baseRef,
  headRef: intent.headRef,
  currentHeadSha: intent.headSha,
}
const observation: FinalPullRequestObservation = {
  reference: { repository: repositoryReference, number: 17 },
  baseRef: intent.baseRef,
  headRef: intent.headRef,
  headSha: intent.headSha,
  draft: false,
  body,
  bodySha256: intent.bodySha256,
  url: "https://example.test/owner/repo/pull/17",
}

const repository = (calls: string[]) => ({
  inspect: () => Effect.die("unexpected inspect"),
  hasOpenPullRequest: () => Effect.die("unexpected pull request check"),
  observeBranch: () => Effect.die("unexpected branch observation"),
  observeAcceptedBranch: () => Effect.die("unexpected accepted branch observation"),
  createBranch: () => Effect.die("unexpected branch creation"),
  createFinalPullRequest: () =>
    Effect.sync(() => {
      calls.push("create")
      return observation.reference
    }),
  observeFinalPullRequest: () =>
    Effect.sync(() => {
      calls.push("observe")
      return calls.includes("create") ? observation : null
    }),
})

test("PullRequestPublish does not create a PR after its generation is superseded", async () => {
  const calls: string[] = []
  const result = await Effect.runPromise(
    runPullRequestPublishIterationWith({
      workerId: "publisher",
      leaseDurationMs: 60_000,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      randomId: () => "22222222-2222-4222-8222-222222222222",
      store: {
        findPullRequestPublicationRecovery: () => Effect.succeed(null),
        claimFinalizationOperation: () => Effect.succeed(work),
        bindPullRequestPublication: () => Effect.succeed("bound" as const),
        isFinalizationOperationCurrent: () => Effect.succeed(false),
        completePullRequestPublication: () => Effect.die("unexpected completion"),
        recordStalePullRequestPublicationEffect: () => Effect.die("unexpected stale effect"),
      },
      repository: repository(calls),
    }),
  )

  expect(result).toBe("stale")
  expect(calls).toEqual(["observe"])
})

test("PullRequestPublish durably reconciles a PR created as currentness is lost", async () => {
  const calls: string[] = []
  let current = true
  const result = await Effect.runPromise(
    runPullRequestPublishIterationWith({
      workerId: "publisher",
      leaseDurationMs: 60_000,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      randomId: () => "22222222-2222-4222-8222-222222222222",
      store: {
        findPullRequestPublicationRecovery: () => Effect.succeed(null),
        claimFinalizationOperation: () => Effect.succeed(work),
        bindPullRequestPublication: () => Effect.succeed("bound" as const),
        isFinalizationOperationCurrent: () => Effect.succeed(current),
        completePullRequestPublication: () => Effect.die("unexpected completion"),
        recordStalePullRequestPublicationEffect: ({ reference }) =>
          Effect.sync(() => {
            calls.push(`reconcile:${reference.number}`)
            return "reconciling" as const
          }),
      },
      repository: {
        ...repository(calls),
        createFinalPullRequest: () =>
          Effect.sync(() => {
            calls.push("create")
            current = false
            return observation.reference
          }),
      },
    }),
  )

  expect(result).toBe("reconciling")
  expect(calls).toEqual(["observe", "create", "observe", "reconcile:17"])
})

test("PullRequestPublish reconciles when completion discovers supersession", async () => {
  const calls: string[] = ["create"]
  const result = await Effect.runPromise(
    runPullRequestPublishIterationWith({
      workerId: "publisher",
      leaseDurationMs: 60_000,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      randomId: () => "22222222-2222-4222-8222-222222222222",
      store: {
        findPullRequestPublicationRecovery: () => Effect.succeed(null),
        claimFinalizationOperation: () => Effect.succeed(work),
        bindPullRequestPublication: () => Effect.succeed("bound" as const),
        isFinalizationOperationCurrent: () => Effect.succeed(true),
        completePullRequestPublication: () => Effect.succeed("stale" as const),
        recordStalePullRequestPublicationEffect: ({ reference }) =>
          Effect.sync(() => {
            calls.push(`reconcile:${reference.number}`)
            return "reconciling" as const
          }),
      },
      repository: repository(calls),
    }),
  )

  expect(result).toBe("reconciling")
  expect(calls).toEqual(["create", "observe", "reconcile:17"])
})
