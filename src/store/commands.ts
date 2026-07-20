import type { SqlClient } from "@effect/sql/SqlClient"
import type { SqlError } from "@effect/sql/SqlError"
import { Effect } from "effect"
import { decideFixEligibility } from "../domain/transaction-policy"
import { decodeCommandRow, decodePublicationReviewRow } from "./codecs"
import type { WorkflowStorePort } from "./contracts"
import { makeCurrentnessPolicy } from "./currentness"
import type { StoreDataError } from "./errors"
import { commandClaimCandidate } from "./internal-claim-queries"
import { SqlLeaseQueue } from "./lease"
import type { AgentCommand } from "./model"
import type { makeSharedStoreOperations } from "./shared"
type CommandOperations = Pick<
  WorkflowStorePort,
  "claimNextCommand" | "executeCommand" | "ingestCommand" | "rescheduleCommand"
>
type ClaimedCommand = {
  readonly command: "review" | "fix" | "status"
  readonly repository_id: number
  readonly pull_request_number: number
}
type CurrentPullRequest = {
  readonly repository_full_name: string
  readonly head_repository_full_name: string
}
type CommandDisposition = "review" | "fix" | "noop" | "disabled" | "denied"

export class SqlCommandStore implements CommandOperations {
  readonly #sql: SqlClient
  readonly #support: Pick<
    ReturnType<typeof makeSharedStoreOperations>,
    "enqueueFixFromReview" | "insertDelivery" | "supersedeOlderReviewWork"
  >
  readonly #queue: SqlLeaseQueue<AgentCommand>
  constructor(
    sql: SqlClient,
    support: Pick<
      ReturnType<typeof makeSharedStoreOperations>,
      "enqueueFixFromReview" | "insertDelivery" | "supersedeOlderReviewWork"
    >,
  ) {
    this.#sql = sql
    this.#support = support
    this.#queue = new SqlLeaseQueue(sql, {
      table: "commands",
      claimableId: (now) => commandClaimCandidate(sql, now),
      returning: sql.literal(`
        id,
        command,
        comment_id,
        commenter,
        installation_id,
        repository_id,
        repository_full_name,
        pull_request_number,
        attempts
      `),
      decode: decodeCommandRow,
    })
  }
  readonly claimNextCommand: CommandOperations["claimNextCommand"] = (input) =>
    this.#queue.claim(input)
  readonly executeCommand: CommandOperations["executeCommand"] = (input) =>
    Effect.gen(this, function* () {
      const commands = yield* this.#sql<ClaimedCommand>`
        SELECT command, repository_id, pull_request_number
        FROM commands
        WHERE id = ${input.commandId}
        AND state = 'leased'
        AND lease_owner = ${input.workerId}
        AND lease_until > ${input.completedAt.toISOString()}
      `
      const command = commands[0]
      if (command === undefined) return "stale" as const
      const timestamp = input.completedAt.toISOString()
      let disposition: CommandDisposition | "stale" = "denied"
      if (input.authorized) {
        const pullRequests = yield* this.#sql<CurrentPullRequest>`
          SELECT repository_full_name, head_repository_full_name
          FROM pull_requests
          WHERE repository_id = ${command.repository_id}
          AND pull_request_number = ${command.pull_request_number}
          AND state = 'open'
          AND draft = FALSE
        `
        const pullRequest = pullRequests[0]
        disposition =
          pullRequest === undefined
            ? "stale"
            : yield* this.dispatchCommand(command, pullRequest, timestamp, input.fixWorkEnabled)
      }
      yield* this.#sql`
        UPDATE commands
        SET
          state = 'succeeded',
          lease_owner = NULL,
          lease_until = NULL,
          last_error = NULL,
          updated_at = ${timestamp}
        WHERE id = ${input.commandId}
        AND state = 'leased'
        AND lease_owner = ${input.workerId}
        AND lease_until > ${timestamp}
      `
      return disposition
    }).pipe(this.#sql.withTransaction)
  readonly ingestCommand: CommandOperations["ingestCommand"] = (delivery, event) =>
    Effect.gen(this, function* () {
      const insertedDeliveries = yield* this.#support.insertDelivery(delivery)
      if (insertedDeliveries.length === 0) {
        return { status: "duplicate" } as const
      }
      const timestamp = delivery.receivedAt.toISOString()
      yield* this.#sql`
        INSERT INTO commands (
          delivery_id,
          command,
          comment_id,
          commenter,
          installation_id,
          repository_id,
          repository_full_name,
          pull_request_number,
          state,
          run_at,
          created_at,
          updated_at
        ) VALUES (
          ${delivery.deliveryId},
          ${event.command},
          ${event.commentId},
          ${event.commenter},
          ${event.installationId},
          ${event.repository.id},
          ${event.repository.fullName},
          ${event.pullRequestNumber},
          'ready',
          ${timestamp},
          ${timestamp},
          ${timestamp}
        )
      `
      return { status: "enqueued" } as const
    }).pipe(this.#sql.withTransaction)
  readonly rescheduleCommand: CommandOperations["rescheduleCommand"] = (input) =>
    this.#queue.reschedule({ ...input, id: input.commandId })
  private dispatchCommand(
    command: ClaimedCommand,
    pullRequest: CurrentPullRequest,
    timestamp: string,
    fixWorkEnabled: boolean,
  ): Effect.Effect<CommandDisposition, SqlError | StoreDataError> {
    switch (command.command) {
      case "review":
        return this.executeReviewCommand(command, timestamp)
      case "fix":
        if (!fixWorkEnabled) return Effect.succeed("disabled")
        return this.executeFixCommand(command, pullRequest, timestamp)
      case "status":
        return this.executeStatusCommand()
      default: {
        const exhaustive: never = command.command
        return exhaustive
      }
    }
  }

  private executeReviewCommand(
    command: ClaimedCommand,
    timestamp: string,
  ): Effect.Effect<"review" | "noop", SqlError> {
    return Effect.gen(this, function* () {
      const inserted = yield* this.#sql<{ readonly id: number }>`
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
        )
        SELECT
          'review',
          pull_requests.installation_id,
          pull_requests.repository_id,
          pull_requests.repository_full_name,
          pull_requests.pull_request_number,
          pull_requests.author,
          pull_requests.base_ref,
          pull_requests.base_sha,
          pull_requests.head_sha,
          pull_requests.head_ref,
          pull_requests.head_repository_full_name,
          pull_requests.generation,
          COALESCE(
            (
              SELECT MAX(review_request_number) + 1
              FROM jobs
              WHERE kind = 'review'
              AND repository_id = pull_requests.repository_id
              AND pull_request_number = pull_requests.pull_request_number
              AND generation = pull_requests.generation
            ),
            1
          ),
          'ready',
          ${timestamp},
          ${timestamp},
          ${timestamp}
        FROM pull_requests
        WHERE repository_id = ${command.repository_id}
        AND pull_request_number = ${command.pull_request_number}
        AND state = 'open'
        AND draft = FALSE
        AND NOT EXISTS (
          SELECT 1
          FROM jobs
          WHERE kind = 'review'
          AND repository_id = pull_requests.repository_id
          AND pull_request_number = pull_requests.pull_request_number
          AND generation = pull_requests.generation
          AND state IN ('ready', 'leased', 'retry_scheduled')
        )
        RETURNING id
      `
      const reviewJob = inserted[0]
      if (reviewJob === undefined) return "noop" as const

      yield* this.#support.supersedeOlderReviewWork({
        repositoryId: command.repository_id,
        pullRequestNumber: command.pull_request_number,
        reviewJobId: reviewJob.id,
        timestamp,
      })
      return "review" as const
    })
  }

  private executeFixCommand(
    command: ClaimedCommand,
    pullRequest: CurrentPullRequest,
    timestamp: string,
  ): Effect.Effect<"fix" | "noop" | "denied", SqlError | StoreDataError> {
    return Effect.gen(this, function* () {
      const currentness = makeCurrentnessPolicy(this.#sql)
      const reviews = yield* this.#sql<object>`
        SELECT
          review.id AS review_job_id,
          candidate.id AS publication_id,
          candidate.review_json
        FROM publications AS candidate
        JOIN jobs AS review
          ON review.repository_id = candidate.repository_id
          AND review.pull_request_number = candidate.pull_request_number
          AND review.generation = candidate.generation
          AND review.review_request_number = candidate.review_request_number
        WHERE review.kind = 'review'
        AND review.repository_id = ${command.repository_id}
        AND review.pull_request_number = ${command.pull_request_number}
        AND review.state = 'succeeded'
        AND candidate.state IN ('ready', 'leased', 'retry_scheduled', 'succeeded')
        AND ${currentness.currentPublication}
        AND ${currentness.latestReviewRequest}
        ORDER BY candidate.id DESC
        LIMIT 1
      `
      const row = reviews[0]
      if (row === undefined) return "noop" as const
      const review = yield* decodePublicationReviewRow(row)
      const eligibility = decideFixEligibility({
        repositoryFullName: pullRequest.repository_full_name,
        headRepositoryFullName: pullRequest.head_repository_full_name,
        review: review.review,
      })
      if (eligibility._tag === "Ineligible")
        return eligibility.reason === "different-repository"
          ? ("denied" as const)
          : ("noop" as const)

      const fixes = yield* this.#support.enqueueFixFromReview({
        headRepositoryFullName: pullRequest.head_repository_full_name,
        reviewJobId: review.reviewJobId,
        requestedAt: timestamp,
        repositoryFullName: pullRequest.repository_full_name,
        review: review.review,
        requeueFailed: true,
      })
      return fixes.length === 0 ? "noop" : "fix"
    })
  }

  private executeStatusCommand(): Effect.Effect<"noop"> {
    return Effect.succeed("noop")
  }
}
