import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  AuthoritativePullRequestSnapshot,
  PullRequestObservation,
  TrackedPullRequestState,
  decidePullRequestTransition,
} from "../../src/domain/pull-request-transition"

const decodeObservation = Schema.decodeUnknownSync(PullRequestObservation)
const decodeSnapshot = Schema.decodeUnknownSync(AuthoritativePullRequestSnapshot)
const decodeTracked = Schema.decodeUnknownSync(TrackedPullRequestState)

const target = {
  baseSha: "a".repeat(40),
  baseRef: "main",
  headSha: "b".repeat(40),
  headRef: "feature/review",
  headRepositoryFullName: "owner/repository",
}

const pullRequest = {
  number: 7,
  author: "author",
  ...target,
  draft: false,
  state: "open",
  updatedAt: "2026-07-20T10:00:00.000Z",
} as const

const repository = {
  id: 42,
  fullName: "owner/repository",
  name: "repository",
  owner: "owner",
} as const

const tracked = decodeTracked({
  _tag: "TrackedPullRequestState",
  installationId: 91,
  repository,
  pullRequest,
  generation: 1,
  latestReviewRequestNumber: 1,
  reviewRequestActive: false,
})

const observe = (pullRequestOverrides: Record<string, string>) =>
  decodeObservation({
    _tag: "PullRequest",
    action: "synchronize",
    installationId: 91,
    repository,
    pullRequest: {
      ...pullRequest,
      updatedAt: "2026-07-20T10:00:01.000Z",
      ...pullRequestOverrides,
    },
  })

const edited = (pullRequestOverrides: Record<string, string>) =>
  decodeObservation({
    _tag: "PullRequest",
    action: "edited",
    installationId: 91,
    repository,
    pullRequest: {
      ...pullRequest,
      updatedAt: "2026-07-20T10:00:01.000Z",
      ...pullRequestOverrides,
    },
  })

describe("pull request transition decisions", () => {
  test.each([
    ["base SHA", { baseSha: "c".repeat(40) }],
    ["base ref", { baseRef: "release" }],
    ["head SHA", { headSha: "d".repeat(40) }],
    ["head ref", { headRef: "feature/renamed" }],
    ["head repository provenance", { headRepositoryFullName: "fork/repository" }],
  ])("advances Generation when the %s changes", (_, changedTarget) => {
    const decision = decidePullRequestTransition(tracked, observe(changedTarget))

    expect(decision._tag).toBe("ApplySnapshot")
    if (decision._tag === "ApplySnapshot") {
      expect(Number(decision.generation)).toBe(2)
      expect(decision.intents.map((intent) => intent._tag)).toEqual([
        "SupersedeGeneration",
        "QueueReview",
      ])
    }
  })

  test.each([
    [
      "stale",
      { headSha: "c".repeat(40), updatedAt: "2026-07-20T09:59:59.000Z" },
      "IgnoreObservation",
    ],
    [
      "equal-timestamp conflict",
      { headSha: "c".repeat(40), updatedAt: pullRequest.updatedAt },
      "RequestReconciliation",
    ],
    [
      "missing-timestamp target change",
      { headSha: "c".repeat(40), updatedAt: undefined },
      "RequestReconciliation",
    ],
  ])("classifies a %s observation", (_, changes, expectedTag) => {
    const decision = decidePullRequestTransition(
      tracked,
      decodeObservation({
        _tag: "PullRequest",
        action: "synchronize",
        installationId: 91,
        repository,
        pullRequest: { ...pullRequest, ...changes },
      }),
    )

    expect(String(decision._tag)).toBe(expectedTag)
  })

  test("applies an authoritative correction despite an ambiguous ordering watermark", () => {
    const decision = decidePullRequestTransition(
      tracked,
      decodeSnapshot({
        _tag: "AuthoritativePullRequestSnapshot",
        installationId: 91,
        repository,
        pullRequest: {
          ...pullRequest,
          baseSha: "c".repeat(40),
          updatedAt: pullRequest.updatedAt,
        },
      }),
    )

    expect(decision._tag).toBe("ApplySnapshot")
    if (decision._tag === "ApplySnapshot") {
      expect(Number(decision.generation)).toBe(2)
      expect(String(decision.snapshot.pullRequest.baseSha)).toBe("c".repeat(40))
    }
  })

  test("queues a Review Request when edited changes the exact Review Target", () => {
    const decision = decidePullRequestTransition(tracked, edited({ baseRef: "release" }))

    expect(decision._tag).toBe("ApplySnapshot")
    if (decision._tag === "ApplySnapshot") {
      expect(Number(decision.generation)).toBe(2)
      expect(decision.intents.map((intent) => intent._tag)).toEqual([
        "SupersedeGeneration",
        "QueueReview",
      ])
    }
  })

  test("does not queue a Review Request for a same-target edited observation", () => {
    const decision = decidePullRequestTransition(tracked, edited({}))

    expect(decision._tag).toBe("ApplySnapshot")
    if (decision._tag === "ApplySnapshot") {
      expect(Number(decision.generation)).toBe(1)
      expect(decision.intents).toEqual([])
    }
  })

  test("does not queue a same-target edit when the current Generation has no Review Request", () => {
    const observedWithoutReview = decodeTracked({
      _tag: "TrackedPullRequestState",
      installationId: 91,
      repository,
      pullRequest,
      generation: 1,
      reviewRequestActive: false,
    })

    const decision = decidePullRequestTransition(observedWithoutReview, edited({}))

    expect(decision._tag).toBe("ApplySnapshot")
    if (decision._tag === "ApplySnapshot") {
      expect(Number(decision.generation)).toBe(1)
      expect(decision.intents).toEqual([])
    }
  })
})
