import type { GitHubEvent } from "../github-event"
import type { PullRequestSnapshot } from "../github"
import type { AgentLaunchIntent, SessionReference } from "../agent-harness"
import type { FixResult } from "../domain/fix-result"
import type { ReviewResult } from "../domain/review-result"

export type DeliveryInput = {
  readonly deliveryId: string
  readonly event: string
  readonly action: string | null
  readonly payload: string
  readonly receivedAt: Date
}

export type DeliveryRecordResult = "inserted" | "duplicate"

export type PullRequestEvent = Extract<GitHubEvent, { readonly _tag: "PullRequest" }>

export type CommandEvent = Extract<GitHubEvent, { readonly _tag: "Command" }>

export type IngestPullRequestResult =
  | { readonly status: "duplicate" }
  | { readonly status: "ignored"; readonly generation: number }
  | { readonly status: "reconciliation_enqueued"; readonly generation: number }
  | { readonly status: "enqueued"; readonly generation: number }

export type LeaseClaim = {
  readonly workerId: string
  readonly now: Date
  readonly leaseDurationMs: number
}

export type CompleteReviewJobInput = {
  readonly jobId: number
  readonly workerId: string
  readonly completedAt: Date
  readonly review: ReviewResult
  readonly autoFix: boolean
}

export type CompleteAgentReviewJobInput = CompleteReviewJobInput & {
  readonly sessionReferenceId: string
}

export type CompleteFixJobInput = {
  readonly jobId: number
  readonly workerId: string
  readonly completedAt: Date
  readonly controllerSigningFingerprint?: string
}

export type DisableFixJobInput = {
  readonly jobId: number
  readonly workerId: string
  readonly disabledAt: Date
}

export type RecordFixResultInput = {
  readonly jobId: number
  readonly workerId: string
  readonly recordedAt: Date
  readonly result: FixResult
}

export type RecordAgentFixResultInput = RecordFixResultInput & {
  readonly sessionReferenceId: string
}

export type RecordAgentLaunchIntentInput<Input> = {
  readonly jobId: number
  readonly workerId: string
  readonly recordedAt: Date
  readonly intent: AgentLaunchIntent<Input>
}

export type RecordAgentSessionReferenceInput = {
  readonly jobId: number
  readonly workerId: string
  readonly recordedAt: Date
  readonly reference: SessionReference
}

export type RecordAgentSessionCleanupFailureInput = {
  readonly sessionReferenceId: string
  readonly workerId: string
  readonly failedAt: Date
  readonly error: string
}

export type CompletePublicationInput = {
  readonly publicationId: number
  readonly workerId: string
  readonly completedAt: Date
  readonly outcome: "published" | "stale"
}

export type RescheduleJobInput = {
  readonly jobId: number
  readonly workerId: string
  readonly failedAt: Date
  readonly runAt: Date
  readonly error: string
  readonly maxAttempts: number
  readonly execution?: {
    readonly attempt: number
    readonly leaseToken: string
  }
}

export type ReschedulePublicationInput = {
  readonly publicationId: number
  readonly workerId: string
  readonly failedAt: Date
  readonly runAt: Date
  readonly error: string
  readonly maxAttempts: number
}

export type ExecuteCommandInput = {
  readonly commandId: number
  readonly workerId: string
  readonly authorized: boolean
  readonly fixWorkEnabled: boolean
  readonly completedAt: Date
}

export type RescheduleCommandInput = {
  readonly commandId: number
  readonly workerId: string
  readonly failedAt: Date
  readonly runAt: Date
  readonly error: string
  readonly maxAttempts: number
}

export type AgentCommand = {
  readonly id: number
  readonly command: "fix" | "review" | "status"
  readonly commentId: number
  readonly commenter: string
  readonly installationId: number
  readonly repositoryId: number
  readonly repositoryFullName: string
  readonly pullRequestNumber: number
  readonly attempts: number
}

export type PullRequestReconciliation = {
  readonly id: number
  readonly installationId: number
  readonly repositoryId: number
  readonly repositoryFullName: string
  readonly pullRequestNumber: number
  readonly attempts: number
}

export type ApplyReconciliationSnapshotInput = {
  readonly reconciliationId: number
  readonly workerId: string
  readonly snapshot: PullRequestSnapshot
  readonly completedAt: Date
}

export type RescheduleReconciliationInput = {
  readonly reconciliationId: number
  readonly workerId: string
  readonly failedAt: Date
  readonly runAt: Date
  readonly error: string
  readonly maxAttempts: number
}
