import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Schema } from "effect"
import { Command } from "../../src/domain/command"
import type { ReviewResult } from "../../src/domain/review-result"
import { FixWork, ReviewWork } from "../../src/domain/work"
import { PullRequestObservation } from "../../src/domain/pull-request-transition"
import { WorkflowStoreLive } from "../../src/store"

export const sampleBaseSha = "d".repeat(40)
export const sampleHeadSha = "a".repeat(40)

export const decodePullRequestEvent = Schema.decodeUnknownSync(PullRequestObservation)

export const samplePullRequestEvent = decodePullRequestEvent({
  _tag: "PullRequest",
  action: "opened",
  installationId: 91,
  repository: {
    id: 42,
    fullName: "example-owner/example",
    name: "example",
    owner: "example-owner",
  },
  pullRequest: {
    number: 7,
    author: "opencode-agent",
    baseRef: "main",
    baseSha: sampleBaseSha,
    draft: false,
    headRef: "opencode/example-job",
    headRepositoryFullName: "example-owner/example",
    headSha: sampleHeadSha,
    state: "open",
  },
})

export const changesRequestedReview: ReviewResult = {
  verdict: "changes_requested",
  summary: "One issue.",
  findings: [
    {
      severity: "high",
      title: "Unsafe retry",
      body: "The operation is not idempotent.",
    },
  ],
}

const workInput = {
  id: 11,
  installationId: 91,
  repositoryId: 42,
  repositoryFullName: "example-owner/example",
  pullRequestNumber: 7,
  author: "opencode-agent",
  target: {
    baseRef: "main",
    baseSha: sampleBaseSha,
    headSha: sampleHeadSha,
    headRef: "opencode/example-job",
    headRepositoryFullName: "example-owner/example",
  },
  generation: 1,
  reviewRequestNumber: 1,
  workerId: "test-worker",
  attempt: 1,
} as const

export const makeReviewWork = (
  overrides: Partial<Omit<typeof ReviewWork.Encoded, "_tag" | "target">> & {
    readonly target?: Partial<typeof ReviewWork.Encoded.target>
  } = {},
) =>
  Schema.decodeUnknownSync(ReviewWork)({
    _tag: "ReviewWork",
    ...workInput,
    ...overrides,
    target: { ...workInput.target, ...overrides.target },
  })

export const makeFixWork = (
  overrides: Partial<Omit<typeof FixWork.Encoded, "_tag" | "target">> & {
    readonly target?: Partial<typeof FixWork.Encoded.target>
  } = {},
) =>
  Schema.decodeUnknownSync(FixWork)({
    _tag: "FixWork",
    ...workInput,
    sourcePublicationId: 31,
    review: changesRequestedReview,
    ...overrides,
    target: { ...workInput.target, ...overrides.target },
  })

export const sampleCommandEvent = (command: "review" | "fix" | "status", commentId: number) =>
  Schema.decodeUnknownSync(Command)({
    _tag: "Command",
    action: "created",
    command,
    commentId,
    commenter: "example-owner",
    installationId: 91,
    pullRequestNumber: 7,
    repository: samplePullRequestEvent.repository,
  })

export const makeDatabaseLayer = () => SqliteClient.layer({ filename: ":memory:" })

export const makeStoreLayer = () => {
  const database = makeDatabaseLayer()
  return WorkflowStoreLive.pipe(Layer.provideMerge(database))
}

type StoreServices = Layer.Layer.Success<ReturnType<typeof makeStoreLayer>>

export const runWithStore = <A, E>(effect: Effect.Effect<A, E, StoreServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(makeStoreLayer())))
