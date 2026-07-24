import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"
import type { SessionReference } from "../agent-harness"
import type { Publication } from "../domain/publication"
import type { Work } from "../domain/work"
import type { StoreDataError } from "./errors"
import type {
  AgentCommand,
  ApplyReconciliationSnapshotInput,
  CommandEvent,
  CompleteAgentReviewJobInput,
  CompleteFixJobInput,
  CompletePublicationInput,
  CompleteReviewJobInput,
  DeliveryInput,
  DeliveryRecordResult,
  ExecuteCommandInput,
  DisableFixJobInput,
  IngestPullRequestResult,
  LeaseClaim,
  PullRequestEvent,
  PullRequestReconciliation,
  RecordAgentFixResultInput,
  RecordAgentLaunchIntentInput,
  RecordAgentSessionCleanupFailureInput,
  RecordAgentSessionReferenceInput,
  RecordFixResultInput,
  RescheduleCommandInput,
  RescheduleJobInput,
  ReschedulePublicationInput,
  RescheduleReconciliationInput,
} from "./model"

export type WorkflowStorePort = {
  readonly recordDelivery: (
    delivery: DeliveryInput,
  ) => Effect.Effect<DeliveryRecordResult, SqlError>
  readonly ingestPullRequest: (
    delivery: DeliveryInput,
    event: PullRequestEvent,
  ) => Effect.Effect<IngestPullRequestResult, SqlError | StoreDataError>
  readonly applyReconciliationSnapshot: (
    input: ApplyReconciliationSnapshotInput,
  ) => Effect.Effect<"completed" | "stale", SqlError | StoreDataError>
  readonly claimNextReconciliation: (
    input: LeaseClaim,
  ) => Effect.Effect<PullRequestReconciliation | null, SqlError>
  readonly rescheduleReconciliation: (
    input: RescheduleReconciliationInput,
  ) => Effect.Effect<"retry" | "failed" | "stale", SqlError>
  readonly claimNextJob: (
    input: LeaseClaim,
  ) => Effect.Effect<Work | null, SqlError | StoreDataError>
  readonly claimExpiredAgentSession: (
    input: LeaseClaim,
  ) => Effect.Effect<SessionReference | null, SqlError | StoreDataError>
  readonly supersedeAgentSession: (
    sessionReferenceId: string,
    supersededAt: Date,
  ) => Effect.Effect<"superseded" | "stale", SqlError>
  readonly recordAgentSessionCleanupFailure: (
    input: RecordAgentSessionCleanupFailureInput,
  ) => Effect.Effect<"pending" | "operator_required" | "stale", SqlError>
  readonly shouldCancelJob: (
    jobId: number,
    workerId: string,
    now: Date,
  ) => Effect.Effect<boolean, SqlError>
  readonly isJobCurrent: (
    jobId: number,
    workerId: string,
    now: Date,
  ) => Effect.Effect<boolean, SqlError>
  readonly rescheduleJob: (
    input: RescheduleJobInput,
  ) => Effect.Effect<"retry" | "failed" | "stale", SqlError>
  readonly completeReviewJob: (
    input: CompleteReviewJobInput,
  ) => Effect.Effect<"completed" | "stale", SqlError>
  readonly completeAgentReviewJob: (
    input: CompleteAgentReviewJobInput,
  ) => Effect.Effect<"completed" | "stale", SqlError>
  readonly completeFixJob: (
    input: CompleteFixJobInput,
  ) => Effect.Effect<"completed" | "stale", SqlError>
  readonly disableFixJob: (
    input: DisableFixJobInput,
  ) => Effect.Effect<"disabled" | "stale", SqlError>
  readonly recordFixResult: (
    input: RecordFixResultInput,
  ) => Effect.Effect<"recorded" | "stale", SqlError>
  readonly recordAgentFixResult: (
    input: RecordAgentFixResultInput,
  ) => Effect.Effect<"recorded" | "stale", SqlError>
  readonly isTrustedBranchPublication: (input: {
    readonly repositoryId: string
    readonly repositoryFullName: string
    readonly headRef: string
    readonly jobId: number
    readonly commitSha: string
    readonly controllerSigningFingerprint: string
  }) => Effect.Effect<string | null, SqlError>
  readonly recordAgentLaunchIntent: <Input>(
    input: RecordAgentLaunchIntentInput<Input>,
  ) => Effect.Effect<"recorded" | "stale", SqlError>
  readonly recordAgentSessionReference: (
    input: RecordAgentSessionReferenceInput,
  ) => Effect.Effect<"recorded" | "stale", SqlError>
  readonly claimNextPublication: (
    input: LeaseClaim,
  ) => Effect.Effect<Publication | null, SqlError | StoreDataError>
  readonly isPublicationCurrent: (
    publicationId: number,
    workerId: string,
    now: Date,
  ) => Effect.Effect<boolean, SqlError>
  readonly completePublication: (
    input: CompletePublicationInput,
  ) => Effect.Effect<"completed" | "stale", SqlError>
  readonly reschedulePublication: (
    input: ReschedulePublicationInput,
  ) => Effect.Effect<"retry" | "failed" | "stale", SqlError>
  readonly ingestCommand: (
    delivery: DeliveryInput,
    event: CommandEvent,
  ) => Effect.Effect<{ readonly status: "duplicate" | "enqueued" }, SqlError>
  readonly claimNextCommand: (input: LeaseClaim) => Effect.Effect<AgentCommand | null, SqlError>
  readonly executeCommand: (
    input: ExecuteCommandInput,
  ) => Effect.Effect<
    "review" | "fix" | "status" | "noop" | "disabled" | "denied" | "stale",
    SqlError | StoreDataError
  >
  readonly rescheduleCommand: (
    input: RescheduleCommandInput,
  ) => Effect.Effect<"retry" | "failed" | "stale", SqlError>
}

export const WorkflowStore = Context.GenericTag<WorkflowStorePort>("workflowd/WorkflowStore")
