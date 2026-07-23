import { Context, Data, Effect, JSONSchema, Schema } from "effect"
import {
  MAX_AGENT_LAUNCH_INTENT_BYTES,
  MAX_AGENT_OUTPUT_BYTES,
  type AgentHarnessPort,
} from "../agent-harness"
import {
  ExecutableStageSnapshot,
  StageContractRef,
  type StageDefinition,
  type WorkflowDefinition,
  WorkflowDefinitionValidationError,
  normalizeWorkflowDefinition,
  stageDefinitionSha256,
  workflowDefinitionSha256,
} from "./domain"
import { canonicalSha256 } from "./domain"

export type ExactStageSources = Readonly<Record<string, unknown>>
export type StageExecutionContext = Readonly<Record<string, unknown>>
export type PreparedDocumentOutput = { readonly _tag: "Document"; readonly text: string }
export type PreparedImplementationStepOutput = {
  readonly _tag: "ImplementationStep"
  readonly value: unknown
}
export type AgentTask<Result, ResultEncoded> = {
  readonly title: string
  readonly prompt: string
  readonly resultSchema: Schema.Schema<Result, ResultEncoded, never>
}

export type StageContract<Request, RequestEncoded, Result, ResultEncoded> = {
  readonly ref: StageContractRef
  readonly implementationRevision: string
  readonly kind: StageDefinition["kind"]
  readonly requestSchema: Schema.Schema<Request, RequestEncoded, never>
  readonly resultSchema: Schema.Schema<Result, ResultEncoded, never>
  readonly maxRequestBytes: number
  readonly maxResultBytes: number
  readonly compatibility: (definition: StageDefinition) => void
  readonly assembleRequest: (sources: ExactStageSources) => RequestEncoded
  readonly buildTask: (request: Request) => AgentTask<Result, ResultEncoded>
  readonly prepareOutput: (
    result: Result,
    context: StageExecutionContext,
  ) => PreparedDocumentOutput | PreparedImplementationStepOutput
}

type StageContractRegistration = {
  readonly ref: StageContractRef
  readonly implementationRevision?: unknown
  readonly kind?: unknown
  readonly requestSchema?: unknown
  readonly resultSchema?: unknown
  readonly maxRequestBytes?: unknown
  readonly maxResultBytes?: unknown
  readonly compatibility?: (definition: StageDefinition) => void
}

export type StageContractDescriptor = {
  readonly ref: StageContractRef
  readonly kind: StageDefinition["kind"]
  readonly maxRequestBytes: number
  readonly maxResultBytes: number
  readonly registrationSha256: string
}

export class StageCatalogError extends Data.TaggedError("StageCatalogError")<{
  readonly reason:
    | "malformed_registration"
    | "duplicate_reference"
    | "unknown_reference"
    | "untrusted_source"
    | "incompatible_definition"
  readonly reference: string
  readonly cause?: string
}> {}

type RuntimeRegistration = {
  readonly source: StageContractRegistration
  readonly descriptor: StageContractDescriptor
  readonly requestSchema: Schema.Schema.Any
  readonly resultSchema: Schema.Schema.Any
  readonly compatibility: (definition: StageDefinition) => void
}

const RegistrationMetadata = Schema.Struct({
  ref: StageContractRef,
  implementationRevision: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  kind: Schema.Literal("document", "implementation"),
  maxRequestBytes: Schema.Int.pipe(Schema.positive()),
  maxResultBytes: Schema.Int.pipe(Schema.positive()),
})

const referenceKey = (ref: StageContractRef) => `${ref.name}@${ref.contractVersion}`

export class TrustedStageCatalog {
  readonly #byReference = new Map<string, RuntimeRegistration>()

  constructor(registrations: ReadonlyArray<StageContractRegistration>) {
    for (const source of registrations) {
      let metadata: typeof RegistrationMetadata.Type
      let requestSchema: Schema.Schema.Any
      let resultSchema: Schema.Schema.Any
      let compatibility: (definition: StageDefinition) => void
      let requestJsonSchema: object
      let resultJsonSchema: object
      try {
        metadata = Schema.decodeUnknownSync(RegistrationMetadata)(source)
        if (!Schema.isSchema(source.requestSchema) || !Schema.isSchema(source.resultSchema)) {
          throw new Error("requestSchema and resultSchema must be Effect Schemas")
        }
        if (typeof source.compatibility !== "function") {
          throw new Error("compatibility must be a function")
        }
        requestSchema = source.requestSchema
        resultSchema = source.resultSchema
        compatibility = source.compatibility
        requestJsonSchema = JSONSchema.make(requestSchema)
        resultJsonSchema = JSONSchema.make(resultSchema)
        if (
          metadata.maxRequestBytes > MAX_AGENT_LAUNCH_INTENT_BYTES ||
          metadata.maxResultBytes > MAX_AGENT_OUTPUT_BYTES
        ) {
          throw new Error("declared limit exceeds durable envelope")
        }
      } catch (cause) {
        throw new StageCatalogError({
          reason: "malformed_registration",
          reference: referenceKey(source.ref),
          cause: String(cause),
        })
      }
      const key = referenceKey(metadata.ref)
      if (this.#byReference.has(key)) {
        throw new StageCatalogError({ reason: "duplicate_reference", reference: key })
      }
      const registrationSha256 = canonicalSha256({
        contractVersion: 1,
        normalizationVersion: "RFC8785-NFC-1",
        metadata,
        requestJsonSchema,
        resultJsonSchema,
      })
      this.#byReference.set(key, {
        source,
        descriptor: { ...metadata, registrationSha256 },
        requestSchema,
        resultSchema,
        compatibility,
      })
    }
  }

  readonly descriptor = (ref: StageContractRef): StageContractDescriptor => {
    let decoded: StageContractRef
    try {
      decoded = Schema.decodeUnknownSync(StageContractRef)(ref)
    } catch (cause) {
      throw new StageCatalogError({
        reason: "unknown_reference",
        reference: JSON.stringify(ref),
        cause: String(cause),
      })
    }
    const key = referenceKey(decoded)
    const registration = this.#byReference.get(key)
    if (registration === undefined) {
      throw new StageCatalogError({ reason: "unknown_reference", reference: key })
    }
    return registration.descriptor
  }

  readonly registrationFor = <Request, RequestEncoded, Result, ResultEncoded>(
    source: StageContract<Request, RequestEncoded, Result, ResultEncoded>,
  ) => {
    const key = referenceKey(source.ref)
    const registration = this.#byReference.get(key)
    if (registration === undefined) {
      throw new StageCatalogError({ reason: "unknown_reference", reference: key })
    }
    if (registration.source !== source) {
      throw new StageCatalogError({ reason: "untrusted_source", reference: key })
    }
    return {
      source,
      descriptor: registration.descriptor,
      requestSchema: source.requestSchema,
      resultSchema: source.resultSchema,
    } as const
  }

  readonly port = (): StageCatalogPort => ({
    describe: (ref) =>
      Effect.try({
        try: () => this.descriptor(ref),
        catch: (cause) =>
          cause instanceof StageCatalogError
            ? cause
            : new StageCatalogError({
                reason: "unknown_reference",
                reference: referenceKey(ref),
                cause: String(cause),
              }),
      }),
    validateCompatibility: (definition) =>
      Effect.try({
        try: () => {
          const key = referenceKey(definition.contract)
          const registration = this.#byReference.get(key)
          if (registration === undefined) {
            throw new StageCatalogError({ reason: "unknown_reference", reference: key })
          }
          registration.compatibility(definition)
        },
        catch: (cause) =>
          cause instanceof StageCatalogError
            ? cause
            : new StageCatalogError({
                reason: "incompatible_definition",
                reference: referenceKey(definition.contract),
                cause: String(cause),
              }),
      }),
  })
}

export type StageCatalogPort = {
  readonly describe: (
    ref: StageContractRef,
  ) => Effect.Effect<StageContractDescriptor, StageCatalogError>
  readonly validateCompatibility: (
    definition: StageDefinition,
  ) => Effect.Effect<void, StageCatalogError>
}

export const StageCatalog = Context.GenericTag<StageCatalogPort>("workflowd/qrspi/StageCatalog")

export const validateWorkflowDefinition = (input: {
  readonly definition: WorkflowDefinition
  readonly stageCatalog: StageCatalogPort
  readonly agentHarness: AgentHarnessPort
}) =>
  Effect.gen(function* () {
    const definition = yield* Effect.try({
      try: () => normalizeWorkflowDefinition(input.definition),
      catch: (cause) =>
        cause instanceof WorkflowDefinitionValidationError
          ? cause
          : validationError("pure", "incompatible_definition", undefined, undefined, cause),
    })
    const workflowSha256 = workflowDefinitionSha256(definition)
    const stageSnapshots = yield* Effect.forEach(
      definition.stages,
      (stage, index) => resolveExecutableSnapshot(input, workflowSha256, stage, index + 1),
      { concurrency: 1 },
    )
    const selections = firstSeenSelections(
      stageSnapshots.map(({ definition: stage }) => ({
        ref: stage.producer.harness,
        agent: stage.producer.agent,
        model: stage.producer.model,
      })),
    )
    yield* input.agentHarness.validateAvailability({ selections }).pipe(
      Effect.mapError((cause) => {
        const failedSnapshot =
          cause.selection === undefined
            ? undefined
            : stageSnapshots.find(
                ({ definition: stage }) =>
                  canonicalSha256({
                    ref: stage.producer.harness,
                    agent: stage.producer.agent,
                    model: stage.producer.model,
                  }) === canonicalSha256(cause.selection),
              )
        return new WorkflowDefinitionValidationError({
          phase: "availability",
          reason: "unavailable_agent_model",
          workflowDefinitionSha256: workflowSha256,
          ...(failedSnapshot === undefined
            ? {}
            : {
                stageKey: failedSnapshot.definition.key,
                sequencePosition: failedSnapshot.sequencePosition,
                contractRef: failedSnapshot.definition.contract,
                harnessRef: failedSnapshot.definition.producer.harness,
              }),
          cause: boundedCause(cause),
        })
      }),
    )
    return { definition, stageSnapshots } as const
  })

export const validatePersistedSnapshots = (input: {
  readonly workflowDefinitionSha256: string
  readonly snapshots: ReadonlyArray<typeof ExecutableStageSnapshot.Type>
  readonly stageCatalog: StageCatalogPort
  readonly agentHarness: AgentHarnessPort
}) =>
  Effect.gen(function* () {
    yield* Effect.forEach(
      input.snapshots,
      (snapshot, index) =>
        Effect.gen(function* () {
          const fields = {
            workflowDefinitionSha256: input.workflowDefinitionSha256,
            stageKey: snapshot.definition.key,
            sequencePosition: snapshot.sequencePosition,
            contractRef: snapshot.definition.contract,
            harnessRef: snapshot.definition.producer.harness,
          }
          if (
            snapshot.sequencePosition !== index + 1 ||
            snapshot.stageDefinitionSha256 !== stageDefinitionSha256(snapshot.definition)
          ) {
            return yield* Effect.fail(
              new WorkflowDefinitionValidationError({
                phase: "pure",
                reason: "invalid_stage_order",
                ...fields,
              }),
            )
          }
          const contract = yield* input.stageCatalog
            .describe(snapshot.definition.contract)
            .pipe(
              Effect.mapError((cause) =>
                validationError(
                  "contract",
                  "unknown_contract_reference",
                  snapshot.definition,
                  snapshot.sequencePosition,
                  cause,
                  input.workflowDefinitionSha256,
                ),
              ),
            )
          if (contract.registrationSha256 !== snapshot.contractRegistrationSha256) {
            return yield* Effect.fail(
              new WorkflowDefinitionValidationError({
                phase: "contract",
                reason: "registration_hash_mismatch",
                ...fields,
                expectedRegistrationSha256: snapshot.contractRegistrationSha256,
                actualRegistrationSha256: contract.registrationSha256,
              }),
            )
          }
          const harness = yield* input.agentHarness
            .describe(snapshot.definition.producer.harness)
            .pipe(
              Effect.mapError((cause) =>
                validationError(
                  "harness",
                  "unknown_harness_reference",
                  snapshot.definition,
                  snapshot.sequencePosition,
                  cause,
                  input.workflowDefinitionSha256,
                ),
              ),
            )
          if (harness.registrationSha256 !== snapshot.harnessRegistrationSha256) {
            return yield* Effect.fail(
              new WorkflowDefinitionValidationError({
                phase: "harness",
                reason: "registration_hash_mismatch",
                ...fields,
                expectedRegistrationSha256: snapshot.harnessRegistrationSha256,
                actualRegistrationSha256: harness.registrationSha256,
              }),
            )
          }
        }),
      { concurrency: 1, discard: true },
    )
    const selections = firstSeenSelections(
      input.snapshots.map(({ definition: stage }) => ({
        ref: stage.producer.harness,
        agent: stage.producer.agent,
        model: stage.producer.model,
      })),
    )
    yield* input.agentHarness.validateAvailability({ selections }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowDefinitionValidationError({
            phase: "availability",
            reason: "unavailable_agent_model",
            workflowDefinitionSha256: input.workflowDefinitionSha256,
            cause: boundedCause(cause),
          }),
      ),
    )
  })

function resolveExecutableSnapshot(
  input: { readonly stageCatalog: StageCatalogPort; readonly agentHarness: AgentHarnessPort },
  workflowSha256: string,
  stage: StageDefinition,
  sequencePosition: number,
) {
  const fields = {
    workflowDefinitionSha256: workflowSha256,
    stageKey: stage.key,
    sequencePosition,
    contractRef: stage.contract,
    harnessRef: stage.producer.harness,
  }
  return Effect.gen(function* () {
    const contract = yield* input.stageCatalog
      .describe(stage.contract)
      .pipe(
        Effect.mapError((cause) =>
          validationError(
            "contract",
            cause.reason === "unknown_reference"
              ? "unknown_contract_reference"
              : "incompatible_definition",
            stage,
            sequencePosition,
            cause,
            workflowSha256,
          ),
        ),
      )
    yield* input.stageCatalog
      .validateCompatibility(stage)
      .pipe(
        Effect.mapError((cause) =>
          validationError(
            "contract",
            cause.reason === "unknown_reference"
              ? "unknown_contract_reference"
              : "incompatible_definition",
            stage,
            sequencePosition,
            cause,
            workflowSha256,
          ),
        ),
      )
    if (contract.kind !== stage.kind) {
      return yield* Effect.fail(
        new WorkflowDefinitionValidationError({
          phase: "contract",
          reason: "incompatible_kind",
          ...fields,
        }),
      )
    }
    if (stage.maxEncodedInputBytes > contract.maxRequestBytes) {
      return yield* Effect.fail(
        new WorkflowDefinitionValidationError({
          phase: "contract",
          reason: "unsupported_bound",
          ...fields,
        }),
      )
    }
    if (
      (stage.kind === "document" && stage.outputPolicy._tag !== "Artifact") ||
      (stage.kind === "implementation" && stage.outputPolicy._tag !== "ImplementationCheckpoint")
    ) {
      return yield* Effect.fail(
        new WorkflowDefinitionValidationError({
          phase: "contract",
          reason: "incompatible_output",
          ...fields,
        }),
      )
    }
    const policyRefs = [
      ...(stage.activation.mode === "conditional" ? [stage.activation.policy] : []),
      stage.designPolicy,
      stage.promotionPolicy,
      stage.structurePolicy,
    ].filter((ref) => ref !== undefined)
    if (policyRefs.some((ref) => ref.version !== 1)) {
      return yield* Effect.fail(
        new WorkflowDefinitionValidationError({
          phase: "contract",
          reason: "unsupported_policy",
          ...fields,
        }),
      )
    }
    const harness = yield* input.agentHarness
      .describe(stage.producer.harness)
      .pipe(
        Effect.mapError((cause) =>
          validationError(
            "harness",
            "unknown_harness_reference",
            stage,
            sequencePosition,
            cause,
            workflowSha256,
          ),
        ),
      )
    return yield* Schema.decodeUnknown(ExecutableStageSnapshot)({
      sequencePosition,
      stageDefinitionSha256: stageDefinitionSha256(stage),
      definition: stage,
      contractRegistrationSha256: contract.registrationSha256,
      harnessRegistrationSha256: harness.registrationSha256,
    }).pipe(
      Effect.mapError((cause) =>
        validationError(
          "pure",
          "incompatible_definition",
          stage,
          sequencePosition,
          cause,
          workflowSha256,
        ),
      ),
    )
  })
}

function firstSeenSelections(
  selections: ReadonlyArray<{
    readonly ref: { readonly name: string; readonly version: number }
    readonly agent: string
    readonly model: string
  }>,
) {
  const seen = new Set<string>()
  return selections.filter((selection) => {
    const key = canonicalSha256(selection)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function validationError(
  phase: WorkflowDefinitionValidationError["phase"],
  reason: WorkflowDefinitionValidationError["reason"],
  stage: StageDefinition | undefined,
  sequencePosition: number | undefined,
  cause?: unknown,
  workflowSha256?: string,
) {
  return new WorkflowDefinitionValidationError({
    phase,
    reason,
    ...(workflowSha256 === undefined ? {} : { workflowDefinitionSha256: workflowSha256 }),
    ...(stage === undefined
      ? {}
      : {
          stageKey: stage.key,
          contractRef: stage.contract,
          harnessRef: stage.producer.harness,
        }),
    ...(sequencePosition === undefined ? {} : { sequencePosition }),
    ...(cause === undefined ? {} : { cause: boundedCause(cause) }),
  })
}

function boundedCause(cause: unknown): string {
  return String(cause).slice(0, 1_000)
}

export const QuestionsStageRequest = Schema.Struct({ ticket: Schema.Unknown })
export const QuestionsStageResult = Schema.Struct({ text: Schema.String })

export const questionsStageContract: StageContract<
  typeof QuestionsStageRequest.Type,
  typeof QuestionsStageRequest.Encoded,
  typeof QuestionsStageResult.Type,
  typeof QuestionsStageResult.Encoded
> = {
  ref: { name: "qrspi.questions", contractVersion: 1 },
  implementationRevision: "qrspi.questions.v1",
  kind: "document",
  requestSchema: QuestionsStageRequest,
  resultSchema: QuestionsStageResult,
  maxRequestBytes: MAX_AGENT_LAUNCH_INTENT_BYTES,
  maxResultBytes: MAX_AGENT_OUTPUT_BYTES,
  compatibility: () => undefined,
  assembleRequest: (sources) => ({ ticket: sources }),
  buildTask: () => ({
    title: "QRSPI questions",
    prompt: "Produce the questions stage result.",
    resultSchema: QuestionsStageResult,
  }),
  prepareOutput: (result) => ({ _tag: "Document", text: result.text }),
}
