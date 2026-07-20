import { Context, Data, Effect } from "effect"
import { normalizeError } from "./errors"
import {
  FixResult as FixResultSchema,
  FixResultJsonSchema,
  type FixResult,
} from "./domain/fix-result"
import {
  type OpenCodeAdapter,
  type OpenCodeModel,
} from "./opencode/adapter"
import {
  StructuredSession,
  StructuredSessionError,
} from "./opencode/structured-session"
import {
  ReviewResult as ReviewResultSchema,
  ReviewResultJsonSchema,
  type ReviewResult,
} from "./domain/review-result"

type AutomationKind = "review" | "fix"

export type OpenCodeAutomationConfig = {
  readonly reviewerAgent: string
  readonly fixerAgent: string
  readonly model: string
  readonly pollIntervalMs: number
}

export type RunPullRequestAutomationInput = {
  readonly jobId?: number
  readonly directory: string
  readonly repositoryFullName: string
  readonly pullRequestNumber: number
  readonly baseSha: string
  readonly headSha: string
}

export type ValidateAutomationAvailabilityInput = {
  readonly directory?: string
  readonly fixWorkEnabled: boolean
}

export class OpenCodeAutomationError extends Data.TaggedError(
  "OpenCodeAutomationError",
)<{
  readonly operation: string
  readonly cause: Error
}> {}

export type AutomationPort = {
  readonly validateAvailability: (
    input: ValidateAutomationAvailabilityInput,
  ) => Effect.Effect<void, OpenCodeAutomationError>
  readonly runReview: (
    input: RunPullRequestAutomationInput,
  ) => Effect.Effect<ReviewResult, OpenCodeAutomationError>
  readonly runFix: (
    input: RunPullRequestAutomationInput,
  ) => Effect.Effect<FixResult, OpenCodeAutomationError>
}

export const Automation = Context.GenericTag<AutomationPort>(
  "workflowd/Automation",
)

export class OpenCodeAutomationAdapter implements AutomationPort {
  constructor(
    private readonly adapter: OpenCodeAdapter,
    private readonly policy: OpenCodeAutomationConfig,
  ) {}

  readonly validateAvailability = (
    input: ValidateAutomationAvailabilityInput,
  ): Effect.Effect<void, OpenCodeAutomationError> =>
    Effect.gen(this, function* () {
      const model = yield* this.model()
      yield* this.attempt("validate OpenCode availability", (signal) =>
        this.adapter.validateAvailability(
          {
            ...(input.directory === undefined ? {} : { directory: input.directory }),
            agents: input.fixWorkEnabled
              ? [this.policy.reviewerAgent, this.policy.fixerAgent]
              : [this.policy.reviewerAgent],
            model,
          },
          signal,
        ),
      )
    })

  readonly runReview = (
    input: RunPullRequestAutomationInput,
  ): Effect.Effect<ReviewResult, OpenCodeAutomationError> =>
    Effect.gen(this, function* () {
      const model = yield* this.model()
      return yield* this.attempt("review", (signal) =>
        new StructuredSession(
          this.adapter,
          {
            directory: input.directory,
            title: sessionTitle("review", input),
            agent: this.policy.reviewerAgent,
            model,
            format: {
              type: "json_schema",
              schema: ReviewResultJsonSchema,
              retryCount: 2,
            },
            prompt: automationPrompt("review", input),
            pollIntervalMs: this.policy.pollIntervalMs,
          },
          ReviewResultSchema,
        ).run(signal),
      )
    })

  readonly runFix = (
    input: RunPullRequestAutomationInput,
  ): Effect.Effect<FixResult, OpenCodeAutomationError> =>
    Effect.gen(this, function* () {
      const model = yield* this.model()
      return yield* this.attempt("fix", (signal) =>
        new StructuredSession(
          this.adapter,
          {
            directory: input.directory,
            title: sessionTitle("fix", input),
            agent: this.policy.fixerAgent,
            model,
            format: {
              type: "json_schema",
              schema: FixResultJsonSchema,
              retryCount: 2,
            },
            prompt: automationPrompt("fix", input),
            pollIntervalMs: this.policy.pollIntervalMs,
          },
          FixResultSchema,
        ).run(signal),
      )
    })

  private model(): Effect.Effect<OpenCodeModel, OpenCodeAutomationError> {
    return Effect.try({
      try: () => parseModel(this.policy.model),
      catch: (cause) =>
        new OpenCodeAutomationError({
          operation: "parse model",
          cause: normalizeError(cause),
        }),
    })
  }

  private attempt<A>(
    operation: string,
    run: (signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<A, OpenCodeAutomationError> {
    return Effect.tryPromise({
      try: run,
      catch: (cause) =>
        cause instanceof StructuredSessionError
          ? new OpenCodeAutomationError({
              operation: cause.operation,
              cause: cause.cause,
            })
          : new OpenCodeAutomationError({
              operation,
              cause: normalizeError(cause),
            }),
    })
  }
}

function parseModel(value: string): OpenCodeModel {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Expected provider/model, received ${value}`)
  }
  return {
    providerID: value.slice(0, separator),
    modelID: value.slice(separator + 1),
  }
}

function sessionTitle(
  kind: AutomationKind,
  input: RunPullRequestAutomationInput,
): string {
  return `${kind}:${input.repositoryFullName}#${input.pullRequestNumber}@${input.headSha.slice(0, 12)}`
}

function automationPrompt(
  kind: AutomationKind,
  input: RunPullRequestAutomationInput,
): string {
  if (kind === "review") {
    return `Review pull request ${input.repositoryFullName}#${input.pullRequestNumber} at head ${input.headSha} against base ${input.baseSha}. Read .workflowd/review.diff first, then inspect any relevant source and tests. Report only concrete correctness, security, regression, or missing-test findings. Do not modify files.`
  }
  return `Address the review findings for pull request ${input.repositoryFullName}#${input.pullRequestNumber}. Read .workflowd/review.json and .workflowd/review.diff, inspect the relevant code, preserve any valid in-progress edits from an earlier attempt, make the smallest correct changes, and run appropriate verification. If changes are needed, commit them without pushing and include the exact trailer "Workflowd-Job: ${input.jobId ?? "unassigned"}" in the commit message; report that commit SHA using the CommitPrepared FixResult variant so the controller can verify and push it. Report NoChanges only if HEAD and the worktree are unchanged.`
}
