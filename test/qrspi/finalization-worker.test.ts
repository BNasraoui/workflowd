import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { GitHubClientError } from "../../src/github"
import {
  runGenericReviewHandoffIterationWith,
  runPullRequestPublishIterationWith,
} from "../../src/qrspi/finalization-worker"
import {
  QrspiRepositoryError,
  type FinalPullRequestIntent,
  type FinalPullRequestObservation,
} from "../../src/qrspi/ports"
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
  state: "open",
  title: intent.title,
  baseRef: intent.baseRef,
  headRef: intent.headRef,
  headSha: intent.headSha,
  draft: false,
  body,
  bodySha256: intent.bodySha256,
  url: "https://example.test/owner/repo/pull/17",
}

test.each([
  ["closed", { state: "closed" as const }],
  ["retitled", { title: "Different title" }],
])("PullRequestPublish reconciles a %s referenced PR during recovery", async (_case, change) => {
  const calls: string[] = []
  const changed = { ...observation, ...change }
  const result = await Effect.runPromise(
    runPullRequestPublishIterationWith({
      workerId: "publisher",
      leaseDurationMs: 60_000,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      randomId: () => "22222222-2222-4222-8222-222222222222",
      store: {
        findPullRequestPublicationRecovery: () =>
          Effect.succeed({ ...work, publicationReference: observation.reference }),
        claimFinalizationOperation: () => Effect.die("unexpected claim"),
        bindPullRequestPublication: () => Effect.die("unexpected publication binding"),
        bindPullRequestPublicationReference: () => Effect.die("unexpected reference binding"),
        isFinalizationOperationCurrent: () => Effect.succeed(true),
        completePullRequestPublication: () => Effect.die("unexpected completion"),
        recordPullRequestPublicationFailure: () => Effect.die("unexpected failure recording"),
        recordStalePullRequestPublicationEffect: ({ reference }) =>
          Effect.sync(() => {
            calls.push(`reconcile:${reference.number}`)
            return "reconciling" as const
          }),
      },
      repository: {
        ...repository(calls),
        observeFinalPullRequestReference: () =>
          Effect.sync(() => {
            calls.push("observe-reference")
            return changed
          }),
      },
    }),
  )

  expect(result).toBe("reconciling")
  expect(calls).toEqual(["observe-reference", "reconcile:17"])
})

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
  observeFinalPullRequestReference: () =>
    Effect.sync(() => {
      calls.push("observe-reference")
      return observation
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
        bindPullRequestPublicationReference: () => Effect.die("unexpected reference binding"),
        isFinalizationOperationCurrent: () => Effect.succeed(false),
        completePullRequestPublication: () => Effect.die("unexpected completion"),
        recordPullRequestPublicationFailure: () => Effect.die("unexpected failure recording"),
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
        bindPullRequestPublicationReference: ({ reference }) =>
          Effect.sync(() => {
            calls.push(`bind-reference:${reference.number}`)
            return "bound" as const
          }),
        isFinalizationOperationCurrent: () => Effect.succeed(current),
        completePullRequestPublication: () => Effect.die("unexpected completion"),
        recordPullRequestPublicationFailure: () => Effect.die("unexpected failure recording"),
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
  expect(calls).toEqual([
    "observe",
    "create",
    "bind-reference:17",
    "observe-reference",
    "reconcile:17",
  ])
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
        bindPullRequestPublicationReference: () => Effect.die("unexpected reference binding"),
        isFinalizationOperationCurrent: () => Effect.succeed(true),
        completePullRequestPublication: () => Effect.succeed("stale" as const),
        recordPullRequestPublicationFailure: () => Effect.die("unexpected failure recording"),
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

test("PullRequestPublish records a created PR whose branch advanced during creation", async () => {
  const calls: string[] = []
  const changed = { ...observation, headSha: "e".repeat(40) }
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
        bindPullRequestPublicationReference: ({ reference }) =>
          Effect.sync(() => {
            calls.push(`bind-reference:${reference.number}`)
            return "bound" as const
          }),
        isFinalizationOperationCurrent: () => Effect.succeed(true),
        completePullRequestPublication: () => Effect.die("unexpected completion"),
        recordPullRequestPublicationFailure: () => Effect.die("unexpected failure recording"),
        recordStalePullRequestPublicationEffect: ({ reference, observation }) =>
          Effect.sync(() => {
            calls.push(`reconcile:${reference.number}:${observation?.headSha}`)
            return "reconciling" as const
          }),
      },
      repository: {
        ...repository(calls),
        observeFinalPullRequestReference: () =>
          Effect.sync(() => {
            calls.push("observe-reference")
            return changed
          }),
      },
    }),
  )

  expect(result).toBe("reconciling")
  expect(calls).toEqual([
    "observe",
    "create",
    "bind-reference:17",
    "observe-reference",
    `reconcile:17:${changed.headSha}`,
  ])
})

test.each(["observe", "create"] as const)(
  "PullRequestPublish durably records a failed %s call",
  async (failurePoint) => {
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
          bindPullRequestPublicationReference: () => Effect.die("unexpected reference binding"),
          isFinalizationOperationCurrent: () => Effect.succeed(true),
          completePullRequestPublication: () => Effect.die("unexpected completion"),
          recordStalePullRequestPublicationEffect: () => Effect.die("unexpected stale effect"),
          recordPullRequestPublicationFailure: ({ error }) =>
            Effect.sync(() => {
              calls.push(`record:${error}`)
              return "waiting_external" as const
            }),
        },
        repository: {
          ...repository(calls),
          observeFinalPullRequest: () =>
            failurePoint === "observe"
              ? Effect.fail(
                  new QrspiRepositoryError({
                    operation: "observe final pull request",
                    cause: new Error("observe unavailable"),
                  }),
                )
              : Effect.sync(() => {
                  calls.push("observe")
                  return null
                }),
          createFinalPullRequest: () =>
            failurePoint === "create"
              ? Effect.fail(
                  new QrspiRepositoryError({
                    operation: "create final pull request",
                    cause: new Error("create unavailable"),
                  }),
                )
              : Effect.die("unexpected create"),
        },
      }),
    )

    expect(result).toBe("waiting_external")
    expect(calls.at(-1)).toContain("record:QrspiRepositoryError")
  },
)

test("PullRequestPublish exhausts repeated observation failures into a human wait", async () => {
  let attempts = 0
  const results: string[] = []
  for (let index = 0; index < 5; index += 1) {
    results.push(
      await Effect.runPromise(
        runPullRequestPublishIterationWith({
          workerId: "publisher",
          leaseDurationMs: 60_000,
          now: () => new Date("2026-07-22T00:00:00.000Z"),
          randomId: () => "22222222-2222-4222-8222-222222222222",
          store: {
            findPullRequestPublicationRecovery: () => {
              const { leaseToken: _leaseToken, ...recovery } = work
              return Effect.succeed(recovery)
            },
            claimFinalizationOperation: () => Effect.die("unexpected claim"),
            bindPullRequestPublication: () => Effect.die("unexpected binding"),
            bindPullRequestPublicationReference: () => Effect.die("unexpected reference binding"),
            isFinalizationOperationCurrent: () => Effect.succeed(true),
            completePullRequestPublication: () => Effect.die("unexpected completion"),
            recordStalePullRequestPublicationEffect: () => Effect.die("unexpected stale effect"),
            recordPullRequestPublicationFailure: () =>
              Effect.sync(() => {
                attempts += 1
                return attempts === 5 ? ("waiting_human" as const) : ("waiting_external" as const)
              }),
          },
          repository: {
            ...repository([]),
            observeFinalPullRequest: () =>
              Effect.fail(
                new QrspiRepositoryError({
                  operation: "observe final pull request",
                  cause: new Error("permission denied"),
                }),
              ),
          },
        }),
      ),
    )
  }

  expect(results).toEqual([
    "waiting_external",
    "waiting_external",
    "waiting_external",
    "waiting_external",
    "waiting_human",
  ])
})

test("GenericReviewHandoff opens an operation gate when ingestion fails", async () => {
  const calls: string[] = []
  const result = await Effect.runPromise(
    runGenericReviewHandoffIterationWith({
      workerId: "handoff",
      leaseDurationMs: 60_000,
      installationId: 123,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
      randomId: () => "33333333-3333-4333-8333-333333333333",
      store: {
        claimGenericReviewHandoff: () =>
          Effect.succeed({
            operationId: "handoff:1",
            leaseToken: "33333333-3333-4333-8333-333333333333",
            pullRequest: observation,
          }),
        isGenericReviewHandoffCurrent: () => Effect.succeed(true),
        completeGenericReviewHandoff: () => Effect.die("unexpected completion"),
        failGenericReviewHandoff: ({ error }) =>
          Effect.sync(() => {
            calls.push(error)
            return "waiting_human" as const
          }),
      },
      workflowStore: { ingestPullRequestSnapshot: () => Effect.die("unexpected ingestion") },
      github: {
        publishReview: () => Effect.die("unexpected publication"),
        fetchPullRequestSnapshot: () =>
          Effect.fail(
            new GitHubClientError({
              operation: "get pull request",
              cause: new Error("snapshot unavailable"),
            }),
          ),
      },
    }),
  )

  expect(result).toBe("waiting_human")
  expect(calls[0]).toContain("GitHubClientError")
})
