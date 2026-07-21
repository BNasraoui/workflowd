import { Context, Effect, Schema } from "effect"
import type {
  AgentExecutionContext,
  AgentHarnessDefinition,
  AgentHarnessPort,
  AgentHarnessRef,
  AgentLaunchIntent,
  SessionReference,
} from "../agent-harness"
import { MAX_AGENT_OUTPUT_BYTES, boundedAgentPayload } from "../agent-payload"
import {
  ReadyTicket,
  StageContractRef,
  normalizeWorkflowDefinition,
  type StageDefinition,
  type WorkflowDefinition,
} from "./domain"

const Sha256 = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/))
const GitSha = Schema.String.pipe(Schema.pattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const PositiveInt = Schema.Int.pipe(Schema.positive())
const RelativeArtifactPath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(512),
  Schema.filter((path) => {
    const segments = path.split("/")
    return path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      segments.some(
        (part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git",
      )
      ? "Artifact path must be repository-relative and cannot traverse parents or Git internals"
      : true
  }),
)

export const ArtifactReference = Schema.Struct({
  repository: Schema.Struct({
    providerInstanceId: Schema.NonEmptyString,
    repositoryId: Schema.NonEmptyString,
    repositoryFullName: Schema.NonEmptyString,
  }),
  workflowId: Schema.NonEmptyString,
  generation: Schema.Int.pipe(Schema.positive()),
  stageKey: Schema.NonEmptyString,
  stageRevision: Schema.Int.pipe(Schema.positive()),
  commitSha: GitSha,
  path: RelativeArtifactPath,
  blobSha: GitSha,
  contentSha256: Sha256,
  mediaType: Schema.NonEmptyString,
})
export type ArtifactReference = typeof ArtifactReference.Type

export const StageContractInput = Schema.Struct({
  ticketRevisionSha256: Sha256,
  readyTicket: ReadyTicket,
  sources: Schema.Array(ArtifactReference).pipe(Schema.maxItems(32)),
  stepPosition: Schema.optional(PositiveInt),
  implementationCommits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        position: PositiveInt,
        commitSha: GitSha,
        parentSha: GitSha,
        changedPaths: Schema.Array(RelativeArtifactPath).pipe(Schema.maxItems(10_000)),
        operationId: Schema.NonEmptyString,
      }),
    ).pipe(Schema.maxItems(1_000)),
  ),
  predecessorSessionReferenceId: Schema.optional(Schema.NonEmptyString),
  feedback: Schema.optional(
    Schema.Array(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_000))).pipe(
      Schema.maxItems(20),
    ),
  ),
})
export type StageContractInput = typeof StageContractInput.Type

export const DocumentStageResult = Schema.Struct({
  candidateSha: GitSha,
  content: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_048_576)),
  summary: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4_000)),
}).pipe(
  Schema.filter((value) =>
    Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_AGENT_OUTPUT_BYTES
      ? true
      : `Document stage result exceeds ${MAX_AGENT_OUTPUT_BYTES} encoded UTF-8 bytes`,
  ),
)

export const PreparedDeliveryEvidence = Schema.Struct({
  summary: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(20_000)),
  scenarios: Schema.Array(
    Schema.Struct({
      scenario: Schema.Int.pipe(Schema.nonNegative()),
      evidence: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(8_000)),
    }),
  ).pipe(Schema.minItems(1), Schema.maxItems(100)),
})

export const ImplementationStageResult = Schema.Struct({
  candidateSha: GitSha,
  changedPaths: Schema.Array(RelativeArtifactPath).pipe(Schema.maxItems(6_000)),
  final: Schema.Boolean,
  deliveryEvidence: Schema.optional(PreparedDeliveryEvidence),
}).pipe(
  Schema.filter((value) =>
    Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_AGENT_OUTPUT_BYTES
      ? true
      : `Implementation stage result exceeds ${MAX_AGENT_OUTPUT_BYTES} encoded UTF-8 bytes`,
  ),
)

export const StageRunState = Schema.Literal(
  "blocked",
  "active",
  "waiting_review",
  "waiting_human",
  "waiting_ticket",
  "succeeded",
  "skipped",
  "rejected",
  "failed",
  "cancelled",
  "superseded",
  "data_error",
)
export const StageRevisionState = Schema.Literal(
  "producing",
  "publishing",
  "reviewing",
  "waiting_human",
  "accepted",
  "abandoned",
  "failed",
  "superseded",
)

export const StageRun = Schema.Struct({
  workflowId: Schema.NonEmptyString,
  generation: PositiveInt,
  stageKey: Schema.NonEmptyString,
  stagePosition: Schema.Int.pipe(Schema.nonNegative()),
  state: StageRunState,
  publishedRevision: Schema.optional(PositiveInt),
  pendingRevision: Schema.optional(PositiveInt),
  acceptedRevision: Schema.optional(PositiveInt),
  skipReason: Schema.optional(Schema.NonEmptyString),
})
export type StageRun = typeof StageRun.Type

const RevisionBase = {
  workflowId: Schema.NonEmptyString,
  generation: PositiveInt,
  stageKey: Schema.NonEmptyString,
  revision: PositiveInt,
  sources: Schema.Array(ArtifactReference).pipe(Schema.maxItems(32)),
  state: StageRevisionState,
}

export const DocumentStageRevision = Schema.TaggedStruct("DocumentStageRevision", {
  ...RevisionBase,
  produceOperationId: Schema.NonEmptyString,
  publishOperationId: Schema.NonEmptyString,
  preparedResult: Schema.optional(DocumentStageResult),
  artifact: Schema.optional(ArtifactReference),
  reviewRoundId: Schema.optional(Schema.NonEmptyString),
})

export const ImplementationCommitReference = Schema.Struct({
  position: PositiveInt,
  commitSha: GitSha,
  parentSha: GitSha,
  changedPaths: Schema.Array(RelativeArtifactPath).pipe(Schema.maxItems(10_000)),
  operationId: Schema.NonEmptyString,
})
export const ImplementationCheckpointReference = Schema.Struct({
  repository: ArtifactReference.fields.repository,
  workflowId: Schema.NonEmptyString,
  generation: PositiveInt,
  stageKey: Schema.NonEmptyString,
  stageRevision: PositiveInt,
  checkpointId: Schema.NonEmptyString,
  baseSha: GitSha,
  finalSha: GitSha,
  commits: Schema.Array(ImplementationCommitReference).pipe(Schema.minItems(1)),
  changedPaths: Schema.Array(RelativeArtifactPath).pipe(Schema.maxItems(10_000)),
  preparedDeliveryEvidenceSha256: Sha256,
})
export type ImplementationCheckpointReference = typeof ImplementationCheckpointReference.Type

export const ImplementationStep = Schema.Struct({
  position: PositiveInt,
  produceOperationId: Schema.NonEmptyString,
  publishOperationId: Schema.NonEmptyString,
  sessionReferenceIds: Schema.Array(Schema.NonEmptyString).pipe(Schema.maxItems(20)),
  preparedResult: Schema.optional(ImplementationStageResult),
  commit: Schema.optional(ImplementationCommitReference),
})
export const ImplementationStageRevision = Schema.TaggedStruct("ImplementationStageRevision", {
  ...RevisionBase,
  steps: Schema.Array(ImplementationStep).pipe(Schema.maxItems(1_000)),
  preparedDeliveryEvidence: Schema.optional(PreparedDeliveryEvidence),
  checkpoint: Schema.optional(ImplementationCheckpointReference),
  reviewRoundId: Schema.optional(Schema.NonEmptyString),
})
export const StageRevision = Schema.Union(DocumentStageRevision, ImplementationStageRevision)
export type StageRevision = typeof StageRevision.Type

const MAX_QRSPI_TASK_ENCODED_BYTES = 192 * 1024

const QrspiHarnessInput = Schema.Struct({
  contract: StageContractRef,
  task: Schema.String.pipe(
    Schema.minLength(1),
    Schema.filter((task) =>
      Buffer.byteLength(JSON.stringify(task), "utf8") <= MAX_QRSPI_TASK_ENCODED_BYTES
        ? true
        : `Stage task exceeds ${MAX_QRSPI_TASK_ENCODED_BYTES} encoded UTF-8 bytes`,
    ),
  ),
  input: Schema.Unknown,
  expectedArtifact: Schema.optional(
    Schema.Struct({
      path: RelativeArtifactPath,
      mediaType: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
    }),
  ),
})
type QrspiHarnessDefinition<Result, ResultEncoded> = AgentHarnessDefinition<
  typeof QrspiHarnessInput.Type,
  typeof QrspiHarnessInput.Encoded,
  Result,
  ResultEncoded
>
type DocumentQrspiHarnessDefinition = QrspiHarnessDefinition<
  typeof DocumentStageResult.Type,
  typeof DocumentStageResult.Encoded
>
type ImplementationQrspiHarnessDefinition = QrspiHarnessDefinition<
  typeof ImplementationStageResult.Type,
  typeof ImplementationStageResult.Encoded
>

const QRSPI_HARNESS_WRAPPER_BYTES = 208 * 1024

export function makeQrspiHarnessDefinitions(config: {
  readonly agent: string
  readonly model: string
  readonly timeoutMs: number
  readonly harnessId?: string
  readonly harnessVersion?: number
  readonly kind?: "document" | "implementation"
  readonly maxInputBytes?: number
  readonly maxAttempts?: number
}): {
  readonly document: DocumentQrspiHarnessDefinition
  readonly implementation: ImplementationQrspiHarnessDefinition
} {
  const definition = <Result, ResultEncoded>(
    kind: "document" | "implementation",
    name: "qrspi.document" | "qrspi.implementation",
    outputSchema: Schema.Schema<Result, ResultEncoded, never>,
  ): QrspiHarnessDefinition<Result, ResultEncoded> => ({
    ref:
      config.kind === kind && config.harnessId !== undefined
        ? { name: config.harnessId, version: config.harnessVersion ?? 1 }
        : { name, version: 1 },
    agent: config.agent,
    model: config.model,
    inputSchema: QrspiHarnessInput,
    outputSchema,
    maxInputBytes: (config.maxInputBytes ?? 64 * 1024) + QRSPI_HARNESS_WRAPPER_BYTES,
    maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
    promptContract: `${name}-stage-contract`,
    title: (input) => `QRSPI ${input.contract.name}`,
    prompt: (input) =>
      input.expectedArtifact === undefined
        ? input.task
        : `${input.task}\n\nWrite the artifact at exactly ${input.expectedArtifact.path} with media type ${input.expectedArtifact.mediaType}. Do not change any other path.`,
    timeoutMs: config.timeoutMs,
    retryPolicy: {
      maxAttempts: config.maxAttempts ?? 3,
      structuredOutputRetryCount: 2,
      invalidOutput: "retry",
    },
  })
  return {
    document: definition("document", "qrspi.document", DocumentStageResult),
    implementation: definition("implementation", "qrspi.implementation", ImplementationStageResult),
  }
}

export function makeQrspiHarnessDefinitionsForStage(stage: StageDefinition) {
  return makeQrspiHarnessDefinitions({
    agent: stage.producer.agent,
    model: stage.producer.model,
    timeoutMs: stage.producer.timeoutMs,
    harnessId: stage.producer.harnessId,
    harnessVersion: stage.producer.harnessVersion,
    kind: stage.kind,
    maxInputBytes: stage.inputContract.maxEncodedBytes,
    maxAttempts: stage.producer.retry.maxAttempts,
  })
}

export function qrspiHarnessDefinitionsForWorkflows(
  definitions: ReadonlyArray<WorkflowDefinition>,
): ReadonlyArray<DocumentQrspiHarnessDefinition | ImplementationQrspiHarnessDefinition> {
  return definitions.flatMap((definition) =>
    definition.stages
      .filter((stage) => stage.activation.mode !== "disabled")
      .map((stage) => {
        const variants = makeQrspiHarnessDefinitionsForStage(stage)
        return stage.kind === "document" ? variants.document : variants.implementation
      }),
  )
}

export type StageContract<Input, InputEncoded, Result, ResultEncoded> = {
  readonly ref: typeof StageContractRef.Type
  readonly kind: "document" | "implementation"
  readonly inputSchema: Schema.Schema<Input, InputEncoded, never>
  readonly resultSchema: Schema.Schema<Result, ResultEncoded, never>
  readonly task: (input: Input) => string
}

type StageContractRegistration = {
  readonly ref: typeof StageContractRef.Type
}

type RuntimeStageContract = {
  readonly ref: typeof StageContractRef.Type
  readonly kind: "document" | "implementation"
  readonly inputSchema: Schema.Schema<unknown, unknown, never>
  readonly resultSchema: Schema.Schema<unknown, unknown, never>
  readonly task: (input: unknown) => string
}

export type ResolvedStageContract = {
  readonly ref: typeof StageContractRef.Type
  readonly kind: "document" | "implementation"
  readonly decodeInput: (input: unknown) => unknown
  readonly decodeResult: (result: unknown) => unknown
  readonly task: (input: unknown) => string
}

const referenceKey = (ref: typeof StageContractRef.Type) => `${ref.name}@${ref.contractVersion}`
const isStageTask = (value: unknown): value is (input: unknown) => unknown =>
  typeof value === "function"

export class StageCatalog {
  readonly contracts: ReadonlyArray<StageContractRegistration>
  readonly #contracts = new Map<string, RuntimeStageContract>()

  constructor(contracts: ReadonlyArray<StageContractRegistration>) {
    for (const source of contracts) {
      const ref = Schema.decodeUnknownSync(StageContractRef)(source.ref)
      if (!("kind" in source) || (source.kind !== "document" && source.kind !== "implementation")) {
        throw new Error(`Invalid StageContract ${referenceKey(ref)}`)
      }
      if (!("inputSchema" in source) || !Schema.isSchema(source.inputSchema)) {
        throw new Error(`Invalid StageContract ${referenceKey(ref)}`)
      }
      if (!("resultSchema" in source) || !Schema.isSchema(source.resultSchema)) {
        throw new Error(`Invalid StageContract ${referenceKey(ref)}`)
      }
      const candidateTask: unknown = "task" in source ? source.task : undefined
      if (!isStageTask(candidateTask)) {
        throw new Error(`Invalid StageContract ${referenceKey(ref)}`)
      }
      const key = referenceKey(ref)
      if (this.#contracts.has(key)) throw new Error(`Duplicate StageContract reference ${key}`)
      this.#contracts.set(key, {
        ref,
        kind: source.kind,
        inputSchema: Schema.typeSchema(source.inputSchema),
        resultSchema: Schema.typeSchema(source.resultSchema),
        task: (input) => {
          const output = candidateTask(input)
          if (typeof output !== "string") throw new Error(`Invalid StageContract task ${key}`)
          return output
        },
      })
    }
    this.contracts = contracts
  }

  resolve(ref: typeof StageContractRef.Type): ResolvedStageContract {
    const decoded = Schema.decodeUnknownSync(StageContractRef)(ref)
    const contract = this.#contracts.get(referenceKey(decoded))
    if (contract === undefined) {
      throw new Error(`Unknown StageContract reference ${referenceKey(decoded)}`)
    }
    return {
      ref: contract.ref,
      kind: contract.kind,
      decodeInput: Schema.decodeUnknownSync(contract.inputSchema),
      decodeResult: Schema.decodeUnknownSync(contract.resultSchema),
      task: contract.task,
    }
  }
}

export const StageCatalogService = Context.GenericTag<StageCatalog>("workflowd/qrspi/StageCatalog")

const documentContract = (name: string, purpose: string) =>
  ({
    ref: { name, contractVersion: 1 },
    kind: "document",
    inputSchema: StageContractInput,
    resultSchema: DocumentStageResult,
    task: (input: StageContractInput) =>
      `${name}: ${purpose}. The Ticket revision ${input.ticketRevisionSha256} is product authority. ` +
      `Use only the ${input.sources.length} accepted technical source artifact(s); later technical detail may refine, but never override, the Ticket.\n\n` +
      `Authoritative ReadyTicket:\n${JSON.stringify(input.readyTicket, null, 2)}`,
  }) satisfies StageContract<
    StageContractInput,
    typeof StageContractInput.Encoded,
    typeof DocumentStageResult.Type,
    typeof DocumentStageResult.Encoded
  >

export const QuestionsStageContract = documentContract(
  "Questions",
  "identify concrete unanswered questions without inventing requirements",
)
export const ResearchStageContract = documentContract(
  "Research",
  "answer accepted questions with cited technical evidence",
)
export const DesignStageContract = documentContract(
  "Design",
  "describe a design that satisfies the Ticket and accepted research",
)
export const StructureStageContract = documentContract(
  "Structure",
  "map the accepted design onto the repository structure",
)
export const PlanStageContract = documentContract(
  "Plan",
  "produce an executable test-first implementation plan",
)
export const ImplementationStageContract = {
  ref: { name: "Implementation", contractVersion: 1 },
  kind: "implementation",
  inputSchema: StageContractInput,
  resultSchema: ImplementationStageResult,
  task: (input: StageContractInput) =>
    `Implementation: implement the Ticket revision ${input.ticketRevisionSha256} using only accepted source artifacts, ` +
    "publish one exact-parent signed commit per step, and provide scenario-linked delivery evidence on the final step.\n\n" +
    `Authoritative ReadyTicket:\n${JSON.stringify(input.readyTicket, null, 2)}`,
} satisfies StageContract<
  StageContractInput,
  typeof StageContractInput.Encoded,
  typeof ImplementationStageResult.Type,
  typeof ImplementationStageResult.Encoded
>

export const BuiltInStageContracts = [
  QuestionsStageContract,
  ResearchStageContract,
  DesignStageContract,
  StructureStageContract,
  PlanStageContract,
  ImplementationStageContract,
] as const

function runQrspiHarness<Result, ResultEncoded>(input: {
  readonly harness: AgentHarnessPort
  readonly definition: QrspiHarnessDefinition<Result, ResultEncoded>
  readonly harnessInput: typeof QrspiHarnessInput.Encoded
  readonly context: AgentExecutionContext
  readonly onLaunchIntent?: (
    launchIntent: AgentLaunchIntent<unknown>,
  ) => Effect.Effect<"recorded" | "stale", Error>
  readonly onSessionCreated?: (
    reference: SessionReference,
  ) => Effect.Effect<"recorded" | "stale", Error>
}) {
  return Effect.gen(function* () {
    const prepared = yield* input.harness.prepare(
      input.definition,
      input.harnessInput,
      input.context,
    )
    if (input.onLaunchIntent !== undefined) {
      const recorded = yield* input.onLaunchIntent(prepared.launchIntent)
      if (recorded === "stale") {
        return yield* Effect.fail(new Error("Stage launch intent lost durable fencing authority"))
      }
    }
    const sessionReference = yield* input.harness.createSession(prepared)
    if (input.onSessionCreated !== undefined) {
      const recorded = yield* input.onSessionCreated(sessionReference)
      if (recorded === "stale") {
        yield* input.harness.abortSession(sessionReference)
        return yield* Effect.fail(new Error("Stage session lost durable fencing authority"))
      }
    }
    const result = yield* input.harness.resumeSession(prepared, sessionReference)
    return { result, sessionReference }
  })
}

export function runStageContract(input: {
  readonly catalog: StageCatalog
  readonly harness: AgentHarnessPort
  readonly harnessDefinitions: {
    readonly document: DocumentQrspiHarnessDefinition
    readonly implementation: ImplementationQrspiHarnessDefinition
  }
  readonly stage: StageDefinition
  readonly ticketId: string
  readonly input: unknown
  readonly context: AgentExecutionContext
  readonly onLaunchIntent?: (
    launchIntent: AgentLaunchIntent<unknown>,
  ) => Effect.Effect<"recorded" | "stale", Error>
  readonly onSessionCreated?: (
    reference: SessionReference,
  ) => Effect.Effect<"recorded" | "stale", Error>
}) {
  return Effect.gen(function* () {
    const contractRef = input.stage.contract ?? {
      name: builtInContractName(input.stage.key),
      contractVersion: input.stage.inputContract.schemaVersion,
    }
    const contract = input.catalog.resolve(contractRef)
    if (contract.kind !== input.stage.kind) {
      return yield* Effect.die(
        new Error(
          `Incompatible StageContract ${referenceKey(contractRef)} for ${input.stage.kind}`,
        ),
      )
    }
    const encodedInput = yield* Schema.decodeUnknown(
      boundedAgentPayload(input.stage.inputContract.maxEncodedBytes, "Stage contract input"),
    )(input.input)
    const decodedInput = contract.decodeInput(encodedInput)
    const definition =
      contract.kind === "document"
        ? input.harnessDefinitions.document
        : input.harnessDefinitions.implementation
    if (
      definition.ref.name !== input.stage.producer.harnessId ||
      definition.ref.version !== input.stage.producer.harnessVersion ||
      definition.agent !== input.stage.producer.agent ||
      definition.model !== input.stage.producer.model
    ) {
      return yield* Effect.die(new Error(`Untrusted harness policy for stage ${input.stage.key}`))
    }
    const expectedArtifact = resolveArtifactDestination(input.stage, input.ticketId)
    const harnessInput = {
      contract: contract.ref,
      task: contract.task(decodedInput),
      input: decodedInput,
      ...(expectedArtifact === undefined ? {} : { expectedArtifact }),
    }
    const execution =
      contract.kind === "document"
        ? yield* runQrspiHarness({
            ...input,
            definition: input.harnessDefinitions.document,
            harnessInput,
          })
        : yield* runQrspiHarness({
            ...input,
            definition: input.harnessDefinitions.implementation,
            harnessInput,
          })
    const result = contract.decodeResult(execution.result)
    return { result, sessionReference: execution.sessionReference }
  })
}

export function resolveArtifactDestination(
  stage: StageDefinition,
  ticketId: string,
): { readonly path: string; readonly mediaType: string } | undefined {
  if (stage.outputContract._tag !== "Artifact") return undefined
  return {
    path: Schema.decodeUnknownSync(RelativeArtifactPath)(
      stage.outputContract.pathTemplate
        .replaceAll("{ticketId}", ticketId)
        .replaceAll("{stageKey}", stage.key),
    ),
    mediaType: stage.outputContract.mediaType,
  }
}

const initialOperations = [
  {
    kind: "StageProduce" as const,
    state: "ready" as const,
    parentEffect: { success: "advance parent" as const, failure: "fail Generation" as const },
  },
  {
    kind: "ArtifactPublish" as const,
    state: "blocked" as const,
    parentEffect: { success: "advance parent" as const, failure: "fail Generation" as const },
  },
]

function stageDefinition(
  key: string,
  contract: (typeof BuiltInStageContracts)[number],
  position: number,
): StageDefinition {
  const document = contract.kind === "document"
  return {
    key,
    kind: contract.kind,
    contract: contract.ref,
    activation: { mode: "enabled" },
    definitionVersion: 1,
    inputContract: {
      schemaId: `qrspi.${key}.input`,
      schemaVersion: 1,
      maxEncodedBytes: 48 * 1024,
    },
    producer: {
      harnessId: document ? "qrspi.document" : "qrspi.implementation",
      harnessVersion: 1,
      agent: "qrspi-producer",
      model: "openai/gpt-5.6-sol",
      timeoutMs: 3_600_000,
      retry: { maxAttempts: 3, backoffMs: 1_000 },
    },
    outputContract: document
      ? {
          _tag: "Artifact",
          pathTemplate: `docs/qrspi/{ticketId}/${String(position).padStart(2, "0")}-${key}.md`,
          mediaType: "text/markdown",
        }
      : { _tag: "ImplementationCheckpoint", contractId: "qrspi.checkpoint", contractVersion: 1 },
    reviewPolicy: { mode: "none" },
    humanGatePolicy: { mode: "none" },
    initialOperations,
  }
}

export const defaultQrspiWorkflowDefinition: WorkflowDefinition = {
  contractVersion: 1,
  definitionVersion: 1,
  stages: [
    stageDefinition("questions", QuestionsStageContract, 1),
    stageDefinition("research", ResearchStageContract, 2),
    stageDefinition("design", DesignStageContract, 3),
    stageDefinition("structure", StructureStageContract, 4),
    stageDefinition("plan", PlanStageContract, 5),
    stageDefinition("implementation", ImplementationStageContract, 6),
  ],
}

export type StageExecutionPlanEntry = {
  readonly stage: StageDefinition
  readonly contract: ResolvedStageContract
  readonly initialState: "blocked" | "active" | "skipped"
  readonly skipReason?: string
}

export function validateWorkflowDefinition(
  input: unknown,
  catalog: StageCatalog,
  availableHarnesses: ReadonlyArray<
    | AgentHarnessRef
    | Pick<
        DocumentQrspiHarnessDefinition | ImplementationQrspiHarnessDefinition,
        "ref" | "agent" | "model" | "timeoutMs" | "maxInputBytes"
      >
  >,
): {
  readonly definition: WorkflowDefinition
  readonly executionPlan: ReadonlyArray<StageExecutionPlanEntry>
} {
  const definition = normalizeWorkflowDefinition(input)
  const harnesses = new Map<string, Array<(typeof availableHarnesses)[number]>>()
  for (const candidate of availableHarnesses) {
    const ref = "ref" in candidate ? candidate.ref : candidate
    const key = `${ref.name}@${ref.version}`
    harnesses.set(key, [...(harnesses.get(key) ?? []), candidate])
  }
  const executionPlan: Array<StageExecutionPlanEntry> = []
  for (const stage of definition.stages) {
    if (stage.activation.mode === "disabled") continue
    const ref = stage.contract ?? {
      name: builtInContractName(stage.key),
      contractVersion: stage.inputContract.schemaVersion,
    }
    const contract = catalog.resolve(ref)
    if (contract.kind !== stage.kind) {
      throw new Error(`Incompatible StageContract ${referenceKey(ref)} for ${stage.kind} stage`)
    }
    if (stage.inputContract.maxEncodedBytes > 1_048_576) {
      throw new Error(`Stage input bound exceeds durable envelope: ${stage.key}`)
    }
    const harnessKey = `${stage.producer.harnessId}@${stage.producer.harnessVersion}`
    const candidates = harnesses.get(harnessKey)
    if (candidates === undefined) throw new Error(`Unknown AgentHarness reference ${harnessKey}`)
    const harness = candidates.find(
      (candidate) =>
        !("ref" in candidate) ||
        (candidate.agent === stage.producer.agent &&
          candidate.model === stage.producer.model &&
          candidate.timeoutMs === stage.producer.timeoutMs &&
          stage.inputContract.maxEncodedBytes <= candidate.maxInputBytes),
    )
    if (harness === undefined) {
      throw new Error(`Untrusted harness policy for stage ${stage.key}`)
    }
    if (
      (stage.kind === "document" && stage.outputContract._tag !== "Artifact") ||
      (stage.kind === "implementation" && stage.outputContract._tag !== "ImplementationCheckpoint")
    ) {
      throw new Error(`Incompatible output contract for ${stage.kind} stage ${stage.key}`)
    }
    const skipped =
      stage.activation.mode === "conditional" && stage.activation.decision === "disabled"
    executionPlan.push({
      stage,
      contract,
      initialState: skipped
        ? "skipped"
        : executionPlan.some((entry) => entry.initialState !== "skipped")
          ? "blocked"
          : "active",
      ...(skipped
        ? {
            skipReason: `${stage.activation.policyId}@${stage.activation.policyVersion} disabled the stage`,
          }
        : {}),
    })
  }
  return { definition, executionPlan }
}

function builtInContractName(key: string): string {
  const name = `${key.slice(0, 1).toUpperCase()}${key.slice(1)}`
  if (!BuiltInStageContracts.some((contract) => contract.ref.name === name)) {
    throw new Error(`Stage ${key} must declare a StageContract reference`)
  }
  return name
}
