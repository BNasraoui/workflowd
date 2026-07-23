import { Context, Data, Effect, Schema } from "effect"
import {
  type AgentExecutionContext,
  type AgentHarnessDefinition,
  type AgentHarnessPort,
  AgentHarnessError,
  type PreparedAgentWork,
} from "./agent-harness"
import { FixResult as FixResultSchema, type FixResult } from "./domain/fix-result"
import { GitObjectId, JobId, PullRequestNumber } from "./domain/identifiers"
import { ReviewResult as ReviewResultSchema, type ReviewResult } from "./domain/review-result"

type AutomationKind = "review" | "fix"

export type OpenCodeAutomationConfig = {
  readonly reviewerAgent: string
  readonly fixerAgent: string
  readonly model: string
  readonly pollIntervalMs: number
  readonly timeoutMs: number
}

export const RunPullRequestAutomationInput = Schema.Struct({
  jobId: Schema.optional(JobId),
  directory: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
  repositoryFullName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  pullRequestNumber: PullRequestNumber,
  baseSha: GitObjectId,
  headSha: GitObjectId,
})
export type RunPullRequestAutomationInput = typeof RunPullRequestAutomationInput.Type

export type ValidateAutomationAvailabilityInput = {
  readonly directory?: string
  readonly fixWorkEnabled: boolean
}

export class OpenCodeAutomationError extends Data.TaggedError("OpenCodeAutomationError")<{
  readonly operation: string
  readonly cause: Error
  readonly retryable: boolean
}> {}

type ReviewAgentWork = PreparedAgentWork<
  RunPullRequestAutomationInput,
  ReviewResult,
  typeof ReviewResultSchema.Encoded
>
type FixAgentWork = PreparedAgentWork<
  RunPullRequestAutomationInput,
  FixResult,
  typeof FixResultSchema.Encoded
>

export type AutomationPort = {
  readonly validateAvailability: (
    input: ValidateAutomationAvailabilityInput,
  ) => Effect.Effect<void, OpenCodeAutomationError>
  readonly prepareReview: (
    input: RunPullRequestAutomationInput,
    context: AgentExecutionContext,
  ) => Effect.Effect<ReviewAgentWork, OpenCodeAutomationError>
  readonly prepareFix: (
    input: RunPullRequestAutomationInput,
    context: AgentExecutionContext,
  ) => Effect.Effect<FixAgentWork, OpenCodeAutomationError>
}

export const Automation = Context.GenericTag<AutomationPort>("workflowd/Automation")

export const stageHarnessRef = { name: "opencode", version: 1 } as const

export function makePullRequestHarnessDefinitions(config: OpenCodeAutomationConfig) {
  const retryPolicy = {
    maxAttempts: 3,
    structuredOutputRetryCount: 2,
    invalidOutput: "retry" as const,
  }
  const review: AgentHarnessDefinition<
    RunPullRequestAutomationInput,
    typeof RunPullRequestAutomationInput.Encoded,
    ReviewResult,
    typeof ReviewResultSchema.Encoded
  > = {
    ref: { name: "opencode.pr-review", version: 1 },
    agent: config.reviewerAgent,
    model: config.model,
    inputSchema: RunPullRequestAutomationInput,
    outputSchema: ReviewResultSchema,
    maxInputBytes: 26_363,
    maxOutputBytes: 3_395_207,
    promptContract: "pr-review-prompt",
    title: (input) => sessionTitle("review", input),
    prompt: (input) => automationPrompt("review", input),
    timeoutMs: config.timeoutMs,
    retryPolicy,
  }
  const fix: AgentHarnessDefinition<
    RunPullRequestAutomationInput,
    typeof RunPullRequestAutomationInput.Encoded,
    FixResult,
    typeof FixResultSchema.Encoded
  > = {
    ref: { name: "opencode.pr-fix", version: 1 },
    agent: config.fixerAgent,
    model: config.model,
    inputSchema: RunPullRequestAutomationInput,
    outputSchema: FixResultSchema,
    maxInputBytes: 26_363,
    maxOutputBytes: 24_117,
    promptContract: "pr-fix-prompt",
    title: (input) => sessionTitle("fix", input),
    prompt: (input) => automationPrompt("fix", input),
    timeoutMs: config.timeoutMs,
    retryPolicy,
  }
  return { review, fix } as const
}

export type PullRequestHarnessDefinitions = ReturnType<typeof makePullRequestHarnessDefinitions>

export function makeOpenCodeHarnessDefinitions(config: OpenCodeAutomationConfig) {
  const pullRequest = makePullRequestHarnessDefinitions(config)
  const stage: AgentHarnessDefinition<unknown, unknown, unknown, unknown> = {
    ref: stageHarnessRef,
    agent: "qrspi-stage",
    model: "openai/gpt-5.6-sol",
    inputSchema: Schema.Unknown,
    outputSchema: Schema.Unknown,
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 4 * 1024 * 1024,
    promptContract: "qrspi-stage-capability",
    title: () => "QRSPI stage",
    prompt: () => "QRSPI stage capability registration",
    timeoutMs: config.timeoutMs,
    retryPolicy: {
      maxAttempts: 3,
      structuredOutputRetryCount: 2,
      invalidOutput: "retry",
    },
  }
  return { ...pullRequest, stage } as const
}

export class OpenCodeAutomationAdapter implements AutomationPort {
  constructor(
    private readonly harness: AgentHarnessPort,
    private readonly definitions: PullRequestHarnessDefinitions,
  ) {}

  readonly validateAvailability = (
    input: ValidateAutomationAvailabilityInput,
  ): Effect.Effect<void, OpenCodeAutomationError> =>
    this.harness
      .validateAvailability({
        selections: input.fixWorkEnabled
          ? [this.definitions.review, this.definitions.fix]
          : [this.definitions.review],
        ...(input.directory === undefined ? {} : { directory: input.directory }),
      })
      .pipe(Effect.mapError(toAutomationError))

  readonly prepareReview = (
    input: RunPullRequestAutomationInput,
    context: AgentExecutionContext,
  ): Effect.Effect<ReviewAgentWork, OpenCodeAutomationError> =>
    this.harness
      .prepare(this.definitions.review, input, context)
      .pipe(Effect.mapError(toAutomationError))

  readonly prepareFix = (
    input: RunPullRequestAutomationInput,
    context: AgentExecutionContext,
  ): Effect.Effect<FixAgentWork, OpenCodeAutomationError> =>
    this.harness
      .prepare(this.definitions.fix, input, context)
      .pipe(Effect.mapError(toAutomationError))
}

function toAutomationError(error: AgentHarnessError): OpenCodeAutomationError {
  return new OpenCodeAutomationError({
    operation: error.operation,
    cause: error.cause,
    retryable: error.retryable,
  })
}

function sessionTitle(kind: AutomationKind, input: RunPullRequestAutomationInput): string {
  const suffix = `#${input.pullRequestNumber}@${input.headSha.slice(0, 12)}`
  const prefix = `${kind}:`
  const repository = input.repositoryFullName.slice(0, 256 - prefix.length - suffix.length)
  return `${prefix}${repository}${suffix}`
}

function automationPrompt(kind: AutomationKind, input: RunPullRequestAutomationInput): string {
  if (kind === "review") {
    return `Review pull request ${input.repositoryFullName}#${input.pullRequestNumber} at head ${input.headSha} against base ${input.baseSha}. Read .workflowd/review.diff first, then inspect any relevant source and tests. Report only concrete correctness, security, regression, or missing-test findings. Do not modify files.`
  }
  return `Address the review findings for pull request ${input.repositoryFullName}#${input.pullRequestNumber}. Read .workflowd/review.json and .workflowd/review.diff, inspect the relevant code, preserve any valid in-progress edits from an earlier attempt, make the smallest correct changes, and run appropriate verification. If changes are needed, commit them without pushing and include the exact trailer "Workflowd-Job: ${input.jobId ?? "unassigned"}" in the commit message; report that commit SHA using the CommitPrepared FixResult variant so the controller can verify and push it. Report NoChanges only if HEAD and the worktree are unchanged.`
}

export type { FixResult, ReviewResult }
