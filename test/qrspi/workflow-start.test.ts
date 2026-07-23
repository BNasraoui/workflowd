import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Cause, Effect, Fiber, Layer, Schema } from "effect"
import { AgentHarness, AgentHarnessError, type AgentHarnessPort } from "../../src/agent-harness"
import {
  QrspiRepository,
  QrspiRepositoryError,
  TicketSource,
  TicketSourceError,
  type QrspiRepositoryPort,
  type TicketSourcePort,
} from "../../src/qrspi/ports"
import { QrspiStore, QrspiStoreLive } from "../../src/qrspi/store"
import {
  StageCatalog,
  TrustedStageCatalog,
  type StageContract,
} from "../../src/qrspi/stage-catalog"
import {
  WorkflowStart,
  WorkflowStartLive,
  makeWorkflowStart,
  type WorkflowStartOptions,
} from "../../src/qrspi/workflow-start"
import type { JsonValue } from "../../src/json"
import {
  WorkflowStartInput,
  WorkflowStartRequest,
  stageDefinitionSha256,
  workflowIdFor,
  type RepositoryReference,
  type StageDefinition,
} from "../../src/qrspi/domain"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

const repository = {
  providerInstanceId: "github-app-123",
  repositoryId: "42",
  repositoryFullName: "example-owner/example",
} as const

function stageSnapshot(definition: StageDefinition = options.workflowDefinition.stages[0]) {
  return {
    sequencePosition: 1,
    stageDefinitionSha256: stageDefinitionSha256(definition),
    definition,
    contractRegistrationSha256: "a".repeat(64),
    harnessRegistrationSha256: "b".repeat(64),
  }
}
const ticketReference = {
  tracker: "beads",
  trackerInstanceId: "workspace-42",
  nativeTicketId: "workflowd-vs3.3",
} as const
const request = {
  repository,
  ticket: ticketReference,
  readinessJudgment: {
    userStory: "optional",
    productDirection: "consistent",
    productOutcome: "clear",
    acceptanceCriteriaObservability: ["observable"],
    scenarioCoverage: [[0]],
  },
} as const
const baseSha = "d".repeat(40)
const readyTicket = {
  reference: ticketReference,
  issueType: "feature",
  title: "Kick off a QRSPI workflow",
  description:
    "Workflowd currently cannot start planning from Beads. An authorized maintainer needs kickoff to create durable planning work while preserving Beads as product authority and rejecting cross-workspace input.",
  userStory:
    "As a repository maintainer, I want to start QRSPI from a ready Beads ticket, so that planning survives restarts.",
  sources: ["https://example.test/contracts/qrspi"],
  acceptanceCriteria: ["An authorized caller receives a durable running generation."],
  scenarios: [
    {
      name: "Ready kickoff",
      given: "a ready ticket and unchanged repository",
      when: "the caller starts QRSPI",
      then: "one durable generation is running",
      covers: [0],
    },
  ],
} as const

type FakeOptions = {
  readonly ticket?: JsonValue
  readonly inspectedRepository?: RepositoryReference
  readonly crashAfterCreate?: boolean
  readonly crashBeforeCreate?: boolean
  readonly initialBranchSha?: string
  readonly openPullRequest?: boolean
  readonly ticketError?: Error
  readonly createGate?: Promise<void>
  readonly onCreateEntered?: () => void
  readonly loseFirstCreatedBranch?: boolean
  readonly unknownAfterAcceptance?: boolean
  readonly createDelayMs?: number
  readonly createNever?: boolean
  readonly inspectError?: Error
  readonly inspectedBaseSha?: string
}

function fakes(options: FakeOptions = {}) {
  let ticket: JsonValue = options.ticket ?? readyTicket
  let branchSha = options.initialBranchSha
  let createCalls = 0
  let pullRequestCalls = 0
  let openPullRequest = options.openPullRequest ?? false
  let crashed = false
  let lostCreatedBranch = false
  let branchHistoryTrusted = true
  let inspectedBaseSha = options.inspectedBaseSha ?? baseSha
  const authorityTokens: Array<string | undefined> = []
  const tickets: TicketSourcePort = {
    read: () =>
      options.ticketError === undefined
        ? Effect.succeed(ticket)
        : Effect.fail(new TicketSourceError({ cause: options.ticketError })),
  }
  const observeCurrentBranch = () => {
    if (
      options.loseFirstCreatedBranch &&
      createCalls === 1 &&
      branchSha !== undefined &&
      !lostCreatedBranch
    ) {
      lostCreatedBranch = true
      branchSha = undefined
    }
    return branchSha
  }
  const repositories = {
    inspect: () =>
      options.inspectError === undefined
        ? Effect.succeed({
            repository: options.inspectedRepository ?? repository,
            baseRef: "main",
            baseSha: inspectedBaseSha,
            headRepository: options.inspectedRepository ?? repository,
          })
        : Effect.fail(
            new QrspiRepositoryError({ operation: "inspect", cause: options.inspectError }),
          ),
    hasOpenPullRequest: () => {
      pullRequestCalls += 1
      return Effect.succeed(openPullRequest)
    },
    observeBranch: () => {
      const sha = observeCurrentBranch()
      return Effect.succeed(sha === undefined ? null : { sha })
    },
    observeAcceptedBranch: ({ baseSha: expectedBaseSha, previousTrustedSha }) => {
      const sha = observeCurrentBranch()
      if (sha === undefined) return Effect.succeed({ _tag: "Absent" } as const)
      if (!branchHistoryTrusted || (previousTrustedSha === null && sha !== expectedBaseSha)) {
        return Effect.succeed({ _tag: "UnknownHistory", sha } as const)
      }
      return Effect.succeed({ _tag: "Accepted", sha } as const)
    },
    createBranch: ({ expectedBaseSha, authority }) =>
      Effect.gen(function* () {
        createCalls += 1
        authorityTokens.push(authority?.leaseToken)
        options.onCreateEntered?.()
        if (options.createGate !== undefined) {
          yield* Effect.promise(() => options.createGate!)
        }
        if (options.createDelayMs !== undefined) yield* Effect.sleep(options.createDelayMs)
        if (options.createNever) return yield* Effect.never
        if (options.crashBeforeCreate && !crashed) {
          crashed = true
          return yield* Effect.fail(new Error("simulated process stop"))
        }
        branchSha = expectedBaseSha
        if (options.unknownAfterAcceptance) {
          return yield* Effect.fail(
            new QrspiRepositoryError({
              operation: "create branch",
              cause: new Error("connection reset after write"),
            }),
          )
        }
        if (options.crashAfterCreate && !crashed) {
          crashed = true
          return yield* Effect.fail(new Error("simulated process stop"))
        }
        return { sha: branchSha }
      }),
  } satisfies QrspiRepositoryPort
  return {
    tickets,
    repositories,
    setTicket: (next: JsonValue) => {
      ticket = next
    },
    setBranch: (sha: string) => {
      branchSha = sha
    },
    setBase: (sha: string) => {
      inspectedBaseSha = sha
    },
    setOpenPullRequest: (value: boolean) => {
      openPullRequest = value
    },
    setBranchHistoryTrusted: (value: boolean) => {
      branchHistoryTrusted = value
    },
    branchHistory: () => branchHistoryTrusted,
    counts: () => ({ createCalls, pullRequestCalls, authorityTokens }),
  }
}

const StageRequest = Schema.Struct({ ticket: Schema.String })
const StageResult = Schema.Struct({ text: Schema.String })
const questionsContract: StageContract<
  typeof StageRequest.Type,
  typeof StageRequest.Encoded,
  typeof StageResult.Type,
  typeof StageResult.Encoded
> = {
  ref: { name: "qrspi.questions", contractVersion: 1 },
  kind: "document",
  requestSchema: StageRequest,
  resultSchema: StageResult,
  maxRequestBytes: 16_384,
  maxResultBytes: 16_384,
  compatibility: () => undefined,
  assembleRequest: () => ({ ticket: "fixture" }),
  buildTask: () => ({ title: "questions", prompt: "questions", resultSchema: StageResult }),
  prepareOutput: (result) => ({ _tag: "Document", text: result.text }),
}

function layer(
  filename: string,
  fake: ReturnType<typeof fakes>,
  validateAvailability: AgentHarnessPort["validateAvailability"] = () => Effect.void,
) {
  const database = SqliteClient.layer({ filename })
  const catalog = new TrustedStageCatalog([questionsContract])
  const harness: AgentHarnessPort = {
    describe: (ref) => Effect.succeed({ ref, registrationSha256: "b".repeat(64) }),
    validateAvailability,
    prepare: () => Effect.die("unused"),
    createSession: () => Effect.die("unused"),
    resumeSession: () => Effect.die("unused"),
    abortSession: () => Effect.die("unused"),
  }
  return Layer.mergeAll(
    QrspiStoreLive.pipe(Layer.provideMerge(database)),
    Layer.succeed(TicketSource, fake.tickets),
    Layer.succeed(QrspiRepository, fake.repositories),
    Layer.succeed(StageCatalog, catalog.port()),
    Layer.succeed(AgentHarness, harness),
  )
}

const trustedStageSemantics = {
  contract: { name: "qrspi.questions", contractVersion: 1 },
  definitionVersion: 1,
  maxEncodedInputBytes: 16_384,
  producer: {
    harness: { name: "opencode", version: 1 },
    agent: "qrspi-producer",
    model: "openai/gpt-5.6-sol",
    timeoutMs: 60_000,
    retry: { maxAttempts: 3, backoffMs: 1_000 },
  },
  outputPolicy: {
    _tag: "Artifact" as const,
    pathTemplate: "docs/qrspi/{ticketId}/{stageKey}.md",
    mediaType: "text/markdown",
  },
  reviewPolicy: { mode: "none" as const },
  humanGatePolicy: { mode: "none" as const },
} as const

let randomSequence = 0
const options = {
  binding: { repository, trackerInstanceId: "workspace-42" },
  baseRef: "main",
  workflowDefinition: {
    contractVersion: 1,
    definitionVersion: 1,
    stages: [
      {
        key: "questions",
        kind: "document",
        activation: { mode: "enabled" },
        ...trustedStageSemantics,
      },
    ],
  },
  now: () => new Date("2026-07-21T05:00:00.000Z"),
  randomId: () => `00000000-0000-4000-8000-${String(++randomSequence).padStart(12, "0")}`,
  repositoryOperationTimeoutMs: 50,
  operationCompletionMarginMs: 25,
  leaseDurationMs: 100,
  sourceResolver: () => true,
} as const

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-qrspi-"))
  directories.push(directory)
  return join(directory, "workflowd.db")
}

async function start(filename: string, fake: ReturnType<typeof fakes>) {
  return startWithOptions(filename, fake, options)
}

async function startWithOptions(
  filename: string,
  fake: ReturnType<typeof fakes>,
  startOptions: WorkflowStartOptions,
  startRequest: typeof WorkflowStartRequest.Type = request,
) {
  const result = await Effect.runPromise(
    makeWorkflowStart(startOptions)(startRequest).pipe(
      Effect.provide(layer(filename, fake)),
      Effect.either,
    ),
  )
  if (result._tag === "Left") {
    if (result.left instanceof Error) throw result.left
    throw new Error("Unexpected non-Error workflow failure")
  }
  return result.right
}

async function counts(filename: string, fake: ReturnType<typeof fakes>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* Effect.all([
        sql<{ readonly count: number }>`SELECT count(*) AS count FROM qrspi_generations`,
        sql<{ readonly count: number }>`SELECT count(*) AS count FROM workflow_operations`,
        sql<{ readonly count: number }>`SELECT count(*) AS count FROM qrspi_ticket_revisions`,
      ])
      return rows.map((row) => Number(row[0]?.count ?? 0))
    }).pipe(Effect.provide(layer(filename, fake))),
  )
}

describe("WorkflowStart integration", () => {
  test("creates one Ready generation and atomic initial blocked/ready operations", async () => {
    const filename = await databasePath()
    const fake = fakes()

    const result = await start(filename, fake)

    expect(result).toMatchObject({
      _tag: "Started",
      generation: 1,
      branchName: "feature/workflowd-vs3.3-kick-off-a-qrspi-workflow",
      rootSha: baseSha,
    })
    expect(await counts(filename, fake)).toEqual([1, 3, 1])
    expect(fake.counts()).toMatchObject({ createCalls: 1, pullRequestCalls: 2 })
    const definition = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly definition_json: string; readonly definition_sha256: string }>`
          SELECT definition_json, definition_sha256 FROM qrspi_workflow_definitions
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(JSON.parse(definition[0]!.definition_json)).toEqual(options.workflowDefinition)
    expect(definition[0]!.definition_sha256).toBe(
      "e05321d4a4c672bb20e91ffc910b5241b5168357272ac100b5ecf80869997b01",
    )
    if (result._tag !== "Started") throw new Error("Expected started workflow")
    const observations = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly external_observation_json: string }>`
          SELECT external_observation_json FROM workflow_operations WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(JSON.parse(observations[0]!.external_observation_json)).toEqual({
      headRef: result.branchName,
      sha: baseSha,
    })
  })

  test("uses the documented branch format after sanitizing the ticket ID", async () => {
    const filename = await databasePath()
    const ticket = {
      ...ticketReference,
      nativeTicketId: "workflowd..vs3.3",
    }
    const fake = fakes({ ticket: { ...readyTicket, reference: ticket } })

    const result = await startWithOptions(filename, fake, options, {
      repository,
      ticket,
      readinessJudgment: request.readinessJudgment,
    })

    expect(result).toMatchObject({
      _tag: "Started",
      branchName: "feature/workflowd.vs3.3-kick-off-a-qrspi-workflow",
    })
  })

  test("returns NeedsWork and creates zero technical work", async () => {
    const filename = await databasePath()
    const fake = fakes({ ticket: { ...readyTicket, acceptanceCriteria: [] } })

    const result = await start(filename, fake)

    expect(result._tag).toBe("NeedsWork")
    expect(await counts(filename, fake)).toEqual([0, 0, 0])
    expect(fake.counts()).toMatchObject({ createCalls: 0, pullRequestCalls: 0 })
  })

  test("creates no branch or durable technical work for contradictory product direction", async () => {
    const filename = await databasePath()
    const fake = fakes()

    const result = await startWithOptions(filename, fake, options, {
      ...request,
      readinessJudgment: {
        ...request.readinessJudgment,
        userStory: "optional",
        productDirection: "contradictory",
      },
    })

    expect(result._tag).toBe("NeedsWork")
    if (result._tag === "NeedsWork") {
      expect(result.problems.map(({ code }) => code)).toContain("contradictory_product_direction")
    }
    expect(await counts(filename, fake)).toEqual([0, 0, 0])
    expect(fake.counts()).toMatchObject({ createCalls: 0, pullRequestCalls: 0 })
  })

  test("fails an unreadable ticket without repository effects", async () => {
    const filename = await databasePath()
    const fake = fakes({ ticket: { issueType: "feature" } })

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "TicketReadError" })
    expect(await counts(filename, fake)).toEqual([0, 0, 0])
    expect(fake.counts()).toMatchObject({ createCalls: 0, pullRequestCalls: 0 })
  })

  test("makes duplicate kickoff idempotent", async () => {
    const filename = await databasePath()
    const fake = fakes()

    const first = await start(filename, fake)
    const second = await start(filename, fake)

    expect(second).toEqual(first)
    expect(await counts(filename, fake)).toEqual([1, 3, 1])
    expect(fake.counts().createCalls).toBe(1)
  })

  test("re-observes a succeeded duplicate without entering unconsumed reconciliation", async () => {
    const filename = await databasePath()
    const fake = fakes()
    const first = await start(filename, fake)
    fake.setBranch("e".repeat(40))

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartConflict" })

    expect(fake.counts().createCalls).toBe(1)
    fake.setBranch(baseSha)
    await expect(start(filename, fake)).resolves.toEqual(first)
    const reconciliation = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const generations = yield* sql<{ readonly state: string }>`
          SELECT state FROM qrspi_generations WHERE is_current = 1
        `
        const operations = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM workflow_operations
          WHERE kind = 'TargetReconcile' AND is_current = 1
        `
        return { generations, operations }
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(reconciliation.generations).toEqual([{ state: "running" }])
    expect(Number(reconciliation.operations[0]?.count)).toBe(0)
  })

  test("rejects any open pull request for the head before branch mutation", async () => {
    const filename = await databasePath()
    const fake = fakes({ openPullRequest: true })

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartConflict" })

    expect(fake.counts().createCalls).toBe(0)
  })

  test("replaces a retryable terminal start after a temporary open PR closes", async () => {
    const filename = await databasePath()
    const fake = fakes({ openPullRequest: true })
    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartConflict" })
    fake.setOpenPullRequest(false)

    await expect(start(filename, fake)).resolves.toMatchObject({ _tag: "Started", generation: 1 })

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          readonly operation_id: string
          readonly operation_revision: number
          readonly retry_of: string | null
          readonly state: string
          readonly is_current: number
          readonly terminal_failure_reason: string | null
          readonly terminal_retry_policy: string | null
        }>`
          SELECT operation_id, operation_revision, retry_of, state, is_current,
            terminal_failure_reason, terminal_retry_policy
          FROM workflow_operations WHERE kind = 'WorkflowStart'
          ORDER BY operation_revision
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(rows).toHaveLength(2)
    const first = rows[0]!
    const second = rows[1]!
    expect(rows).toEqual([
      {
        operation_id: first.operation_id,
        operation_revision: 1,
        retry_of: null,
        state: "failed",
        is_current: 0,
        terminal_failure_reason: "ticket branch already has an open PR",
        terminal_retry_policy: "retryable",
      },
      {
        operation_id: second.operation_id,
        operation_revision: 2,
        retry_of: first.operation_id,
        state: "succeeded",
        is_current: 1,
        terminal_failure_reason: null,
        terminal_retry_policy: null,
      },
    ])
    expect(await counts(filename, fake)).toEqual([1, 4, 1])
  })

  test("does not enqueue unconsumed reconciliation when an open head PR appears", async () => {
    const filename = await databasePath()
    const fake = fakes()
    await start(filename, fake)
    fake.setOpenPullRequest(true)

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartConflict" })

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly generation_state: string; readonly reconciliations: number }>`
          SELECT g.state AS generation_state,
            (SELECT count(*) FROM workflow_operations o
             WHERE o.kind = 'TargetReconcile' AND o.is_current = 1) AS reconciliations
          FROM qrspi_generations g WHERE g.is_current = 1
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(rows).toEqual([{ generation_state: "running", reconciliations: 0 }])
  })

  test("records unknown accepted create outcome as waiting_external and recovers by observation", async () => {
    const filename = await databasePath()
    const fake = fakes({ unknownAfterAcceptance: true })

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartUncertain" })
    const waiting = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly state: string }>`
          SELECT state FROM workflow_operations WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(waiting).toEqual([{ state: "waiting_external" }])

    const recovered = await start(filename, fake)
    expect(recovered).toMatchObject({ _tag: "Started" })
    expect(fake.counts().createCalls).toBe(1)
  })

  test("times out a repository operation before lease expiry and records uncertainty", async () => {
    const filename = await databasePath()
    const fake = fakes({ createDelayMs: 30, unknownAfterAcceptance: true })
    const timedOptions = {
      ...options,
      repositoryOperationTimeoutMs: 5,
      operationCompletionMarginMs: 5,
      leaseDurationMs: 20,
    }

    await expect(startWithOptions(filename, fake, timedOptions)).rejects.toMatchObject({
      _tag: "WorkflowStartUncertain",
    })
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly state: string }>`
          SELECT state FROM workflow_operations WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(states).toEqual([{ state: "waiting_external" }])
  })

  test("preserves interruption after durably recording an unknown external outcome", async () => {
    const filename = await databasePath()
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => (entered = resolve))
    const fake = fakes({ createNever: true, onCreateEntered: entered })
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          makeWorkflowStart(options)(request).pipe(Effect.provide(layer(filename, fake))),
        )
        yield* Effect.promise(() => enteredPromise)
        return yield* Fiber.interrupt(fiber)
      }),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.isInterruptedOnly(exit.cause)).toBe(true)
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly state: string }>`
          SELECT state FROM workflow_operations WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(states).toEqual([{ state: "waiting_external" }])
  })

  test("recovers the same operation after a crash following branch creation", async () => {
    const filename = await databasePath()
    const fake = fakes({ crashAfterCreate: true })

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartUncertain" })
    expect(await counts(filename, fake)).toEqual([0, 1, 1])

    const recovered = await start(filename, fake)

    expect(recovered).toMatchObject({ _tag: "Started", generation: 1, rootSha: baseSha })
    expect(fake.counts().createCalls).toBe(1)
    expect(await counts(filename, fake)).toEqual([1, 3, 1])
  })

  test("re-leases with new authority after intent-before-create crash before retrying mutation", async () => {
    const filename = await databasePath()
    const fake = fakes({ crashBeforeCreate: true })
    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartUncertain" })

    const recovered = await start(filename, fake)

    expect(recovered).toMatchObject({ _tag: "Started" })
    expect(fake.counts().authorityTokens).toHaveLength(2)
    expect(fake.counts().authorityTokens[0]).not.toBe(fake.counts().authorityTokens[1])
  })

  test("observes an absent waiting_external effect before readying and re-leasing mutation", async () => {
    const filename = await databasePath()
    const fake = fakes({ loseFirstCreatedBranch: true })

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartConflict" })
    const recovered = await start(filename, fake)

    expect(recovered).toMatchObject({ _tag: "Started" })
    expect(fake.counts().createCalls).toBe(2)
    expect(fake.counts().authorityTokens[0]).not.toBe(fake.counts().authorityTokens[1])
  })

  test("moves exhausted external observation budget to waiting_human atomically", async () => {
    const filename = await databasePath()
    const fake = fakes({ crashBeforeCreate: true })
    await expect(start(filename, fake)).rejects.toThrow()
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          UPDATE workflow_operations
          SET state = 'waiting_external', lease_owner = NULL, lease_token = NULL,
              lease_until = NULL, observation_attempts = 0, max_observation_attempts = 1
          WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )

    await expect(start(filename, fake)).rejects.toMatchObject({
      _tag: "WorkflowStartNeedsOperator",
    })
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const operations = yield* sql<{ readonly state: string }>`
          SELECT state FROM workflow_operations WHERE kind = 'WorkflowStart'
        `
        const gates = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM workflow_operation_gates WHERE state = 'pending'
        `
        return { operations, gates }
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(states.operations).toEqual([{ state: "waiting_human" }])
    expect(Number(states.gates[0]?.count)).toBe(1)
  })

  test("cancels a waiting WorkflowStart gate when changed input supersedes it", async () => {
    const filename = await databasePath()
    const fake = fakes({ crashBeforeCreate: true })
    await expect(start(filename, fake)).rejects.toThrow()
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          UPDATE workflow_operations
          SET state = 'waiting_external', lease_owner = NULL, lease_token = NULL,
              lease_until = NULL, observation_attempts = 0, max_observation_attempts = 1
          WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    await expect(start(filename, fake)).rejects.toMatchObject({
      _tag: "WorkflowStartNeedsOperator",
    })
    fake.setTicket({ ...readyTicket, title: "Kick off changed gated input" })

    await expect(start(filename, fake)).resolves.toMatchObject({ _tag: "Started", generation: 1 })

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly state: string }>`
          SELECT state FROM workflow_operation_gates ORDER BY created_at
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(rows).toEqual([{ state: "cancelled" }])
  })

  test("preserves an operator-required wait when an open pull request exists", async () => {
    const filename = await databasePath()
    const fake = fakes({ crashBeforeCreate: true })
    await expect(start(filename, fake)).rejects.toThrow()
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          UPDATE workflow_operations
          SET state = 'waiting_external', lease_owner = NULL, lease_token = NULL,
              lease_until = NULL, observation_attempts = 0, max_observation_attempts = 1
          WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    await expect(start(filename, fake)).rejects.toMatchObject({
      _tag: "WorkflowStartNeedsOperator",
    })
    fake.setOpenPullRequest(true)

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartConflict" })

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly state: string; readonly terminal_retry_policy: string }>`
          SELECT state, terminal_retry_policy FROM workflow_operations WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(rows).toEqual([{ state: "waiting_human", terminal_retry_policy: "operator_required" }])
  })

  test("fails ready work atomically when retry budget is exhausted", async () => {
    const filename = await databasePath()
    const fake = fakes({ crashBeforeCreate: true })
    await expect(start(filename, fake)).rejects.toThrow()
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          UPDATE workflow_operations
          SET state = 'ready', lease_owner = NULL, lease_token = NULL, lease_until = NULL,
              attempt = max_attempts
          WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )

    await expect(start(filename, fake)).rejects.toMatchObject({
      _tag: "WorkflowStartRetryExhausted",
    })
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          readonly state: string
          readonly operation_revision: number
          readonly retry_of: string | null
          readonly terminal_retry_policy: string | null
        }>`
          SELECT state, operation_revision, retry_of, terminal_retry_policy
          FROM workflow_operations WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(states).toEqual([
      {
        state: "failed",
        operation_revision: 1,
        retry_of: null,
        terminal_retry_policy: "retry_budget_exhausted",
      },
    ])
    await expect(start(filename, fake)).rejects.toMatchObject({
      _tag: "WorkflowStartRetryExhausted",
    })
    expect(fake.counts().createCalls).toBe(1)
    expect(await counts(filename, fake)).toEqual([0, 1, 1])
  })

  test("rolls back authoritative observation and all completion effects at a crash boundary", async () => {
    const filename = await databasePath()
    const fake = fakes({ unknownAfterAcceptance: true })
    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartUncertain" })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ readonly operation_id: string; readonly input_json: string }>`
          SELECT operation_id, input_json FROM workflow_operations WHERE kind = 'WorkflowStart'
        `
        const persisted = yield* Schema.decodeUnknown(Schema.parseJson(WorkflowStartInput))(
          rows[0]!.input_json,
        )
        yield* sql`
          CREATE TRIGGER crash_workflow_start_completion
          BEFORE INSERT ON qrspi_generations
          BEGIN
            SELECT RAISE(ABORT, 'simulated completion crash');
          END
        `
        const completion = {
          operationId: rows[0]!.operation_id,
          workflowId: workflowIdFor(repository, ticketReference),
          branchName: persisted.branchName,
          ticketRevisionSha256: persisted.ticketRevisionSha256,
          workflowDefinitionSha256: persisted.workflowDefinitionSha256,
          repositoryJson: JSON.stringify(repository),
          baseRef: persisted.baseRef,
          baseSha: persisted.baseSha,
          rootSha: baseSha,
          authoritativeObservation: { headRef: persisted.branchName, sha: baseSha },
          stageSnapshots: [stageSnapshot()],
          now: options.now(),
        }
        const exit = yield* QrspiStore.pipe(
          Effect.flatMap((store) => store.completeStart(completion)),
          Effect.exit,
        )
        const operations = yield* sql<{
          readonly state: string
          readonly external_observation_json: string
        }>`
          SELECT state, external_observation_json FROM workflow_operations
          WHERE kind = 'WorkflowStart'
        `
        const generations = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM qrspi_generations
        `
        const snapshots = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM qrspi_stage_definitions
        `
        const children = yield* sql<{ readonly count: number }>`
          SELECT count(*) AS count FROM workflow_operations WHERE kind != 'WorkflowStart'
        `
        return { exit, operations, generations, snapshots, children }
      }).pipe(Effect.provide(layer(filename, fake))),
    )

    expect(result.exit._tag).toBe("Failure")
    if (result.exit._tag === "Failure") {
      expect(Cause.pretty(result.exit.cause)).toContain("SqlError")
    }
    expect(result.operations).toEqual([
      {
        state: "waiting_external",
        external_observation_json: JSON.stringify({
          headRef: "feature/workflowd-vs3.3-kick-off-a-qrspi-workflow",
          outcome: "unknown",
        }),
      },
    ])
    expect(Number(result.generations[0]?.count)).toBe(0)
    expect(Number(result.snapshots[0]?.count)).toBe(0)
    expect(Number(result.children[0]?.count)).toBe(0)
  })

  test("recovers an intended branch after a hard crash on the final leased attempt", async () => {
    const filename = await databasePath()
    const fake = fakes({ unknownAfterAcceptance: true })
    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartUncertain" })
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          UPDATE workflow_operations
          SET state = 'leased', attempt = max_attempts, lease_owner = 'crashed-worker',
              lease_token = '11111111-1111-4111-8111-111111111111',
              lease_until = '2020-01-01T00:00:00.000Z'
          WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )

    const recovered = await start(filename, fake)

    expect(recovered).toMatchObject({ _tag: "Started", generation: 1, rootSha: baseSha })
    expect(fake.counts().createCalls).toBe(1)
  })

  test("adopts an accepted branch after a final-attempt crash before intent persistence", async () => {
    const filename = await databasePath()
    const fake = fakes({ unknownAfterAcceptance: true })
    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartUncertain" })
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          UPDATE workflow_operations
          SET state = 'leased', attempt = max_attempts, lease_owner = 'crashed-worker',
              lease_token = '11111111-1111-4111-8111-111111111111',
              lease_until = '2020-01-01T00:00:00.000Z', external_intent_json = NULL
          WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )

    const recovered = await start(filename, fake)

    expect(recovered).toMatchObject({ _tag: "Started", generation: 1, rootSha: baseSha })
    expect(fake.counts().createCalls).toBe(1)
  })

  test("does not let a concurrent duplicate replace an unexpired lease or mutate", async () => {
    const filename = await databasePath()
    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fake = fakes({ createGate: gate, onCreateEntered: entered })
    const first = start(filename, fake)
    await enteredPromise

    try {
      await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartBusy" })
      expect(fake.counts().createCalls).toBe(1)
    } finally {
      release()
    }
    await first
  })

  test("gates a conflicting branch before the first generation", async () => {
    const filename = await databasePath()
    const fake = fakes({ initialBranchSha: "e".repeat(40) })

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartConflict" })
    expect(await counts(filename, fake)).toEqual([0, 1, 1])
    expect(fake.counts().createCalls).toBe(0)
    const recovery = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const operations = yield* sql<{ readonly state: string }>`
          SELECT state FROM workflow_operations WHERE kind = 'WorkflowStart'
        `
        const gates = yield* sql<{ readonly state: string; readonly reason: string }>`
          SELECT state, reason FROM workflow_operation_gates
        `
        return { operations, gates }
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(recovery).toEqual({
      operations: [{ state: "waiting_human" }],
      gates: [{ state: "pending", reason: "branch history is not trusted" }],
    })
  })

  test("supersedes a start when the ticket changes during its final recheck", async () => {
    const filename = await databasePath()
    const fake = fakes()
    const originalCreate = fake.repositories.createBranch
    fake.repositories.createBranch = (input: Parameters<QrspiRepositoryPort["createBranch"]>[0]) =>
      originalCreate(input).pipe(
        Effect.tap(() =>
          Effect.sync(() => fake.setTicket({ ...readyTicket, title: "Changed product title" })),
        ),
      )

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartSuperseded" })
    expect(await counts(filename, fake)).toEqual([0, 1, 1])
  })

  test("recovers waiting external intent after constructing a new service and database layer", async () => {
    const filename = await databasePath()
    const fake = fakes({ crashAfterCreate: true })
    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartUncertain" })

    const restarted = await start(filename, fake)

    expect(restarted).toMatchObject({ _tag: "Started", generation: 1 })
    expect(fake.counts().createCalls).toBe(1)
  })

  test("preserves TicketSource infrastructure failures", async () => {
    const filename = await databasePath()
    const fake = fakes({ ticketError: new Error("bd unavailable") })

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "TicketSourceError" })
  })

  test("inspects repository authorization before persisting workflow identity", async () => {
    const filename = await databasePath()
    const fake = fakes({ inspectError: new Error("repository unavailable") })

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "QrspiRepositoryError" })
    const workflows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly count: number }>`SELECT count(*) AS count FROM qrspi_workflows`
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(Number(workflows[0]?.count)).toBe(0)
  })

  test("rejects a trusted definition that cannot start runnable work", () => {
    expect(() =>
      makeWorkflowStart({
        ...options,
        workflowDefinition: { contractVersion: 1, definitionVersion: 1, stages: [] },
      }),
    ).toThrow(expect.objectContaining({ reason: "no_considered_stage" }))
  })

  test("creates only operations declared by the trusted workflow definition", async () => {
    const filename = await databasePath()
    const fake = fakes()
    await Effect.runPromise(
      makeWorkflowStart({
        ...options,
        workflowDefinition: {
          contractVersion: 1,
          definitionVersion: 1,
          stages: [
            {
              key: "research",
              kind: "document",
              activation: { mode: "enabled" },
              ...trustedStageSemantics,
            },
          ],
        },
      })(request).pipe(Effect.provide(layer(filename, fake))),
    )

    expect(await counts(filename, fake)).toEqual([1, 3, 1])
  })

  test("uses the stage producer retry limit for StageProduce operations", async () => {
    const filename = await databasePath()
    const fake = fakes()
    await startWithOptions(filename, fake, {
      ...options,
      workflowDefinition: {
        ...options.workflowDefinition,
        stages: [
          {
            ...options.workflowDefinition.stages[0],
            producer: {
              ...options.workflowDefinition.stages[0].producer,
              retry: { maxAttempts: 7, backoffMs: 1_000 },
            },
          },
        ],
      },
    })

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly kind: string; readonly max_attempts: number }>`
          SELECT kind, max_attempts FROM workflow_operations
          WHERE kind IN ('StageProduce', 'ArtifactPublish') ORDER BY kind
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(rows).toEqual([
      { kind: "ArtifactPublish", max_attempts: 3 },
      { kind: "StageProduce", max_attempts: 7 },
    ])
  })

  test("returns typed currentness loss instead of dying during completion", async () => {
    const filename = await databasePath()
    const fake = fakes()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* QrspiStore
        return yield* store
          .completeStart({
            operationId: "missing-operation",
            workflowId: "wf_missing",
            branchName: "feature/missing",
            ticketRevisionSha256: "a".repeat(64),
            workflowDefinitionSha256: "b".repeat(64),
            repositoryJson: JSON.stringify(repository),
            baseRef: "main",
            baseSha,
            rootSha: baseSha,
            authoritativeObservation: { headRef: "feature/missing", sha: baseSha },
            stageSnapshots: [stageSnapshot()],
            now: new Date("2026-07-21T05:00:00.000Z"),
          })
          .pipe(Effect.either)
      }).pipe(Effect.provide(layer(filename, fake))),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "WorkflowStartCurrentnessError" },
    })
  })

  test("completeStart rejects supplied target values that differ from persisted input", async () => {
    const filename = await databasePath()
    const fake = fakes({ unknownAfterAcceptance: true })
    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartUncertain" })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{
          readonly operation_id: string
          readonly input_json: string
        }>`SELECT operation_id, input_json FROM workflow_operations WHERE kind = 'WorkflowStart'`
        const persisted = yield* Schema.decodeUnknown(Schema.parseJson(WorkflowStartInput))(
          rows[0]!.input_json,
        )
        const store = yield* QrspiStore
        return yield* store
          .completeStart({
            operationId: rows[0]!.operation_id,
            workflowId: workflowIdFor(repository, ticketReference),
            branchName: persisted.branchName,
            ticketRevisionSha256: persisted.ticketRevisionSha256,
            workflowDefinitionSha256: persisted.workflowDefinitionSha256,
            repositoryJson: JSON.stringify(repository),
            baseRef: "main",
            baseSha: "e".repeat(40),
            rootSha: baseSha,
            authoritativeObservation: { headRef: persisted.branchName, sha: baseSha },
            stageSnapshots: [stageSnapshot()],
            now: options.now(),
          })
          .pipe(Effect.either)
      }).pipe(Effect.provide(layer(filename, fake))),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "WorkflowStartCurrentnessError" },
    })
    expect(await counts(filename, fake)).toEqual([0, 1, 1])
  })

  test("starts a successor generation from an advanced trusted branch head", async () => {
    const filename = await databasePath()
    const fake = fakes()
    await start(filename, fake)
    const advancedSha = "c".repeat(40)
    fake.setBranch(advancedSha)
    fake.setTicket({ ...readyTicket, title: "Kick off the revised QRSPI workflow" })
    fake.setBranchHistoryTrusted(true)

    const successor = await start(filename, fake)

    expect(successor).toMatchObject({ _tag: "Started", generation: 2, rootSha: advancedSha })
    const targets = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly base_sha: string; readonly root_sha: string }>`
          SELECT base_sha, root_sha FROM qrspi_generations ORDER BY generation
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(targets[1]).toEqual({ base_sha: baseSha, root_sha: advancedSha })
  })

  test("rejects an advanced base without entering unconsumed reconciliation", async () => {
    const filename = await databasePath()
    const fake = fakes()
    await start(filename, fake)
    fake.setBase("e".repeat(40))
    fake.setTicket({ ...readyTicket, title: "Kick off after the base advances" })

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartConflict" })

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly generation: number; readonly state: string }>`
          SELECT generation, state FROM qrspi_generations ORDER BY generation
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(rows).toEqual([{ generation: 1, state: "running" }])
  })

  test("starts a successor after the exact target is restored", async () => {
    const filename = await databasePath()
    const fake = fakes()
    await start(filename, fake)
    fake.setBranch("e".repeat(40))
    fake.setBranchHistoryTrusted(false)
    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartConflict" })
    fake.setBranch(baseSha)
    fake.setBranchHistoryTrusted(true)
    fake.setTicket({ ...readyTicket, title: "Kick off after the target is restored" })

    await expect(start(filename, fake)).resolves.toMatchObject({ generation: 2 })

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly generation: number; readonly state: string }>`
          SELECT generation, state FROM qrspi_generations ORDER BY generation
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(rows).toEqual([
      { generation: 1, state: "superseded" },
      { generation: 2, state: "running" },
    ])
  })

  test("supersedes a leased predecessor operation when starting a successor", async () => {
    const filename = await databasePath()
    const fake = fakes()
    await start(filename, fake)
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          UPDATE workflow_operations
          SET state = 'leased', attempt = 1, lease_owner = 'worker-1',
              lease_token = 'lease-1', lease_until = '2026-07-21T05:01:00.000Z'
          WHERE kind = 'StageProduce'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    fake.setBranch("c".repeat(40))
    fake.setTicket({ ...readyTicket, title: "Kick off after leased planning work" })

    await expect(start(filename, fake)).resolves.toMatchObject({ generation: 2 })

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{
          readonly state: string
          readonly lease_owner: string | null
          readonly lease_token: string | null
          readonly lease_until: string | null
        }>`
          SELECT state, lease_owner, lease_token, lease_until
          FROM workflow_operations
          WHERE kind = 'StageProduce'
          ORDER BY created_at
          LIMIT 1
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(rows).toEqual([
      { state: "superseded", lease_owner: null, lease_token: null, lease_until: null },
    ])
  })

  test("cancels a predecessor operation gate when starting a successor", async () => {
    const filename = await databasePath()
    const fake = fakes()
    await start(filename, fake)
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE workflow_operations SET state = 'waiting_human' WHERE kind = 'StageProduce'`
        yield* sql`
          INSERT INTO workflow_operation_gates (operation_id, state, reason, created_at)
          SELECT operation_id, 'pending', 'operator decision required', ${options.now().toISOString()}
          FROM workflow_operations WHERE kind = 'StageProduce'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    fake.setBranch("c".repeat(40))
    fake.setTicket({ ...readyTicket, title: "Kick off after gated planning work" })

    await expect(start(filename, fake)).resolves.toMatchObject({ generation: 2 })

    const gates = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly state: string }>`SELECT state FROM workflow_operation_gates`
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(gates).toEqual([{ state: "cancelled" }])
  })

  for (const terminalState of ["completed", "rejected", "cancelled", "failed"] as const) {
    test(`preserves a ${terminalState} predecessor when starting a successor`, async () => {
      const filename = await databasePath()
      const fake = fakes()
      await start(filename, fake)
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE qrspi_generations SET state = ${terminalState} WHERE generation = 1`
        }).pipe(Effect.provide(layer(filename, fake))),
      )
      fake.setBranch("c".repeat(40))
      fake.setTicket({ ...readyTicket, title: `Kick off after ${terminalState}` })

      await start(filename, fake)

      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{ readonly state: string; readonly is_current: number }>`
            SELECT state, is_current FROM qrspi_generations WHERE generation = 1
          `
        }).pipe(Effect.provide(layer(filename, fake))),
      )
      expect(rows).toEqual([{ state: terminalState, is_current: 0 }])
    })
  }

  test("rejects an advanced branch with unknown history without queueing dead work", async () => {
    const filename = await databasePath()
    const fake = fakes()
    await start(filename, fake)
    fake.setBranch("c".repeat(40))
    fake.setTicket({ ...readyTicket, title: "Kick off the revised QRSPI workflow" })
    fake.setBranchHistoryTrusted(false)

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartConflict" })

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly state: string }>`
          SELECT state FROM qrspi_generations WHERE is_current = 1
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(rows).toEqual([{ state: "running" }])
    expect(await counts(filename, fake)).toEqual([1, 4, 2])
  })

  test("quarantines a corrupt persisted WorkflowStart input as a typed data error", async () => {
    const filename = await databasePath()
    const fake = fakes()
    await start(filename, fake)
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE workflow_operations SET input_json = '{}' WHERE kind = 'WorkflowStart'`
      }).pipe(Effect.provide(layer(filename, fake))),
    )

    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "QrspiStoreDataError" })
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly state: string }>`
          SELECT state FROM workflow_operations WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(states).toEqual([{ state: "data_error" }])
  })

  test("quarantines a poison row encountered while claiming ready work", async () => {
    const filename = await databasePath()
    const fake = fakes({ crashBeforeCreate: true })
    await expect(start(filename, fake)).rejects.toMatchObject({ _tag: "WorkflowStartUncertain" })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          UPDATE workflow_operations
          SET state = 'ready', lease_owner = NULL, lease_token = NULL, lease_until = NULL,
              input_json = '{}'
          WHERE kind = 'WorkflowStart'
        `
        const rows = yield* sql<{ readonly operation_id: string }>`
          SELECT operation_id FROM workflow_operations WHERE kind = 'WorkflowStart'
        `
        const store = yield* QrspiStore
        return yield* store
          .claimStart(rows[0]!.operation_id, crypto.randomUUID(), 100, options.now())
          .pipe(Effect.either)
      }).pipe(Effect.provide(layer(filename, fake))),
    )

    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "QrspiStoreDataError" } })
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly state: string }>`
          SELECT state FROM workflow_operations WHERE kind = 'WorkflowStart'
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(states).toEqual([{ state: "data_error" }])
  })

  test("accepts a renamed repository by immutable identity and persists its provider locator", async () => {
    const filename = await databasePath()
    const requestedRepository = {
      ...repository,
      repositoryFullName: "renamed-owner/example",
    } as const
    const providerRepository = {
      ...repository,
      repositoryFullName: "canonical-owner/example",
    } as const
    const fake = fakes({ inspectedRepository: providerRepository })

    const result = await startWithOptions(filename, fake, options, {
      ...request,
      repository: requestedRepository,
    })

    expect(result).toMatchObject({ _tag: "Started" })
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly repository_json: string }>`
          SELECT repository_json FROM qrspi_generations
        `
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(JSON.parse(rows[0]!.repository_json)).toEqual(providerRepository)
  })

  test("rejects unauthorized, cross-workspace, malformed, and ambiguous ingress before mutation", async () => {
    const filename = await databasePath()
    const fake = fakes()
    const startWorkflow = makeWorkflowStart(options)
    const badRequests: unknown[] = [
      { ...request, repository: { ...repository, repositoryId: "99" } },
      { ...request, ticket: { ...ticketReference, trackerInstanceId: "other" } },
      { repository, ticket: { tracker: "beads" } },
      { ...request, repository: { ...repository, repositoryFullName: "example" } },
    ]

    for (const badRequest of badRequests) {
      await expect(
        Effect.runPromise(startWorkflow(badRequest).pipe(Effect.provide(layer(filename, fake)))),
      ).rejects.toBeDefined()
    }
    expect(fake.counts()).toMatchObject({ createCalls: 0, pullRequestCalls: 0 })
  })
})

describe("Phase 1: Trusted stage snapshots", () => {
  test("persists one immutable snapshot and derives its two child operations", async () => {
    const filename = await databasePath()
    const fake = fakes()

    await start(filename, fake)

    const persisted = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const snapshots = yield* sql`
          SELECT
            stage_definition_sha256,
            workflow_definition_sha256,
            stage_key,
            sequence_position,
            contract_name,
            contract_version,
            contract_registration_sha256,
            harness_name,
            harness_version,
            harness_registration_sha256
          FROM qrspi_stage_definitions
        `
        const children = yield* sql<{
          readonly kind: string
          readonly state: string
          readonly max_attempts: number
          readonly parent_effect_json: string
        }>`
          SELECT kind, state, max_attempts, parent_effect_json
          FROM workflow_operations
          WHERE kind IN ('StageProduce', 'ArtifactPublish')
          ORDER BY CASE kind WHEN 'StageProduce' THEN 1 ELSE 2 END
        `
        return { children, snapshots }
      }).pipe(Effect.provide(layer(filename, fake))),
    )

    expect(persisted.snapshots).toHaveLength(1)
    expect(persisted.snapshots[0]).toMatchObject({
      stage_key: "questions",
      sequence_position: 1,
      contract_name: "qrspi.questions",
      contract_version: 1,
      harness_name: "opencode",
      harness_version: 1,
      stage_definition_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      workflow_definition_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      contract_registration_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      harness_registration_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(
      persisted.children.map((row) => ({
        ...row,
        parent_effect_json: JSON.parse(row.parent_effect_json),
      })),
    ).toEqual([
      {
        kind: "StageProduce",
        state: "ready",
        max_attempts: 3,
        parent_effect_json: { success: "advance parent", failure: "fail Generation" },
      },
      {
        kind: "ArtifactPublish",
        state: "blocked",
        max_attempts: 3,
        parent_effect_json: { success: "advance parent", failure: "fail Generation" },
      },
    ])
  })

  test("validates availability before durable WorkflowStart work", async () => {
    const filename = await databasePath()
    const fake = fakes()
    const selections: Array<unknown> = []
    const result = await Effect.runPromise(
      makeWorkflowStart(options)(request).pipe(
        Effect.provide(
          layer(filename, fake, (input) => {
            selections.push(...input.selections)
            return Effect.fail(
              new AgentHarnessError({
                operation: "validate OpenCode availability",
                cause: new Error("unavailable"),
                retryable: true,
              }),
            )
          }),
        ),
        Effect.either,
      ),
    )
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "WorkflowDefinitionValidationError",
        phase: "availability",
        reason: "unavailable_agent_model",
      },
    })
    expect(selections).toEqual([
      {
        ref: { name: "opencode", version: 1 },
        agent: "qrspi-producer",
        model: "openai/gpt-5.6-sol",
      },
    ])
    const durableCounts = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* Effect.all([
          sql<{ readonly count: number }>`SELECT count(*) AS count FROM qrspi_workflows`,
          sql<{ readonly count: number }>`SELECT count(*) AS count FROM qrspi_ticket_revisions`,
          sql<{ readonly count: number }>`SELECT count(*) AS count FROM qrspi_workflow_definitions`,
          sql<{ readonly count: number }>`SELECT count(*) AS count FROM workflow_operations`,
          sql<{ readonly count: number }>`SELECT count(*) AS count FROM qrspi_generations`,
          sql<{ readonly count: number }>`SELECT count(*) AS count FROM qrspi_stage_definitions`,
        ])
        return rows.map((row) => Number(row[0]?.count ?? 0))
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(durableCounts).toEqual([0, 0, 0, 0, 0, 0])
    expect(fake.counts()).toMatchObject({ createCalls: 0, pullRequestCalls: 0 })
  })
})

describe("Phase 2: Ordered workflow definition validation", () => {
  test("reports the first invalid configured stage before durable or external work", async () => {
    const filename = await databasePath()
    const fake = fakes()
    const invalidFirst = {
      ...options.workflowDefinition.stages[0],
      key: "unknown",
      contract: { name: "qrspi.unknown", contractVersion: 1 },
      activation: { mode: "disabled" as const },
    }
    const validSecond = {
      ...options.workflowDefinition.stages[0],
      key: "questions",
    }
    const result = await Effect.runPromise(
      makeWorkflowStart({
        ...options,
        workflowDefinition: {
          ...options.workflowDefinition,
          stages: [invalidFirst, validSecond],
        },
      })(request).pipe(Effect.provide(layer(filename, fake)), Effect.either),
    )

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "WorkflowDefinitionValidationError",
        phase: "contract",
        reason: "unknown_contract_reference",
        stageKey: "unknown",
        sequencePosition: 1,
        contractRef: invalidFirst.contract,
      },
    })
    expect(fake.counts()).toMatchObject({ createCalls: 0, pullRequestCalls: 0 })
  })

  test("persists every stage in declaration order and deduplicates first-seen availability selections", async () => {
    const filename = await databasePath()
    const fake = fakes()
    const selections: Array<unknown> = []
    const firstStage = {
      ...options.workflowDefinition.stages[0],
      key: "questions",
      activation: { mode: "disabled" as const },
      producer: {
        ...options.workflowDefinition.stages[0].producer,
        agent: "shared-agent",
      },
    }
    const secondStage = {
      ...firstStage,
      key: "research",
      activation: {
        mode: "conditional" as const,
        policy: { name: "qrspi.activation", version: 1 },
        decision: "disabled" as const,
        reason: "Research is not required for this ticket.",
      },
    }
    const thirdStage = {
      ...firstStage,
      key: "plan",
      activation: { mode: "enabled" as const },
      producer: {
        ...firstStage.producer,
        agent: "plan-agent",
        retry: { maxAttempts: 7, backoffMs: 1_000 },
      },
    }
    const fourthStage = {
      ...firstStage,
      key: "implementation",
      activation: { mode: "enabled" as const },
    }
    const multiStageOptions: WorkflowStartOptions = {
      ...options,
      workflowDefinition: {
        ...options.workflowDefinition,
        stages: [firstStage, secondStage, thirdStage, fourthStage],
      },
    }

    await Effect.runPromise(
      makeWorkflowStart(multiStageOptions)(request).pipe(
        Effect.provide(
          layer(filename, fake, (input) => {
            selections.push(...input.selections)
            return Effect.void
          }),
        ),
      ),
    )

    expect(selections).toEqual([
      {
        ref: { name: "opencode", version: 1 },
        agent: "shared-agent",
        model: "openai/gpt-5.6-sol",
      },
      {
        ref: { name: "opencode", version: 1 },
        agent: "plan-agent",
        model: "openai/gpt-5.6-sol",
      },
    ])
    const persisted = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const snapshots = yield* sql<{
          readonly sequence_position: number
          readonly stage_key: string
        }>`
          SELECT sequence_position, stage_key FROM qrspi_stage_definitions
          ORDER BY sequence_position
        `
        const producer = yield* sql<{
          readonly input_json: string
          readonly max_attempts: number
        }>`
          SELECT input_json, max_attempts FROM workflow_operations WHERE kind = 'StageProduce'
        `
        return { producer, snapshots }
      }).pipe(Effect.provide(layer(filename, fake))),
    )
    expect(persisted.snapshots.map((row) => [row.sequence_position, row.stage_key])).toEqual([
      [1, "questions"],
      [2, "research"],
      [3, "plan"],
      [4, "implementation"],
    ])
    expect(persisted.producer).toHaveLength(1)
    expect(JSON.parse(persisted.producer[0]!.input_json)).toMatchObject({ stageKey: "plan" })
    expect(persisted.producer[0]!.max_attempts).toBe(7)
  })
})

describe("Phase 3: Persisted identity preflight", () => {
  test("loads ordered snapshots for current generations after restart", async () => {
    const filename = await databasePath()
    const fake = fakes()
    await start(filename, fake)

    const snapshotSets = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* QrspiStore
        return yield* store.loadCurrentGenerationSnapshotSets()
      }).pipe(Effect.provide(layer(filename, fake))),
    )

    expect(snapshotSets).toEqual([
      expect.objectContaining({
        generation: 1,
        snapshots: [
          expect.objectContaining({
            sequencePosition: 1,
            definition: expect.objectContaining({ key: "questions" }),
          }),
        ],
      }),
    ])
  })

  test("preflights configured and persisted identity on a fresh service", async () => {
    const filename = await databasePath()
    const fake = fakes()
    await start(filename, fake)

    await Effect.runPromise(
      Effect.gen(function* () {
        const workflowStart = yield* WorkflowStart
        yield* workflowStart.preflight
      }).pipe(
        Effect.provide(WorkflowStartLive(options).pipe(Layer.provide(layer(filename, fake)))),
      ),
    )
    expect(fake.counts()).toMatchObject({ createCalls: 1 })
  })

  test("runs enabled QRSPI preflight while constructing the live service", async () => {
    const filename = await databasePath()
    const fake = fakes()
    const selections: Array<unknown> = []
    const dependencies = layer(filename, fake, (input) => {
      selections.push(...input.selections)
      return Effect.void
    })

    await Effect.runPromise(
      Effect.scoped(Layer.build(WorkflowStartLive(options).pipe(Layer.provide(dependencies)))),
    )

    expect(selections).toEqual([
      {
        ref: { name: "opencode", version: 1 },
        agent: "qrspi-producer",
        model: "openai/gpt-5.6-sol",
      },
    ])
  })

  test.each([
    {
      name: "missing snapshot set",
      mutation: "DELETE FROM qrspi_stage_definitions",
      reason: "missing",
    },
    {
      name: "malformed snapshot JSON",
      mutation: "UPDATE qrspi_stage_definitions SET definition_json = '{}'",
      reason: "malformed",
    },
    {
      name: "cross-column contract identity",
      mutation: "UPDATE qrspi_stage_definitions SET contract_name = 'qrspi.changed'",
      reason: "identity_mismatch",
    },
    {
      name: "stage definition hash mismatch",
      mutation:
        "UPDATE qrspi_stage_definitions SET definition_json = json_set(definition_json, '$.definitionVersion', 2)",
      reason: "hash_mismatch",
    },
    {
      name: "reordered sequence",
      mutation: "UPDATE qrspi_stage_definitions SET sequence_position = 2",
      reason: "reordered",
    },
  ])("rejects $name without new work", async ({ mutation, reason }) => {
    const filename = await databasePath()
    const fake = fakes()
    await start(filename, fake)
    const before = await counts(filename, fake)
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(mutation)
      }).pipe(Effect.provide(layer(filename, fake))),
    )

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Layer.build(WorkflowStartLive(options).pipe(Layer.provide(layer(filename, fake)))),
      ),
    )

    expect(Cause.failureOption(exit._tag === "Failure" ? exit.cause : Cause.empty)).toMatchObject({
      _tag: "Some",
      value: { _tag: "QrspiStoreDataError", reason },
    })
    expect(await counts(filename, fake)).toEqual(before)
    expect(fake.counts()).toMatchObject({ createCalls: 1 })
  })
})
