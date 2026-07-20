import { Data } from "effect"
import type { ReviewResult } from "./review-result"
export type FixEligibility = Data.TaggedEnum<{
  Eligible: Record<never, never>
  Ineligible: {
    readonly reason: "branch-not-eligible" | "different-repository" | "review-not-actionable"
  }
}>
export const FixEligibility = Data.taggedEnum<FixEligibility>()
export function decideFixEligibility(input: {
  readonly agentBranchPrefixes?: ReadonlyArray<string>
  readonly headRef?: string
  readonly repositoryFullName: string
  readonly headRepositoryFullName: string
  readonly review: ReviewResult
}): FixEligibility {
  if (input.repositoryFullName.toLowerCase() !== input.headRepositoryFullName.toLowerCase())
    return FixEligibility.Ineligible({ reason: "different-repository" })
  if (input.review.verdict !== "changes_requested" || input.review.findings.length === 0)
    return FixEligibility.Ineligible({ reason: "review-not-actionable" })
  return input.agentBranchPrefixes === undefined ||
    input.agentBranchPrefixes.some((prefix) => input.headRef?.startsWith(prefix))
    ? FixEligibility.Eligible()
    : FixEligibility.Ineligible({ reason: "branch-not-eligible" })
}
