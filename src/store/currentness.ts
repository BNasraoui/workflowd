import type { SqlClient } from "@effect/sql/SqlClient"

export function makeCurrentnessPolicy(sql: SqlClient) {
  const pullRequestIdentity = `
    current_pr.repository_id = candidate.repository_id
    AND current_pr.pull_request_number = candidate.pull_request_number
  `
  const reviewablePullRequest = `
    current_pr.state = 'open'
    AND current_pr.draft = FALSE
  `
  const currentJob = sql.literal(`
    EXISTS (
      SELECT 1
      FROM pull_requests AS current_pr
      WHERE ${pullRequestIdentity}
      AND candidate.generation = current_pr.generation
      AND candidate.expected_head_sha = current_pr.head_sha
      AND ${reviewablePullRequest}
    )
  `)
  const currentPublication = sql.literal(`
    EXISTS (
      SELECT 1
      FROM pull_requests AS current_pr
      WHERE ${pullRequestIdentity}
      AND candidate.generation = current_pr.generation
      AND candidate.base_ref = current_pr.base_ref
      AND candidate.base_sha = current_pr.base_sha
      AND candidate.expected_head_sha = current_pr.head_sha
      AND candidate.head_ref = current_pr.head_ref
      AND candidate.head_repository_full_name =
        current_pr.head_repository_full_name
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
      WHERE (
        candidate.state IN ('ready', 'retry_scheduled')
        OR (candidate.state = 'leased' AND candidate.lease_until <= ${now})
      )
      AND candidate.run_at <= ${now}
      AND candidate.attempts < candidate.max_attempts
      AND candidate.cancel_requested = FALSE
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
      WHERE (
        candidate.state IN ('ready', 'retry_scheduled')
        OR (candidate.state = 'leased' AND candidate.lease_until <= ${now})
      )
      AND candidate.run_at <= ${now}
      AND candidate.attempts < candidate.max_attempts
      AND ${currentPublication}
      AND ${latestReviewRequest}
      ORDER BY candidate.run_at ASC, candidate.id ASC
      LIMIT 1
    `,
  }
}
