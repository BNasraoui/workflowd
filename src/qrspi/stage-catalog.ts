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
  stageDefinitionSha256,
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
  readonly requestSchema: Schema.Schema<unknown, unknown, never>
  readonly resultSchema: Schema.Schema<unknown, unknown, never>
  readonly compatibility: (definition: StageDefinition) => void
}

const RegistrationMetadata = Schema.Struct({
  ref: StageContractRef,
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
      let requestSchema: Schema.Schema<unknown, unknown, never>
      let resultSchema: Schema.Schema<unknown, unknown, never>
      let compatibility: (definition: StageDefinition) => void
      let requestJsonSchema: object
      let resultJsonSchema: object
      try {
        const candidate = source as unknown as Record<string, unknown>
        metadata = Schema.decodeUnknownSync(RegistrationMetadata)(candidate)
        if (!Schema.isSchema(candidate.requestSchema) || !Schema.isSchema(candidate.resultSchema)) {
          throw new Error("requestSchema and resultSchema must be Effect Schemas")
        }
        if (typeof candidate.compatibility !== "function") {
          throw new Error("compatibility must be a function")
        }
        requestSchema = candidate.requestSchema as Schema.Schema<unknown, unknown, never>
        resultSchema = candidate.resultSchema as Schema.Schema<unknown, unknown, never>
        compatibility = candidate.compatibility as (definition: StageDefinition) => void
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
        reference: String(ref),
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

export const resolveFirstStage = (input: {
  readonly definition: WorkflowDefinition
  readonly stageCatalog: StageCatalogPort
  readonly agentHarness: AgentHarnessPort
}) =>
  Effect.gen(function* () {
    const stage = input.definition.stages.find(
      (candidate) =>
        candidate.activation.mode === "enabled" ||
        (candidate.activation.mode === "conditional" && candidate.activation.decision === "enabled"),
    )
    if (stage === undefined) {
      return yield* Effect.fail(
        new StageCatalogError({ reason: "incompatible_definition", reference: "missing-stage" }),
      )
    }
    const contract = yield* input.stageCatalog.describe(stage.contract)
    yield* input.stageCatalog.validateCompatibility(stage)
    if (
      contract.kind !== stage.kind ||
      stage.maxEncodedInputBytes > contract.maxRequestBytes ||
      (stage.kind === "document" && stage.outputPolicy._tag !== "Artifact")
    ) {
      return yield* Effect.fail(
        new StageCatalogError({
          reason: "incompatible_definition",
          reference: referenceKey(stage.contract),
        }),
      )
    }
    const harness = yield* input.agentHarness.describe(stage.producer.harness)
    yield* input.agentHarness.validateAvailability({
      selections: [
        {
          ref: stage.producer.harness,
          agent: stage.producer.agent,
          model: stage.producer.model,
        },
      ],
    })
    return Schema.decodeUnknownSync(ExecutableStageSnapshot)({
      sequencePosition: input.definition.stages.indexOf(stage) + 1,
      stageDefinitionSha256: stageDefinitionSha256(stage),
      definition: stage,
      contractRegistrationSha256: contract.registrationSha256,
      harnessRegistrationSha256: harness.registrationSha256,
    })
  })

export const QuestionsStageRequest = Schema.Struct({ ticket: Schema.Unknown })
export const QuestionsStageResult = Schema.Struct({ text: Schema.String })

export const questionsStageContract: StageContract<
  typeof QuestionsStageRequest.Type,
  typeof QuestionsStageRequest.Encoded,
  typeof QuestionsStageResult.Type,
  typeof QuestionsStageResult.Encoded
> = {
  ref: { name: "qrspi.questions", contractVersion: 1 },
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
