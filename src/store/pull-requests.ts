import type { SqlClient } from "@effect/sql/SqlClient"
import { Effect, Schema } from "effect"
import {
  AuthoritativePullRequestSnapshot,
  PullRequestObservation,
  TrackedPullRequestState,
  decidePullRequestTransition,
} from "../domain/pull-request-transition"
import type { makeSharedStoreOperations } from "./shared"

type PullRequestTransitionInput = {
  readonly appliedAt: Date
  readonly snapshot:
    typeof PullRequestObservation.Encoded | typeof AuthoritativePullRequestSnapshot.Encoded
}

type PullRequestRow = {
  readonly installation_id: number
  readonly repository_id: number
  readonly repository_full_name: string
  readonly repository_owner: string
  readonly repository_name: string
  readonly pull_request_number: number
  readonly author: string
  readonly base_ref: string
  readonly base_sha: string
  readonly draft: number
  readonly head_ref: string
  readonly head_repository_full_name: string
  readonly head_sha: string
  readonly github_updated_at: string | null
  readonly state: "open" | "closed"
  readonly generation: number
  readonly latest_review_request_number: number | null
  readonly review_request_active: number
}

const decodeTracked = Schema.decodeUnknownSync(TrackedPullRequestState)
const decodeObservation = Schema.decodeUnknownSync(PullRequestObservation)
const decodeAuthoritative = Schema.decodeUnknownSync(AuthoritativePullRequestSnapshot)

export function makePullRequestTransition(
  sql: SqlClient,
  shared: Pick<
    ReturnType<typeof makeSharedStoreOperations>,
    "supersedeOlderReviewWork" | "supersedePullRequestWork"
  >,
) {
  return (input: PullRequestTransitionInput) =>
    Effect.gen(function* () {
      const snapshot =
        input.snapshot._tag === "PullRequest"
          ? decodeObservation(input.snapshot)
          : decodeAuthoritative(input.snapshot)
      const { pullRequest, repository } = snapshot
      const existing = yield* sql<PullRequestRow>`
        SELECT
          pull_requests.*,
          (
            SELECT MAX(review_request_number)
            FROM jobs
            WHERE kind = 'review'
            AND repository_id = pull_requests.repository_id
            AND pull_request_number = pull_requests.pull_request_number
            AND generation = pull_requests.generation
          ) AS latest_review_request_number,
          EXISTS (
            SELECT 1
            FROM jobs
            WHERE kind = 'review'
            AND repository_id = pull_requests.repository_id
            AND pull_request_number = pull_requests.pull_request_number
            AND generation = pull_requests.generation
            AND state IN ('ready', 'leased', 'retry_scheduled')
          ) AS review_request_active
        FROM pull_requests
        WHERE repository_id = ${repository.id}
        AND pull_request_number = ${pullRequest.number}
      `
      const row = existing[0]
      const current =
        row === undefined
          ? undefined
          : decodeTracked({
              _tag: "TrackedPullRequestState",
              installationId: row.installation_id,
              repository: {
                id: row.repository_id,
                fullName: row.repository_full_name,
                owner: row.repository_owner,
                name: row.repository_name,
              },
              pullRequest: {
                number: row.pull_request_number,
                author: row.author,
                baseRef: row.base_ref,
                baseSha: row.base_sha,
                draft: Boolean(row.draft),
                headRef: row.head_ref,
                headRepositoryFullName: row.head_repository_full_name,
                headSha: row.head_sha,
                state: row.state,
                ...(row.github_updated_at === null ? {} : { updatedAt: row.github_updated_at }),
              },
              generation: row.generation,
              ...(row.latest_review_request_number === null
                ? {}
                : {
                    latestReviewRequestNumber: row.latest_review_request_number,
                  }),
              reviewRequestActive: Boolean(row.review_request_active),
            })
      const decision = decidePullRequestTransition(current, snapshot)

      if (decision._tag === "IgnoreObservation") {
        return { status: "ignored", generation: decision.generation } as const
      }
      if (decision._tag === "RequestReconciliation") {
        const timestamp = input.appliedAt.toISOString()
        yield* sql`
          INSERT INTO reconciliations (
            installation_id,
            repository_id,
            repository_full_name,
            pull_request_number,
            state,
            run_at,
            created_at,
            updated_at
          ) VALUES (
            ${snapshot.installationId},
            ${repository.id},
            ${repository.fullName},
            ${pullRequest.number},
            'ready',
            ${timestamp},
            ${timestamp},
            ${timestamp}
          )
          ON CONFLICT (repository_id, pull_request_number) DO UPDATE SET
            installation_id = excluded.installation_id,
            repository_full_name = excluded.repository_full_name,
            state = 'ready',
            attempts = 0,
            run_at = excluded.run_at,
            lease_owner = NULL,
            lease_until = NULL,
            last_error = NULL,
            updated_at = excluded.updated_at
          WHERE reconciliations.state IN ('succeeded', 'failed', 'data_error')
        `
        return {
          status: "reconciliation_enqueued",
          generation: decision.generation,
        } as const
      }

      const timestamp = input.appliedAt.toISOString()
      if (snapshot._tag === "PullRequest") {
        yield* sql`
          UPDATE reconciliations
          SET
            state = 'ready',
            attempts = 0,
            run_at = ${timestamp},
            lease_owner = NULL,
            lease_until = NULL,
            last_error = NULL,
            updated_at = ${timestamp}
          WHERE repository_id = ${repository.id}
          AND pull_request_number = ${pullRequest.number}
          AND state IN ('ready', 'leased', 'retry_scheduled')
        `
      }
      for (const intent of decision.intents) {
        if (intent._tag === "SupersedeGeneration") {
          yield* shared.supersedePullRequestWork({
            repositoryId: repository.id,
            pullRequestNumber: pullRequest.number,
            generation: intent.generation,
            includeCurrentGeneration: false,
            publicationReason: "pull request generation changed",
            timestamp,
          })
        }
        if (intent._tag === "SupersedeReviewRequests" && intent.scope === "current-generation") {
          yield* shared.supersedePullRequestWork({
            repositoryId: repository.id,
            pullRequestNumber: pullRequest.number,
            generation: intent.generation,
            includeCurrentGeneration: true,
            publicationReason: "pull request is not eligible",
            timestamp,
          })
        }
      }

      yield* sql`
        INSERT INTO pull_requests (
          repository_id,
          pull_request_number,
          installation_id,
          repository_full_name,
          repository_owner,
          repository_name,
          author,
          base_ref,
          base_sha,
          draft,
          head_ref,
          head_repository_full_name,
          head_sha,
          github_updated_at,
          state,
          generation,
          updated_at
        ) VALUES (
          ${repository.id},
          ${pullRequest.number},
          ${snapshot.installationId},
          ${repository.fullName},
          ${repository.owner},
          ${repository.name},
          ${pullRequest.author},
          ${pullRequest.baseRef},
          ${pullRequest.baseSha},
          ${pullRequest.draft},
          ${pullRequest.headRef},
          ${pullRequest.headRepositoryFullName},
          ${pullRequest.headSha},
          ${pullRequest.updatedAt ?? null},
          ${pullRequest.state},
          ${decision.generation},
          ${timestamp}
        )
        ON CONFLICT (repository_id, pull_request_number) DO UPDATE SET
          installation_id = excluded.installation_id,
          repository_full_name = excluded.repository_full_name,
          repository_owner = excluded.repository_owner,
          repository_name = excluded.repository_name,
          author = excluded.author,
          base_ref = excluded.base_ref,
          base_sha = excluded.base_sha,
          draft = excluded.draft,
          head_ref = excluded.head_ref,
          head_repository_full_name = excluded.head_repository_full_name,
          head_sha = excluded.head_sha,
          github_updated_at = COALESCE(
            excluded.github_updated_at,
            pull_requests.github_updated_at
          ),
          state = excluded.state,
          generation = excluded.generation,
          updated_at = excluded.updated_at
      `

      const queue = decision.intents.find((intent) => intent._tag === "QueueReview")
      if (queue === undefined || queue._tag !== "QueueReview") {
        return { status: "ignored", generation: decision.generation } as const
      }

      const insertedJobs = yield* sql<{ readonly id: number }>`
        INSERT INTO jobs (
          kind,
          installation_id,
          repository_id,
          repository_full_name,
          pull_request_number,
          author,
          base_ref,
          base_sha,
          expected_head_sha,
          head_ref,
          head_repository_full_name,
          generation,
          review_request_number,
          state,
          run_at,
          created_at,
          updated_at
        ) VALUES (
          'review',
          ${snapshot.installationId},
          ${repository.id},
          ${repository.fullName},
          ${pullRequest.number},
          ${pullRequest.author},
          ${pullRequest.baseRef},
          ${pullRequest.baseSha},
          ${pullRequest.headSha},
          ${pullRequest.headRef},
          ${pullRequest.headRepositoryFullName},
          ${decision.generation},
          ${queue.reviewRequestNumber},
          'ready',
          ${timestamp},
          ${timestamp},
          ${timestamp}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `
      const reviewJob = insertedJobs[0]
      if (
        reviewJob !== undefined &&
        decision.intents.some(
          (intent) =>
            intent._tag === "SupersedeReviewRequests" && intent.scope === "earlier-review-requests",
        )
      ) {
        yield* shared.supersedeOlderReviewWork({
          repositoryId: repository.id,
          pullRequestNumber: pullRequest.number,
          reviewJobId: reviewJob.id,
          timestamp,
        })
      }
      return reviewJob === undefined
        ? ({ status: "ignored", generation: decision.generation } as const)
        : ({ status: "enqueued", generation: decision.generation } as const)
    })
}
