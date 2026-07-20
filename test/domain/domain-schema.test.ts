import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { FixResult } from "../../src/domain/fix-result"
import { Publication } from "../../src/domain/publication"
import { ReviewTarget } from "../../src/domain/review-target"
import { ReviewWork, Work } from "../../src/domain/work"

const baseSha = "a".repeat(40)
const headSha = "b".repeat(40)

const target = {
  baseSha,
  baseRef: "main",
  headSha,
  headRef: "feature/retry",
  headRepositoryFullName: "owner/repository",
}

const reviewWork = {
  _tag: "ReviewWork",
  id: 11,
  installationId: 91,
  repositoryId: 42,
  repositoryFullName: "owner/repository",
  pullRequestNumber: 7,
  author: "author",
  target,
  generation: 1,
  reviewRequestNumber: 1,
  workerId: "reviewer-1",
  attempt: 1,
}

const actionableReview = {
  verdict: "changes_requested",
  summary: "One issue requires a change.",
  findings: [
    {
      severity: "high",
      title: "Retry duplicates writes",
      body: "The retry path repeats a non-idempotent operation.",
    },
  ],
}

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Effect.runPromise(Schema.decodeUnknown(schema)(input))

describe("domain schemas", () => {
  test("validates branded identifiers and Git object IDs", async () => {
    await expect(decode(ReviewWork, { ...reviewWork, id: 0 })).rejects.toBeDefined()
    await expect(
      decode(ReviewTarget, { ...target, headSha: "not-a-git-object-id" }),
    ).rejects.toBeDefined()

    const decoded = await decode(ReviewWork, reviewWork)
    expect(Number(decoded.id)).toBe(11)
    expect(JSON.parse(JSON.stringify(decoded.target))).toEqual(target)
  })

  test("keeps ReviewWork and FixWork exact", async () => {
    const review = await decode(Work, reviewWork)
    expect(review._tag).toBe("ReviewWork")

    await expect(
      decode(Work, {
        ...reviewWork,
        sourcePublicationId: 31,
        review: actionableReview,
      }),
    ).rejects.toBeDefined()
  })

  test("gives a Publication its immutable Review Target", async () => {
    const publication = await decode(Publication, {
      id: 31,
      operationKey: "review:42:7:1",
      installationId: 91,
      repositoryId: 42,
      repositoryFullName: "owner/repository",
      pullRequestNumber: 7,
      target,
      generation: 1,
      reviewRequestNumber: 1,
      review: { verdict: "pass", summary: "Looks good.", findings: [] },
      attempt: 1,
    })

    expect(JSON.parse(JSON.stringify(publication.target))).toEqual(target)
  })

  test("requires a source publication and actionable review for FixWork", async () => {
    const fixWork = {
      ...reviewWork,
      _tag: "FixWork",
      sourcePublicationId: 31,
      review: actionableReview,
    }
    const fix = await decode(Work, fixWork)
    expect(fix._tag).toBe("FixWork")
    if (fix._tag === "FixWork") {
      expect(Number(fix.sourcePublicationId)).toBe(31)
      expect(fix.review.findings).toHaveLength(1)
    }

    await expect(
      decode(Work, {
        ...fixWork,
        review: { verdict: "pass", summary: "Looks good.", findings: [] },
      }),
    ).rejects.toBeDefined()
    await expect(decode(Work, { ...fixWork, sourcePublicationId: undefined })).rejects.toBeDefined()
  })

  test("uses truthful fix-result variants", async () => {
    const prepared = await decode(FixResult, {
      _tag: "CommitPrepared",
      summary: "Prepared the fix commit.",
      commitSha: headSha,
    })
    expect(prepared._tag).toBe("CommitPrepared")

    const unchanged = await decode(FixResult, {
      _tag: "NoChanges",
      summary: "The requested change is already present.",
    })
    expect(unchanged._tag).toBe("NoChanges")

    await expect(
      decode(FixResult, {
        _tag: "CommitPrepared",
        summary: "Prepared the fix commit.",
      }),
    ).rejects.toBeDefined()
    await expect(
      decode(FixResult, {
        _tag: "NoChanges",
        summary: "No change was needed.",
        commitSha: headSha,
      }),
    ).rejects.toBeDefined()
  })
})
