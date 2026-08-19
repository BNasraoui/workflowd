import type { SqlClient } from "@effect/sql/SqlClient"
import type { ReviewTarget } from "../domain/review-target"
import { reviewTargetFieldNames } from "../domain/review-target"
import { makeWorkStatePolicy } from "./work-state"

/**
 * Where each Review Target field lives in the durable schema. Claimable work
 * records the head it was accepted for as `expected_head_sha`, while the
 * tracked pull request records the head it currently reports as `head_sha`.
 */
const reviewTargetColumns: {
  readonly [K in keyof ReviewTarget]: {
    readonly candidate: string
    readonly pullRequest: string
  }
} = {
  baseSha: { candidate: "base_sha", pullRequest: "base_sha" },
  baseRef: { candidate: "base_ref", pullRequest: "base_ref" },
  headSha: { candidate: "expected_head_sha", pullRequest: "head_sha" },
  headRef: { candidate: "head_ref", pullRequest: "head_ref" },
  headRepositoryFullName: {
    candidate: "head_repository_full_name",
    pullRequest: "head_repository_full_name",
  },
}

const sameReviewTarget = reviewTargetFieldNames
  .map((field) => {
    const columns = reviewTargetColumns[field]
    return `candidate.${columns.candidate} = current_pr.${columns.pullRequest}`
  })
  .join("\n    AND ")

const sameExpectedHead = `candidate.${reviewTargetColumns.headSha.candidate} = current_pr.${reviewTargetColumns.headSha.pullRequest}`

export function makeCurrentnessPolicy(sql: SqlClient) {
  const workState = makeWorkStatePolicy(sql)
  const pullRequestIdentity = `
    current_pr.repository_id = candidate.repository_id
    AND current_pr.pull_request_number = candidate.pull_request_number
  `
  const reviewablePullRequest = `
    current_pr.state = 'open'
    AND current_pr.draft = FALSE
  `
  // Work is fenced by its Generation, its expected head, and its author. The
  // remaining Review Target fields are covered transitively: changing any of
  // them starts a newer Generation.
  const currentJob = sql.literal(`
    EXISTS (
      SELECT 1
      FROM pull_requests AS current_pr
      WHERE ${pullRequestIdentity}
      AND candidate.generation = current_pr.generation
      AND ${sameExpectedHead}
      AND LOWER(candidate.author) = LOWER(current_pr.author)
      AND ${reviewablePullRequest}
    )
  `)
  // A Publication carries the exact Review Target into a pull-request comment,
  // so it is checked against every identifying field.
  const currentPublication = sql.literal(`
    EXISTS (
      SELECT 1
      FROM pull_requests AS current_pr
      WHERE ${pullRequestIdentity}
      AND candidate.generation = current_pr.generation
      AND ${sameReviewTarget}
      AND ${reviewablePullRequest}
    )
  `)
  const latestReviewRequest = sql.literal(`
    candidate.review_request_number = (
      SELECT MAX(latest_review.review_request_number)
      FROM jobs AS latest_review
      WHERE latest_review.kind = 'review'
      AND latest_review.repository_id = candidate.repository_id
      AND latest_review.pull_request_number = candidate.pull_request_number
      AND latest_review.generation = candidate.generation
    )
  `)

  return {
    currentJob,
    currentPublication,
    latestReviewRequest,
    jobClaimCandidate: (now: string) => sql`
      SELECT candidate.id
      FROM jobs AS candidate
      WHERE ${workState.claimable(now, "candidate")}
      AND candidate.run_at <= ${now}
      AND candidate.attempts < candidate.max_attempts
      AND candidate.cancel_requested = FALSE
      AND NOT EXISTS (
        SELECT 1 FROM agent_executions AS active_execution
        WHERE active_execution.job_id = candidate.id
        AND active_execution.state = 'session_ready'
      )
      AND ${currentJob}
      AND ${latestReviewRequest}
      AND (
        candidate.kind = 'review'
        OR (
          candidate.publication_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM pull_requests AS current_pr
            WHERE ${sql.literal(pullRequestIdentity)}
            AND LOWER(current_pr.repository_full_name) =
              LOWER(current_pr.head_repository_full_name)
          )
          AND EXISTS (
            SELECT 1
            FROM publications AS source_publication
            WHERE source_publication.id = candidate.publication_id
            AND source_publication.repository_id = candidate.repository_id
            AND source_publication.pull_request_number =
              candidate.pull_request_number
            AND source_publication.generation = candidate.generation
            AND source_publication.review_request_number =
              candidate.review_request_number
            AND source_publication.state = 'succeeded'
          )
        )
      )
      ORDER BY candidate.run_at ASC, candidate.id ASC
      LIMIT 1
    `,
    publicationClaimCandidate: (now: string) => sql`
      SELECT candidate.id
      FROM publications AS candidate
      WHERE ${workState.claimable(now, "candidate")}
      AND candidate.run_at <= ${now}
      AND candidate.attempts < candidate.max_attempts
      AND ${currentPublication}
      AND ${latestReviewRequest}
      ORDER BY candidate.run_at ASC, candidate.id ASC
      LIMIT 1
    `,
  }
}
