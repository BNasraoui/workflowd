import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  AuthoritativePullRequestSnapshot,
  PullRequestObservation,
  TrackedPullRequestState,
  decidePullRequestTransition,
} from "../../src/domain/pull-request-transition"
import { ReviewTarget, reviewTargetFieldNames } from "../../src/domain/review-target"

const target = {
  baseRef: "main",
  baseSha: "d".repeat(40),
  headRef: "opencode/example-job",
  headRepositoryFullName: "example-owner/example",
  headSha: "a".repeat(40),
} as const

const replacements: { readonly [K in keyof typeof target]: string } = {
  baseRef: "release",
  baseSha: "b".repeat(40),
  headRef: "opencode/other-job",
  headRepositoryFullName: "fork-owner/example",
  headSha: "c".repeat(40),
}

const repository = {
  id: 42,
  fullName: "example-owner/example",
  name: "example",
  owner: "example-owner",
} as const

const trackedAt = "2026-07-19T12:00:00Z"
const observedAt = "2026-07-19T12:05:00Z"

const pullRequest = (fields: Record<string, string>, updatedAt: string | null) => ({
  number: 7,
  author: "opencode-agent",
  draft: false,
  state: "open",
  ...target,
  ...fields,
  ...(updatedAt === null ? {} : { updatedAt }),
})

const trackedState = (fields: Record<string, string> = {}, updatedAt: string | null = trackedAt) =>
  Schema.decodeUnknownSync(TrackedPullRequestState)({
    _tag: "TrackedPullRequestState",
    installationId: 91,
    repository,
    pullRequest: pullRequest(fields, updatedAt),
    generation: 3,
    latestReviewRequestNumber: 1,
    reviewRequestActive: false,
  })

const observation = (fields: Record<string, string> = {}, updatedAt: string | null = observedAt) =>
  Schema.decodeUnknownSync(PullRequestObservation)({
    _tag: "PullRequest",
    action: "synchronize",
    installationId: 91,
    repository,
    pullRequest: pullRequest(fields, updatedAt),
  })

const authoritative = (fields: Record<string, string> = {}) =>
  Schema.decodeUnknownSync(AuthoritativePullRequestSnapshot)({
    _tag: "AuthoritativePullRequestSnapshot",
    installationId: 91,
    repository,
    pullRequest: pullRequest(fields, observedAt),
  })

describe("Review Target identity", () => {
  test("declares exactly the base and head fields that identify a Review Target", () => {
    expect([...reviewTargetFieldNames].sort()).toEqual([
      "baseRef",
      "baseSha",
      "headRef",
      "headRepositoryFullName",
      "headSha",
    ])
    expect(Object.keys(ReviewTarget.fields).sort()).toEqual([...reviewTargetFieldNames].sort())
  })

  test("changing any single Review Target field starts a newer Generation", () => {
    for (const field of reviewTargetFieldNames) {
      const decision = decidePullRequestTransition(
        trackedState(),
        observation({ [field]: replacements[field] }),
      )

      expect(decision._tag, field).toBe("ApplySnapshot")
      expect(Number(decision.generation), field).toBe(4)
      if (decision._tag !== "ApplySnapshot") continue
      expect(
        decision.intents.map((intent) => intent._tag),
        field,
      ).toContain("SupersedeGeneration")
    }
  })

  test("an authoritative snapshot starts a newer Generation for any single field", () => {
    for (const field of reviewTargetFieldNames) {
      const decision = decidePullRequestTransition(
        trackedState(),
        authoritative({ [field]: replacements[field] }),
      )

      expect(decision._tag, field).toBe("ApplySnapshot")
      expect(Number(decision.generation), field).toBe(4)
    }
  })

  test("an identical Review Target keeps the current Generation", () => {
    const decision = decidePullRequestTransition(trackedState(), observation())

    expect(decision._tag).toBe("ApplySnapshot")
    expect(Number(decision.generation)).toBe(3)
    if (decision._tag !== "ApplySnapshot") return
    expect(decision.intents.map((intent) => intent._tag)).not.toContain("SupersedeGeneration")
  })

  test("a field outside the Review Target keeps the current Generation", () => {
    const decision = decidePullRequestTransition(trackedState(), observation({ author: "someone" }))

    expect(decision._tag).toBe("ApplySnapshot")
    expect(Number(decision.generation)).toBe(3)
  })

  test("an untimed observation that changes any single field is ambiguous", () => {
    for (const field of reviewTargetFieldNames) {
      const decision = decidePullRequestTransition(
        trackedState({}, null),
        observation({ [field]: replacements[field] }, null),
      )

      expect(decision._tag, field).toBe("RequestReconciliation")
    }
  })

  test("an untimed observation with the same Review Target is not ambiguous", () => {
    const decision = decidePullRequestTransition(trackedState({}, null), observation({}, null))

    expect(decision._tag).toBe("ApplySnapshot")
    expect(Number(decision.generation)).toBe(3)
  })
})
