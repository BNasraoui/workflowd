import { describe, expect, test } from "bun:test"
import { FixEligibility, decideFixEligibility } from "../../src/domain/transaction-policy"
import type { ReviewResult } from "../../src/domain/review-result"

const actionableReview: ReviewResult = {
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

const passingReview: ReviewResult = {
  verdict: "pass",
  summary: "No actionable findings.",
  findings: [],
}

describe("transaction policy", () => {
  test("uses one fix policy for automatic and manual requests", () => {
    for (const [review, headRepositoryFullName, expected] of [
      [actionableReview, "OWNER/repository", FixEligibility.Eligible()],
      [
        passingReview,
        "owner/repository",
        FixEligibility.Ineligible({ reason: "review-not-actionable" }),
      ],
      [
        actionableReview,
        "contributor/repository",
        FixEligibility.Ineligible({ reason: "different-repository" }),
      ],
    ] as const) {
      expect(
        decideFixEligibility({
          repositoryFullName: "owner/repository",
          headRepositoryFullName,
          review,
        }),
      ).toEqual(expected)
    }
    expect(
      decideFixEligibility({
        repositoryFullName: "owner/repository",
        headRepositoryFullName: "owner/repository",
        headRef: "human/feature",
        review: actionableReview,
        agentBranchPrefixes: ["opencode/"],
      }),
    ).toEqual(FixEligibility.Ineligible({ reason: "branch-not-eligible" }))
  })
})
