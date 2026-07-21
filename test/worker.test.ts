import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import {
  AgentHarness,
  AgentHarnessError,
  type AgentHarnessPort,
  type AgentExecutionContext,
  type AgentLaunchIntent,
  SessionReference,
} from "../src/agent-harness"
import { FixResult } from "../src/domain/fix-result"
import { Publication } from "../src/domain/publication"
import { ReviewResult } from "../src/domain/review-result"
import { GitHub, type GitHubPort } from "../src/github"
import { Automation, type AutomationPort, RunPullRequestAutomationInput } from "../src/opencode"
import {
  runCommandIteration,
  runJobIteration,
  runPublicationIteration,
  runReconciliationIteration,
} from "../src/worker"
import { WorkflowStore, type WorkflowStorePort } from "../src/store/contracts"
import { Workspace, type WorkspacePort } from "../src/workspace"
import {
  makeFixWork,
  makeReviewWork,
  makeStoreLayer,
  decodePullRequestEvent,
  samplePullRequestEvent,
} from "./store/harness"

const makeStore = (overrides: Partial<WorkflowStorePort> = {}): WorkflowStorePort => ({
  recordDelivery: () => Effect.die("unused"),
  ingestPullRequest: () => Effect.die("unused"),
  applyReconciliationSnapshot: () => Effect.die("unused"),
  claimNextReconciliation: () => Effect.succeed(null),
  rescheduleReconciliation: () => Effect.die("unused"),
  claimExpiredAgentSession: () => Effect.succeed(null),
  claimNextJob: () => Effect.succeed(null),
  supersedeAgentSession: () => Effect.die("unused"),
  recordAgentSessionCleanupFailure: () => Effect.succeed("pending"),
  shouldCancelJob: () => Effect.succeed(false),
  rescheduleJob: () => Effect.die("unused"),
  completeReviewJob: () => Effect.die("unused"),
  completeFixJob: () => Effect.die("unused"),
  disableFixJob: () => Effect.die("unused"),
  recordFixResult: () => Effect.die("unused"),
  completeAgentReviewJob: (input) => overrides.completeReviewJob?.(input) ?? Effect.die("unused"),
  recordAgentFixResult: (input) => overrides.recordFixResult?.(input) ?? Effect.die("unused"),
  recordAgentLaunchIntent: () => Effect.succeed("recorded"),
  recordAgentSessionReference: () => Effect.succeed("recorded"),
  claimNextPublication: () => Effect.succeed(null),
  isPublicationCurrent: () => Effect.succeed(false),
  isJobCurrent: () => Effect.succeed(false),
  completePublication: () => Effect.die("unused"),
  reschedulePublication: () => Effect.die("unused"),
  ingestCommand: () => Effect.die("unused"),
  claimNextCommand: () => Effect.succeed(null),
  executeCommand: () => Effect.die("unused"),
  rescheduleCommand: () => Effect.die("unused"),
  ...overrides,
})

type TestAutomation = Partial<AutomationPort> & {
  readonly runReview?: () => Effect.Effect<typeof ReviewResult.Type>
  readonly runFix?: () => Effect.Effect<typeof FixResult.Type>
}

const makeWorkerLayer = (options: {
  readonly store?: Partial<WorkflowStorePort>
  readonly github?: Partial<GitHubPort>
  readonly automation?: TestAutomation
  readonly agentHarness?: Partial<AgentHarnessPort>
  readonly workspace?: Partial<WorkspacePort>
}) => {
  const automation = options.automation
  return Layer.mergeAll(
    Layer.succeed(WorkflowStore, makeStore(options.store)),
    Layer.succeed(GitHub, {
      publishReview: () => Effect.die("unused"),
      fetchPullRequestSnapshot: () => Effect.die("unused"),
      ...options.github,
    }),
    Layer.succeed(Automation, {
      validateAvailability: () => Effect.die("unused"),
      prepareReview: (_input, context) => Effect.succeed(preparedReview(context)),
      prepareFix: (_input, context) => Effect.succeed(preparedFix(context)),
      ...options.automation,
    }),
    Layer.succeed(AgentHarness, {
      validateAvailability: () => Effect.die("unused"),
      prepare: () => Effect.die("unused"),
      createSession: (prepared) => Effect.succeed(sessionReference(prepared)),
      resumeSession: (prepared) => {
        const execution: Effect.Effect<unknown> =
          prepared.launchIntent.harness.name === "opencode.pr-review"
            ? (automation?.runReview?.() ?? Effect.die("unused"))
            : (automation?.runFix?.() ?? Effect.die("unused"))
        return execution.pipe(
          Effect.flatMap((result) => Schema.decodeUnknown(prepared.outputSchema)(result)),
          Effect.orDie,
        )
      },
      abortSession: () => Effect.void,
      ...options.agentHarness,
    }),
    Layer.succeed(Workspace, {
      prepareReview: () => Effect.die("unused"),
      prepareFix: () => Effect.die("unused"),
      publishFix: () => Effect.die("unused"),
      ...options.workspace,
    }),
  )
}

const preparedReview = (context: AgentExecutionContext) => ({
  launchIntent: {
    sessionReferenceId: "22222222-2222-4222-8222-222222222222",
    sessionCreationId: "b".repeat(64),
    harness: { name: "opencode.pr-review", version: 1 },
    definitionHash: "a".repeat(64),
    agent: "pr-reviewer",
    model: "openai/gpt-5.6-sol",
    input: Schema.decodeUnknownSync(RunPullRequestAutomationInput)({
      directory: context.directory,
      repositoryFullName: "example-owner/example",
      pullRequestNumber: 7,
      baseSha: "d".repeat(40),
      headSha: "a".repeat(40),
    }),
    scope: context.scope,
    operationId: context.operationId,
    operationRevision: context.operationRevision,
    attempt: context.attempt,
    leaseToken: context.leaseToken,
    directory: context.directory,
    timeoutMs: 10_000,
    retryPolicy: {
      maxAttempts: 3,
      structuredOutputRetryCount: 2,
      invalidOutput: "retry" as const,
    },
    requestedAt: context.requestedAt.toISOString(),
  },
  title: "review:example-owner/example#7",
  prompt: "Review the pull request.",
  model: { providerID: "openai", modelID: "gpt-5.6-sol" },
  outputSchema: ReviewResult,
  outputJsonSchema: { type: "object" },
  pollIntervalMs: 1,
})

const preparedFix = (context: AgentExecutionContext) => ({
  ...preparedReview(context),
  launchIntent: {
    ...preparedReview(context).launchIntent,
    harness: { name: "opencode.pr-fix", version: 1 },
    agent: "pr-fixer",
  },
  outputSchema: FixResult,
})

const sessionReference = <Input>(prepared: { readonly launchIntent: AgentLaunchIntent<Input> }) =>
  Schema.decodeUnknownSync(SessionReference)({
    sessionReferenceId: prepared.launchIntent.sessionReferenceId,
    serverId: "opencode-primary",
    endpointAlias: "private-opencode",
    directory: prepared.launchIntent.directory,
    nativeSessionId: "ses_review",
    scope: prepared.launchIntent.scope,
    operationId: prepared.launchIntent.operationId,
    operationRevision: prepared.launchIntent.operationRevision,
    attempt: prepared.launchIntent.attempt,
    leaseToken: prepared.launchIntent.leaseToken,
    createdAt: "2026-07-20T12:00:00.000Z",
    state: "created",
  })

const jobOptions = {
  workerId: "worker-1",
  leaseDurationMs: 60_000,
  maxAttempts: 3,
  timeoutMs: 10_000,
  cancellationPollIntervalMs: 100,
  agentBranchPrefixes: [] as ReadonlyArray<string>,
  fixWorkEnabled: false,
  now: () => new Date("2026-07-19T12:00:00.000Z"),
}

test("aborts an expired native session before starting its replacement", async () => {
  const actions: Array<string> = []
  const oldReference = Schema.decodeUnknownSync(SessionReference)({
    ...sessionReference(
      preparedReview({
        directory: "/tmp/review",
        scope: { _tag: "GenerationScope", workflowId: "pr:42:7", generation: 1 },
        operationId: "job:1",
        operationRevision: 1,
        attempt: 1,
        leaseToken: "11111111-1111-4111-8111-111111111111",
        requestedAt: new Date("2026-07-19T11:58:00.000Z"),
      }),
    ),
    sessionReferenceId: "11111111-1111-4111-8111-111111111111",
    nativeSessionId: "ses_expired",
  })
  let cleanupReturned = false

  const result = await Effect.runPromise(
    runJobIteration(jobOptions).pipe(
      Effect.provide(
        makeWorkerLayer({
          store: {
            claimExpiredAgentSession: () => {
              if (cleanupReturned) return Effect.succeed(null)
              cleanupReturned = true
              return Effect.succeed(oldReference)
            },
            supersedeAgentSession: () => Effect.succeed("superseded"),
            claimNextJob: () => {
              actions.push("claim replacement")
              return Effect.succeed(makeReviewWork())
            },
            completeAgentReviewJob: () => Effect.succeed("completed"),
          },
          workspace: {
            prepareReview: () => Effect.succeed({ directory: "/tmp/review" }),
          },
          automation: {
            runReview: () =>
              Effect.succeed({ verdict: "pass" as const, summary: "No findings.", findings: [] }),
          },
          agentHarness: {
            abortSession: () => Effect.sync(() => actions.push("abort expired")),
            createSession: (prepared) =>
              Effect.sync(() => {
                actions.push("create replacement")
                return sessionReference(prepared)
              }),
          },
        }),
      ),
    ),
  )

  expect(result).toBe("completed")
  expect(actions).toEqual(["abort expired", "claim replacement", "create replacement"])
})

test("continues to unrelated work when aborting an expired session rejects", async () => {
  const oldReference = Schema.decodeUnknownSync(SessionReference)({
    ...sessionReference(
      preparedReview({
        directory: "/tmp/review",
        scope: { _tag: "GenerationScope", workflowId: "pr:42:7", generation: 1 },
        operationId: "job:1",
        operationRevision: 1,
        attempt: 1,
        leaseToken: "11111111-1111-4111-8111-111111111111",
        requestedAt: new Date("2026-07-19T11:58:00.000Z"),
      }),
    ),
    sessionReferenceId: "11111111-1111-4111-8111-111111111111",
    nativeSessionId: "ses_expired",
  })
  const unrelatedJob = makeReviewWork({ id: 12, pullRequestNumber: 8 })
  let jobClaims = 0
  let superseded = 0
  let cleanupClaims = 0
  const exit = await Effect.runPromise(
    runJobIteration(jobOptions).pipe(
      Effect.provide(
        makeWorkerLayer({
          store: {
            claimExpiredAgentSession: () =>
              Effect.sync(() => (cleanupClaims++ === 0 ? oldReference : null)),
            supersedeAgentSession: () =>
              Effect.sync(() => {
                superseded += 1
                return "superseded" as const
              }),
            claimNextJob: () => Effect.sync(() => (jobClaims++ === 0 ? unrelatedJob : null)),
            completeAgentReviewJob: () => Effect.succeed("completed"),
          },
          agentHarness: {
            abortSession: () =>
              Effect.fail(
                new AgentHarnessError({
                  operation: "abort session",
                  cause: new Error("abort rejected"),
                  retryable: true,
                }),
              ),
          },
          workspace: {
            prepareReview: () => Effect.succeed({ directory: "/tmp/unrelated-review" }),
          },
          automation: {
            runReview: () =>
              Effect.succeed({ verdict: "pass" as const, summary: "No findings.", findings: [] }),
          },
        }),
      ),
      Effect.exit,
    ),
  )

  expect(exit._tag).toBe("Success")
  if (exit._tag === "Success") expect(exit.value).toBe("completed")
  expect(superseded).toBe(0)
  expect(jobClaims).toBe(1)
})

test("records failed expired-session cleanup so the store can bound retries", async () => {
  const oldReference = Schema.decodeUnknownSync(SessionReference)({
    ...sessionReference(
      preparedReview({
        directory: "/tmp/review",
        scope: { _tag: "GenerationScope", workflowId: "pr:42:7", generation: 1 },
        operationId: "job:1",
        operationRevision: 1,
        attempt: 1,
        leaseToken: "11111111-1111-4111-8111-111111111111",
        requestedAt: new Date("2026-07-19T11:58:00.000Z"),
      }),
    ),
    sessionReferenceId: "11111111-1111-4111-8111-111111111111",
    nativeSessionId: "ses_expired",
  })
  let cleanupReturned = false
  const failures: Array<{ readonly sessionReferenceId: string; readonly workerId: string }> = []
  const store = {
    claimExpiredAgentSession: () =>
      Effect.sync(() => {
        if (cleanupReturned) return null
        cleanupReturned = true
        return oldReference
      }),
    recordAgentSessionCleanupFailure: (input: {
      readonly sessionReferenceId: string
      readonly workerId: string
      readonly failedAt: Date
      readonly error: string
    }) =>
      Effect.sync(() => {
        failures.push({
          sessionReferenceId: input.sessionReferenceId,
          workerId: input.workerId,
        })
        return "pending" as const
      }),
  } as Partial<WorkflowStorePort>

  await Effect.runPromise(
    runJobIteration(jobOptions).pipe(
      Effect.provide(
        makeWorkerLayer({
          store,
          agentHarness: {
            abortSession: () =>
              Effect.fail(
                new AgentHarnessError({
                  operation: "abort session",
                  cause: new Error("abort rejected"),
                  retryable: true,
                }),
              ),
          },
        }),
      ),
    ),
  )

  expect(failures).toEqual([
    {
      sessionReferenceId: oldReference.sessionReferenceId,
      workerId: jobOptions.workerId,
    },
  ])
})

test("retries cleanup after a stale session checkpoint abort fails", async () => {
  const job = makeReviewWork()
  let claimedJob = false
  let persistedReference: SessionReference | undefined
  let cleanupClaimed = false
  let abortAttempts = 0
  let superseded = 0
  const store = makeStore({
    claimExpiredAgentSession: () =>
      Effect.sync(() => {
        if (persistedReference === undefined || cleanupClaimed) return null
        cleanupClaimed = true
        return persistedReference
      }),
    claimNextJob: () =>
      Effect.sync(() => {
        if (claimedJob) return null
        claimedJob = true
        return job
      }),
    recordAgentSessionReference: (input) =>
      Effect.sync(() => {
        persistedReference = input.reference
        return "stale" as const
      }),
    supersedeAgentSession: () =>
      Effect.sync(() => {
        superseded += 1
        return "superseded" as const
      }),
  })
  const layer = makeWorkerLayer({
    store,
    workspace: {
      prepareReview: () => Effect.succeed({ directory: "/tmp/review" }),
    },
    agentHarness: {
      abortSession: () =>
        Effect.suspend(() => {
          abortAttempts += 1
          return abortAttempts === 1
            ? Effect.fail(
                new AgentHarnessError({
                  operation: "abort session",
                  cause: new Error("abort rejected"),
                  retryable: true,
                }),
              )
            : Effect.void
        }),
    },
  })

  const first = await Effect.runPromise(runJobIteration(jobOptions).pipe(Effect.provide(layer)))
  const second = await Effect.runPromise(runJobIteration(jobOptions).pipe(Effect.provide(layer)))

  expect(first).toBe("cleanup_pending")
  expect(second).toBe("idle")
  expect(abortAttempts).toBe(2)
  expect(superseded).toBe(1)
})

const makePublication = (id = 1) =>
  Schema.decodeUnknownSync(Publication)({
    id,
    operationKey: "review:42:7:1",
    installationId: 91,
    repositoryId: 42,
    repositoryFullName: "example-owner/example",
    pullRequestNumber: 7,
    target: {
      baseSha: "d".repeat(40),
      baseRef: "main",
      headSha: "a".repeat(40),
      headRef: "opencode/example-job",
      headRepositoryFullName: "example-owner/example",
    },
    generation: 1,
    reviewRequestNumber: 1,
    review: {
      verdict: "pass",
      summary: "No findings.",
      findings: [],
    },
    attempt: 1,
  })

describe("Review Work processing", () => {
  test("reviews the scoped worktree and commits the structured result", async () => {
    const actions: Array<string> = []
    const job = makeReviewWork({ target: { headRef: "feature" } })
    let prepared: ReturnType<typeof preparedReview> | undefined

    const result = await Effect.runPromise(
      runJobIteration(jobOptions).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextJob: () => Effect.succeed(job),
              recordAgentLaunchIntent: () =>
                Effect.sync(() => {
                  actions.push("launch")
                  return "recorded" as const
                }),
              recordAgentSessionReference: () =>
                Effect.sync(() => {
                  actions.push("session")
                  return "recorded" as const
                }),
              completeAgentReviewJob: (input) =>
                Effect.sync(() => {
                  actions.push(`complete:${input.review.verdict}`)
                  return "completed" as const
                }),
            },
            automation: {
              prepareReview: (_input, context) =>
                Effect.sync(() => {
                  actions.push("prepare")
                  prepared = preparedReview(context)
                  return prepared
                }),
            },
            agentHarness: {
              createSession: () =>
                Effect.sync(() => {
                  actions.push("create")
                  return sessionReference(prepared!)
                }),
              resumeSession: (agentWork) =>
                Effect.sync(() => {
                  actions.push("prompt")
                  return {
                    verdict: "pass" as const,
                    summary: "No actionable findings.",
                    findings: [],
                  }
                }).pipe(
                  Effect.flatMap((result) => Schema.decodeUnknown(agentWork.outputSchema)(result)),
                  Effect.orDie,
                ),
            },
            workspace: {
              prepareReview: () =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    actions.push("workspace:acquire")
                    return {
                      directory: "/tmp/review",
                    }
                  }),
                  () => Effect.sync(() => actions.push("workspace:release")),
                ),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("completed")
    expect(actions).toEqual([
      "workspace:acquire",
      "prepare",
      "launch",
      "create",
      "session",
      "prompt",
      "complete:pass",
      "workspace:release",
    ])
  })

  test("queues a fixer after findings on an agent-owned PR", async () => {
    const enqueued: Array<number> = []
    const job = makeReviewWork({ author: "example-owner" })

    await Effect.runPromise(
      runJobIteration({
        ...jobOptions,
        agentBranchPrefixes: ["opencode/"],
        fixWorkEnabled: true,
      }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextJob: () => Effect.succeed(job),
              completeReviewJob: (input) =>
                Effect.sync(() => {
                  if (input.autoFix) enqueued.push(input.jobId)
                  return "completed" as const
                }),
            },
            workspace: {
              prepareReview: () => Effect.succeed({ directory: "/tmp/review" }),
            },
            automation: {
              runReview: () =>
                Effect.succeed({
                  verdict: "changes_requested",
                  summary: "One issue.",
                  findings: [{ severity: "high", title: "Bug", body: "Fix the bug." }],
                }),
            },
          }),
        ),
      ),
    )

    expect(enqueued).toEqual([11])
  })

  test("does not queue Fix Work when the feature is disabled", async () => {
    const autoFixValues: Array<boolean> = []
    const job = makeReviewWork({ target: { headRef: "opencode/agent-work" } })

    await Effect.runPromise(
      runJobIteration({
        ...jobOptions,
        agentBranchPrefixes: ["opencode/"],
      }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextJob: () => Effect.succeed(job),
              completeReviewJob: (input) =>
                Effect.sync(() => {
                  autoFixValues.push(input.autoFix)
                  return "completed" as const
                }),
            },
            workspace: {
              prepareReview: () => Effect.succeed({ directory: "/tmp/review" }),
            },
            automation: {
              runReview: () =>
                Effect.succeed({
                  verdict: "changes_requested",
                  summary: "One issue.",
                  findings: [{ severity: "high", title: "Bug", body: "Fix the bug." }],
                }),
            },
          }),
        ),
      ),
    )

    expect(autoFixValues).toEqual([false])
  })
})

describe("Fix Work processing", () => {
  test("terminally disables claimed Fix Work without invoking OpenCode or Git", async () => {
    const disabled: Array<number> = []
    const job = makeFixWork({ id: 15 })

    const result = await Effect.runPromise(
      runJobIteration(jobOptions).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextJob: () => Effect.succeed(job),
              disableFixJob: (input) =>
                Effect.sync(() => {
                  disabled.push(input.jobId)
                  return "disabled" as const
                }),
            },
            automation: { runFix: () => Effect.die("must not run fixer") },
            workspace: {
              prepareFix: () => Effect.die("must not prepare fix workspace"),
              publishFix: () => Effect.die("must not publish fix"),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("disabled")
    expect(disabled).toEqual([15])
  })

  test("persists, verifies, and publishes the typed fixer result before completion", async () => {
    const actions: Array<string> = []
    const job = makeFixWork({
      id: 12,
      author: "example-owner",
    })

    const result = await Effect.runPromise(
      runJobIteration({
        ...jobOptions,
        workerId: "fixer-1",
        fixWorkEnabled: true,
      }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextJob: () => Effect.succeed(job),
              recordFixResult: () =>
                Effect.sync(() => {
                  actions.push("record")
                  return "recorded" as const
                }),
              completeFixJob: () =>
                Effect.sync(() => {
                  actions.push("complete")
                  return "completed" as const
                }),
            },
            automation: {
              runFix: () =>
                Effect.sync(() => {
                  actions.push("fix")
                  return Schema.decodeUnknownSync(FixResult)({
                    _tag: "CommitPrepared" as const,
                    summary: "Prepared the fix commit.",
                    commitSha: "c".repeat(40),
                  })
                }),
            },
            workspace: {
              prepareFix: () =>
                Effect.acquireRelease(
                  Effect.succeed({
                    directory: "/tmp/fix",
                    recovery: "none" as const,
                    markCompleted: () => actions.push("mark"),
                  }),
                  () => Effect.sync(() => actions.push("workspace:release")),
                ),
              publishFix: () =>
                Effect.sync(() => {
                  actions.push("publish")
                }),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("completed")
    expect(actions).toEqual(["fix", "record", "publish", "complete", "mark", "workspace:release"])
  })

  test("passes Workspace a durable currentness capability before fix publication", async () => {
    const checks: Array<string> = []
    const job = makeFixWork({ id: 14 })

    await Effect.runPromise(
      runJobIteration({
        ...jobOptions,
        workerId: "fixer-currentness",
        fixWorkEnabled: true,
      }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextJob: () => Effect.succeed(job),
              recordFixResult: () => Effect.succeed("recorded"),
              isJobCurrent: (jobId, workerId, now) =>
                Effect.sync(() => {
                  checks.push(`${jobId}:${workerId}:${now.toISOString()}`)
                  return true
                }),
              completeFixJob: () => Effect.succeed("completed"),
            },
            automation: {
              runFix: () =>
                Effect.succeed(
                  Schema.decodeUnknownSync(FixResult)({
                    _tag: "NoChanges",
                    summary: "No changes.",
                  }),
                ),
            },
            workspace: {
              prepareFix: () =>
                Effect.succeed({
                  directory: "/tmp/fix",
                  recovery: "none" as const,
                  markCompleted: () => undefined,
                }),
              publishFix: (_job, _workspace, _result, isCurrent) =>
                isCurrent(new Date("2026-07-19T12:00:00.000Z")).pipe(Effect.asVoid),
            },
          }),
        ),
      ),
    )

    expect(checks).toEqual(["14:fixer-currentness:2026-07-19T12:00:00.000Z"])
  })

  test("recovers an already-pushed job without invoking the fixer again", async () => {
    const actions: Array<string> = []
    const job = makeFixWork({
      id: 12,
      author: "example-owner",
      attempt: 2,
    })

    const result = await Effect.runPromise(
      runJobIteration({
        ...jobOptions,
        workerId: "fixer-2",
        fixWorkEnabled: true,
      }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextJob: () => Effect.succeed(job),
              recordFixResult: () => Effect.die("must not record a synthetic result"),
              completeFixJob: () =>
                Effect.sync(() => {
                  actions.push("complete")
                  return "completed" as const
                }),
            },
            automation: { runFix: () => Effect.die("must not run fixer") },
            workspace: {
              prepareFix: () =>
                Effect.succeed({
                  directory: "/tmp/fix",
                  recovery: "pushed" as const,
                  markCompleted: () => actions.push("mark"),
                }),
              publishFix: (_job, _workspace, fixResult) =>
                Effect.sync(() => {
                  expect(fixResult).toBeUndefined()
                  actions.push("verify")
                }),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("completed")
    expect(actions).toEqual(["verify", "complete", "mark"])
  })
})

describe("runJobIteration", () => {
  test("durably reschedules a failed worker attempt", async () => {
    const calls: Array<string> = []
    const job = makeReviewWork({ id: 12, author: "example-owner" })

    const result = await Effect.runPromise(
      runJobIteration(jobOptions).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextJob: () => Effect.succeed(job),
              rescheduleJob: (input) =>
                Effect.sync(() => {
                  calls.push(input.error)
                  return "retry" as const
                }),
            },
            workspace: {
              prepareReview: () => Effect.succeed({ directory: "/tmp/review" }),
            },
            automation: {
              runReview: () => Effect.die(new Error("temporary failure")),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("retry")
    expect(calls[0]).toContain("temporary failure")
  })

  test("exhausts the current attempt for terminal structured-output policy", async () => {
    const job = makeReviewWork({ id: 18, attempt: 2 })
    let maxAttempts = 0

    const result = await Effect.runPromise(
      runJobIteration(jobOptions).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextJob: () => Effect.succeed(job),
              rescheduleJob: (input) =>
                Effect.sync(() => {
                  maxAttempts = input.maxAttempts
                  return "failed" as const
                }),
            },
            agentHarness: {
              resumeSession: () =>
                Effect.fail(
                  new AgentHarnessError({
                    operation: "decode structured session output",
                    cause: new Error("invalid output"),
                    retryable: false,
                  }),
                ),
            },
            workspace: {
              prepareReview: () => Effect.succeed({ directory: "/tmp/review" }),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("failed")
    expect(maxAttempts).toBe(2)
  })

  test("uses the prepared harness retry limit instead of the worker limit", async () => {
    const job = makeReviewWork({ id: 19 })
    let maxAttempts = 0

    const result = await Effect.runPromise(
      runJobIteration({ ...jobOptions, maxAttempts: 5 }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextJob: () => Effect.succeed(job),
              rescheduleJob: (input) =>
                Effect.sync(() => {
                  maxAttempts = input.maxAttempts
                  return "failed" as const
                }),
            },
            automation: {
              prepareReview: (_input, context) => {
                const prepared = preparedReview(context)
                return Effect.succeed({
                  ...prepared,
                  launchIntent: {
                    ...prepared.launchIntent,
                    retryPolicy: { ...prepared.launchIntent.retryPolicy, maxAttempts: 1 },
                  },
                })
              },
            },
            agentHarness: {
              resumeSession: () =>
                Effect.fail(
                  new AgentHarnessError({
                    operation: "run structured agent session",
                    cause: new Error("temporary failure"),
                    retryable: true,
                  }),
                ),
            },
            workspace: {
              prepareReview: () => Effect.succeed({ directory: "/tmp/review" }),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("failed")
    expect(maxAttempts).toBe(1)
  })
})

describe("runPublicationIteration", () => {
  test("passes GitHub a durable currentness guard for the claimed Publication", async () => {
    const calls: Array<string> = []
    const publication = makePublication()
    const result = await Effect.runPromise(
      runPublicationIteration({
        workerId: "publisher-guarded",
        leaseDurationMs: 60_000,
        maxAttempts: 3,
        timeoutMs: 10_000,
        now: () => new Date("2026-07-19T12:00:00.000Z"),
      }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextPublication: () => Effect.succeed(publication),
              isPublicationCurrent: (publicationId, workerId) =>
                Effect.sync(() => {
                  calls.push(`guard:${publicationId}:${workerId}`)
                  return true
                }),
              completePublication: () => Effect.succeed("completed"),
            },
            github: {
              publishReview: (_publication, isCurrent) =>
                isCurrent(new Date("2026-07-19T12:00:00.000Z")).pipe(
                  Effect.as("published" as const),
                ),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("completed")
    expect(calls).toEqual(["guard:1:publisher-guarded"])
  })

  test("publishes and durably completes an outbox item", async () => {
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      runPublicationIteration({
        workerId: "publisher-1",
        leaseDurationMs: 60_000,
        maxAttempts: 3,
        timeoutMs: 10_000,
        now: () => new Date("2026-07-19T12:00:00.000Z"),
      }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextPublication: () => Effect.succeed(makePublication()),
              completePublication: () =>
                Effect.sync(() => {
                  calls.push("complete")
                  return "completed" as const
                }),
            },
            github: {
              publishReview: () =>
                Effect.sync(() => {
                  calls.push("publish")
                  return "published" as const
                }),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("completed")
    expect(calls).toEqual(["publish", "complete"])
  })

  test("propagates a stale GitHub outcome to durable completion", async () => {
    const outcomes: Array<"published" | "stale"> = []
    const result = await Effect.runPromise(
      runPublicationIteration({
        workerId: "publisher-1",
        leaseDurationMs: 60_000,
        maxAttempts: 3,
        timeoutMs: 10_000,
        now: () => new Date("2026-07-19T12:00:00.000Z"),
      }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextPublication: () => Effect.succeed(makePublication()),
              completePublication: (input) =>
                Effect.sync(() => {
                  outcomes.push(input.outcome)
                  return "stale" as const
                }),
            },
            github: { publishReview: () => Effect.succeed("stale") },
          }),
        ),
      ),
    )

    expect(result).toBe("stale")
    expect(outcomes).toEqual(["stale"])
  })

  test("interrupts a timed out publication before durably rescheduling it", async () => {
    const actions: Array<string> = []
    const result = await Effect.runPromise(
      runPublicationIteration({
        workerId: "publisher-timeout",
        leaseDurationMs: 70_000,
        maxAttempts: 2,
        timeoutMs: 10,
        now: () => new Date("2026-07-19T12:00:00.000Z"),
      }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextPublication: () => Effect.succeed(makePublication(2)),
              completePublication: () => Effect.die("must not complete"),
              reschedulePublication: (input) =>
                Effect.sync(() => {
                  actions.push(`reschedule:${input.maxAttempts}`)
                  return "retry" as const
                }),
            },
            github: {
              publishReview: () =>
                Effect.never.pipe(
                  Effect.ensuring(Effect.sync(() => actions.push("publish:aborted"))),
                ),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("retry")
    expect(actions).toEqual(["publish:aborted", "reschedule:2"])
  })
})

describe("runCommandIteration", () => {
  test("durably reschedules a failed command with bounded attempts", async () => {
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      runCommandIteration({
        workerId: "commands-1",
        leaseDurationMs: 60_000,
        maxAttempts: 3,
        commandUsers: ["example-owner"],
        fixWorkEnabled: false,
        now: () => new Date("2026-07-19T12:00:00.000Z"),
      }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextCommand: () =>
                Effect.succeed({
                  id: 3,
                  command: "review",
                  commentId: 99,
                  commenter: "Example-Owner",
                  installationId: 91,
                  repositoryId: 42,
                  repositoryFullName: "example-owner/example",
                  pullRequestNumber: 7,
                  attempts: 2,
                }),
              executeCommand: () => Effect.die(new Error("database unavailable")),
              rescheduleCommand: (input) =>
                Effect.sync(() => {
                  calls.push(`${input.maxAttempts}:${input.error}`)
                  return "retry" as const
                }),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("retry")
    expect(calls[0]).toContain("3:Error: database unavailable")
  })
})

describe("runReconciliationIteration", () => {
  test("turns an ambiguous webhook into the authoritative review generation", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const updatedAt = "2026-07-19T12:00:00.000Z"
        yield* store.ingestPullRequest(
          {
            deliveryId: "runtime-reconcile-initial",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:01.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            pullRequest: { ...samplePullRequestEvent.pullRequest, updatedAt },
          }),
        )
        const original = yield* store.claimNextJob({
          workerId: "runtime-original-review",
          now: new Date("2026-07-19T12:00:02.000Z"),
          leaseDurationMs: 60_000,
        })
        if (original === null) throw new Error("expected original review")
        yield* store.ingestPullRequest(
          {
            deliveryId: "runtime-reconcile-ambiguous",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:03.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "e".repeat(40),
              updatedAt,
            },
          }),
        )

        const iteration = yield* runReconciliationIteration({
          workerId: "reconciler-runtime",
          leaseDurationMs: 60_000,
          maxAttempts: 3,
          now: () => new Date("2026-07-19T12:01:00.000Z"),
        })
        const review = yield* store.claimNextJob({
          workerId: "runtime-authoritative-review",
          now: new Date("2026-07-19T12:02:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { iteration, review }
      }).pipe(
        Effect.provide(
          Layer.merge(
            makeStoreLayer(),
            Layer.succeed(GitHub, {
              publishReview: () => Effect.die("must not publish"),
              fetchPullRequestSnapshot: () =>
                Effect.succeed({
                  _tag: "AuthoritativePullRequestSnapshot" as const,
                  installationId: 91,
                  repository: samplePullRequestEvent.repository,
                  pullRequest: {
                    ...samplePullRequestEvent.pullRequest,
                    headSha: "b".repeat(40),
                    updatedAt: "2026-07-19T12:00:04.000Z",
                  },
                }),
            }),
          ),
        ),
      ),
    )

    expect(result.iteration).toBe("completed")
    expect(result.review).toMatchObject({
      target: { headSha: "b".repeat(40) },
      generation: 2,
    })
  })

  test("does not apply worker A's response after worker B reclaims and completes", async () => {
    const workerAFetched = Effect.runSync(Deferred.make<void>())
    const releaseWorkerA = Effect.runSync(Deferred.make<void>())
    let fetches = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const observedAt = "2026-07-19T12:00:00.000Z"
        yield* store.ingestPullRequest(
          {
            deliveryId: "worker-race-initial",
            event: "pull_request",
            action: "opened",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:00.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              updatedAt: observedAt,
            },
          }),
        )
        yield* store.ingestPullRequest(
          {
            deliveryId: "worker-race-ambiguous",
            event: "pull_request",
            action: "synchronize",
            payload: "{}",
            receivedAt: new Date("2026-07-19T12:00:01.000Z"),
          },
          decodePullRequestEvent({
            ...samplePullRequestEvent,
            action: "synchronize",
            pullRequest: {
              ...samplePullRequestEvent.pullRequest,
              headSha: "e".repeat(40),
              updatedAt: observedAt,
            },
          }),
        )

        const workerA = yield* Effect.fork(
          runReconciliationIteration({
            workerId: "reconciler-a",
            leaseDurationMs: 1_000,
            maxAttempts: 3,
            now: () => new Date("2026-07-19T12:01:00.000Z"),
          }),
        )
        yield* Deferred.await(workerAFetched)
        const workerB = yield* runReconciliationIteration({
          workerId: "reconciler-b",
          leaseDurationMs: 60_000,
          maxAttempts: 3,
          now: () => new Date("2026-07-19T12:01:02.000Z"),
        })
        yield* Deferred.succeed(releaseWorkerA, undefined)
        const staleWorker = yield* Fiber.join(workerA)
        const review = yield* store.claimNextJob({
          workerId: "reviewer-after-race",
          now: new Date("2026-07-19T12:02:00.000Z"),
          leaseDurationMs: 60_000,
        })
        return { review, staleWorker, workerB }
      }).pipe(
        Effect.provide(
          Layer.merge(
            makeStoreLayer(),
            Layer.succeed(GitHub, {
              publishReview: () => Effect.die("must not publish"),
              fetchPullRequestSnapshot: () =>
                Effect.gen(function* () {
                  fetches += 1
                  if (fetches === 1) {
                    yield* Deferred.succeed(workerAFetched, undefined)
                    yield* Deferred.await(releaseWorkerA)
                    return {
                      _tag: "AuthoritativePullRequestSnapshot" as const,
                      installationId: 91,
                      repository: samplePullRequestEvent.repository,
                      pullRequest: {
                        ...samplePullRequestEvent.pullRequest,
                        headSha: "c".repeat(40),
                        updatedAt: "2026-07-19T12:00:01.000Z",
                      },
                    }
                  }
                  return {
                    _tag: "AuthoritativePullRequestSnapshot" as const,
                    installationId: 91,
                    repository: samplePullRequestEvent.repository,
                    pullRequest: {
                      ...samplePullRequestEvent.pullRequest,
                      headSha: "b".repeat(40),
                      updatedAt: "2026-07-19T12:00:02.000Z",
                    },
                  }
                }),
            }),
          ),
        ),
      ),
    )

    expect(result.workerB).toBe("completed")
    expect(result.staleWorker).toBe("stale")
    expect(result.review).toMatchObject({
      generation: 2,
      target: { headSha: "b".repeat(40) },
    })
  })
})

describe("job cancellation", () => {
  test("aborts a session when interrupted immediately after creation", async () => {
    const job = makeReviewWork()
    let aborts = 0

    const result = await Effect.runPromise(
      runJobIteration({
        ...jobOptions,
        timeoutMs: 1,
      }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextJob: () => Effect.succeed(job),
              rescheduleJob: () => Effect.succeed("retry"),
            },
            workspace: {
              prepareReview: () => Effect.succeed({ directory: "/tmp/review" }),
            },
            agentHarness: {
              createSession: (prepared) =>
                Effect.uninterruptible(
                  Effect.sleep(10).pipe(Effect.as(sessionReference(prepared))),
                ),
              abortSession: () =>
                Effect.sync(() => {
                  aborts += 1
                }),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("retry")
    expect(aborts).toBe(1)
  })

  test("interrupts the active job when its durable lease is superseded", async () => {
    const actions: Array<string> = []
    const started = Effect.runSync(Deferred.make<void>())
    const job = makeReviewWork()

    const result = await Effect.runPromise(
      runJobIteration({
        ...jobOptions,
        cancellationPollIntervalMs: 0,
      }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextJob: () => Effect.succeed(job),
              shouldCancelJob: () => Deferred.await(started).pipe(Effect.as(true)),
              rescheduleJob: () => Effect.succeed("retry"),
            },
            workspace: {
              prepareReview: () => Effect.succeed({ directory: "/tmp/review" }),
            },
            automation: {
              runReview: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Effect.sync(() => actions.push("interrupted"))),
                ),
            },
            agentHarness: {
              abortSession: () => Effect.sync(() => actions.push("abort")),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("retry")
    expect(actions).toEqual(["interrupted", "abort"])
  })

  test("keeps the job fenced when aborting its active session fails", async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const job = makeReviewWork()
    let reschedules = 0

    const result = await Effect.runPromise(
      runJobIteration({
        ...jobOptions,
        cancellationPollIntervalMs: 0,
      }).pipe(
        Effect.provide(
          makeWorkerLayer({
            store: {
              claimNextJob: () => Effect.succeed(job),
              shouldCancelJob: () => Deferred.await(started).pipe(Effect.as(true)),
              rescheduleJob: () =>
                Effect.sync(() => {
                  reschedules += 1
                  return "retry" as const
                }),
            },
            workspace: {
              prepareReview: () => Effect.succeed({ directory: "/tmp/review" }),
            },
            automation: {
              runReview: () =>
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            },
            agentHarness: {
              abortSession: () =>
                Effect.fail(
                  new AgentHarnessError({
                    operation: "abort session",
                    cause: new Error("abort rejected"),
                    retryable: true,
                  }),
                ),
            },
          }),
        ),
      ),
    )

    expect(result).toBe("cleanup_pending")
    expect(reschedules).toBe(0)
  })
})
