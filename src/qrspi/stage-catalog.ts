import { Context, Data, Effect, JSONSchema, Schema } from "effect"
import {
  MAX_AGENT_OUTPUT_BYTES,
  MAX_STAGE_REQUEST_BYTES,
  type AgentHarnessPort,
  type AgentHarnessSelection,
} from "../agent-harness"
import { stageHarnessRef } from "../opencode"
import { JsonValueSchema, type JsonValue } from "../json"
import {
  ExecutableStageSnapshot,
  Sha256,
  StageContractRef,
  TicketRevision,
  type StageDefinition,
  type WorkflowDefinition,
  WorkflowDefinitionValidationError,
  normalizeWorkflowDefinition,
  stageDefinitionSha256,
  ticketRevisionSha256For,
  workflowIdFor,
  workflowDefinitionSha256,
} from "./domain"
import { canonicalSha256 } from "./domain"
import {
  BoundedTaskPrompt,
  BoundedTaskTitle,
  AcceptedPredecessorPointer,
  ExactStageScope,
  ExactStageSources,
  PreparedStageOutput,
  StageExecutionContext,
  StageProduceInput,
  StageKey,
  StageTaskAuthority,
  StructureAuthority,
} from "./contracts/common"

const ReplaySnapshotAuthority = Schema.Struct({
  stageKey: StageKey,
  stageDefinitionSha256: Sha256,
  contract: StageContractRef,
  contractRegistrationSha256: Sha256,
})

const StageReplayAuthority = Schema.Struct({
  scope: ExactStageScope,
  stageSnapshot: Schema.Struct({
    ...ReplaySnapshotAuthority.fields,
    maxEncodedInputBytes: Schema.Int.pipe(Schema.positive()),
  }),
  predecessorSnapshots: Schema.Array(ReplaySnapshotAuthority).pipe(Schema.maxItems(5)),
  acceptedPointers: Schema.Array(AcceptedPredecessorPointer).pipe(Schema.maxItems(5)),
})
export type StageReplayAuthority = typeof StageReplayAuthority.Type

export type PreparedDocumentOutput = { readonly _tag: "Document"; readonly text: string }
export type PreparedImplementationStepOutput = {
  readonly _tag: "ImplementationStep"
  readonly value: unknown
}
export type AgentTask<Result, ResultEncoded> = {
  readonly title: string
  readonly prompt: string
  readonly authority: StageTaskAuthority
  readonly resultSchema: Schema.Schema<Result, ResultEncoded, never>
}

type StageContractBase<Request, RequestEncoded, Result, ResultEncoded> = {
  readonly ref: StageContractRef
  readonly stageKey: string
  readonly implementationRevision: string
  readonly requestSchema: Schema.Schema<Request, RequestEncoded, never>
  readonly resultSchema: Schema.Schema<Result, ResultEncoded, never>
  readonly maxRequestBytes: number
  readonly maxResultBytes: number
  readonly compatibility: (definition: StageDefinition) => void
  readonly assembleRequest: (sources: ExactStageSources, local?: JsonValue) => RequestEncoded
  readonly buildTask: (request: Request) => AgentTask<Result, ResultEncoded>
}

export type StageContract<Request, RequestEncoded, Result, ResultEncoded> = StageContractBase<
  Request,
  RequestEncoded,
  Result,
  ResultEncoded
> &
  (
    | {
        readonly kind: "document"
        readonly prepareOutput: (
          result: Result,
          context: StageExecutionContext,
        ) => PreparedDocumentOutput
      }
    | {
        readonly kind: "implementation"
        readonly prepareOutput: (
          result: Result,
          context: StageExecutionContext,
        ) => PreparedImplementationStepOutput
      }
  )

type StageContractRegistration = {
  readonly ref: StageContractRef
  readonly stageKey?: unknown
  readonly implementationRevision?: unknown
  readonly kind?: unknown
  readonly requestSchema?: unknown
  readonly resultSchema?: unknown
  readonly maxRequestBytes?: unknown
  readonly maxResultBytes?: unknown
  readonly compatibility?: (definition: StageDefinition) => void
  readonly assembleRequest?: unknown
  readonly buildTask?: unknown
  readonly prepareOutput?: unknown
}

export type StageContractDescriptor = {
  readonly ref: StageContractRef
  readonly stageKey: string
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
    | "malformed_request"
    | "request_too_large"
    | "malformed_input"
    | "identity_mismatch"
    | "malformed_task"
    | "malformed_result"
    | "result_too_large"
    | "malformed_output"
  readonly reference: string
  readonly cause?: string
}> {}

type RuntimeRegistration = {
  readonly source: StageContractRegistration
  readonly descriptor: StageContractDescriptor
  readonly requestSchema: Schema.Schema<unknown, unknown, never>
  readonly resultSchema: Schema.Schema<unknown, unknown, never>
  readonly compatibility: (definition: StageDefinition) => void
  readonly assembleRequest: (sources: ExactStageSources, local?: JsonValue) => unknown
  readonly buildTask: (request: unknown) => AgentTask<unknown, unknown>
  readonly prepareOutput: (result: unknown, context: StageExecutionContext) => unknown
}

const exactParseOptions = { onExcessProperty: "error" as const }

const RegistrationMetadata = Schema.Struct({
  ref: StageContractRef,
  stageKey: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  implementationRevision: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  kind: Schema.Literal("document", "implementation"),
  maxRequestBytes: Schema.Int.pipe(Schema.positive()),
  maxResultBytes: Schema.Int.pipe(Schema.positive()),
})

const referenceKey = (ref: StageContractRef) => `${ref.name}@${ref.contractVersion}`

function diagnosticReference(source: unknown): string {
  if (source === null || typeof source !== "object" || !("ref" in source)) return "<missing>"
  try {
    return (JSON.stringify(source.ref) ?? String(source.ref)).slice(0, 256)
  } catch {
    return "<unserializable>"
  }
}

function isErasedSchema(value: unknown): value is Schema.Schema<unknown, unknown, never> {
  return Schema.isSchema(value)
}

function isCompatibility(value: unknown): value is RuntimeRegistration["compatibility"] {
  return typeof value === "function"
}

function isRequestAssembler(value: unknown): value is RuntimeRegistration["assembleRequest"] {
  return typeof value === "function"
}

function isTaskBuilder(value: unknown): value is RuntimeRegistration["buildTask"] {
  return typeof value === "function"
}

function isOutputPreparer(value: unknown): value is RuntimeRegistration["prepareOutput"] {
  return typeof value === "function"
}

export class TrustedStageCatalog {
  readonly #byReference = new Map<string, RuntimeRegistration>()

  constructor(registrations: ReadonlyArray<StageContractRegistration>) {
    for (const source of registrations) {
      let metadata: typeof RegistrationMetadata.Type
      let requestSchema: Schema.Schema<unknown, unknown, never>
      let resultSchema: Schema.Schema<unknown, unknown, never>
      let compatibility: (definition: StageDefinition) => void
      let assembleRequest: (sources: ExactStageSources, local?: JsonValue) => unknown
      let buildTask: (request: unknown) => AgentTask<unknown, unknown>
      let prepareOutput: (result: unknown, context: StageExecutionContext) => unknown
      let requestJsonSchema: object
      let resultJsonSchema: object
      try {
        metadata = Schema.decodeUnknownSync(RegistrationMetadata)(source)
        if (!isErasedSchema(source.requestSchema) || !isErasedSchema(source.resultSchema)) {
          throw new Error("requestSchema and resultSchema must be Effect Schemas")
        }
        if (!isCompatibility(source.compatibility)) {
          throw new Error("compatibility must be a function")
        }
        if (!isRequestAssembler(source.assembleRequest)) {
          throw new Error("assembleRequest must be a function")
        }
        if (!isTaskBuilder(source.buildTask)) {
          throw new Error("buildTask must be a function")
        }
        if (!isOutputPreparer(source.prepareOutput)) {
          throw new Error("prepareOutput must be a function")
        }
        requestSchema = source.requestSchema
        resultSchema = source.resultSchema
        compatibility = source.compatibility
        assembleRequest = source.assembleRequest
        buildTask = source.buildTask
        prepareOutput = source.prepareOutput
        requestJsonSchema = JSONSchema.make(requestSchema)
        resultJsonSchema = JSONSchema.make(resultSchema)
        if (
          metadata.maxRequestBytes > MAX_STAGE_REQUEST_BYTES ||
          metadata.maxResultBytes > MAX_AGENT_OUTPUT_BYTES
        ) {
          throw new Error("declared limit exceeds durable envelope")
        }
      } catch (cause) {
        throw new StageCatalogError({
          reason: "malformed_registration",
          reference: diagnosticReference(source),
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
        assembleRequest,
        buildTask,
        prepareOutput,
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
    assembleRequest: (input) =>
      Effect.try({
        try: () => {
          const registration = this.#registration(input.contract)
          const sources = Schema.decodeUnknownSync(
            ExactStageSources,
            exactParseOptions,
          )(input.sources)
          if (sources.stageKey !== registration.descriptor.stageKey) {
            throw catalogError("identity_mismatch", registration.descriptor.ref)
          }
          const request = Schema.decodeUnknownSync(JsonValueSchema)(
            Schema.decodeUnknownSync(
              registration.requestSchema,
              exactParseOptions,
            )(registration.assembleRequest(sources, input.local)),
          )
          const bytes = encodedBytes(request)
          if (
            bytes > registration.descriptor.maxRequestBytes ||
            bytes > input.maxEncodedInputBytes
          ) {
            throw catalogError("request_too_large", registration.descriptor.ref)
          }
          return request
        },
        catch: (cause) =>
          cause instanceof StageCatalogError
            ? cause
            : catalogError("malformed_request", input.contract, cause),
      }),
    buildTask: (input) =>
      Effect.try({
        try: () => {
          const registration = this.#registration(diagnosticContract(input.input))
          const replayAuthority = Schema.decodeUnknownSync(StageReplayAuthority)(
            input.replayAuthority,
          )
          if (
            input.input !== null &&
            typeof input.input === "object" &&
            "request" in input.input &&
            (encodedBytes(input.input.request) > registration.descriptor.maxRequestBytes ||
              encodedBytes(input.input.request) >
                replayAuthority.stageSnapshot.maxEncodedInputBytes)
          ) {
            throw catalogError("request_too_large", registration.descriptor.ref)
          }
          const durableInput = Schema.decodeUnknownSync(StageProduceInput)(input.input)
          const ticketRevision = Schema.decodeUnknownSync(TicketRevision)(input.ticketRevision)
          const durableSources = requestSourcesOf(durableInput.request, registration.descriptor.ref)
          if (durableSources.stageKey !== registration.descriptor.stageKey) {
            throw catalogError("identity_mismatch", registration.descriptor.ref)
          }
          const request = Schema.decodeUnknownSync(
            registration.requestSchema,
            exactParseOptions,
          )(durableInput.request)
          const sources = requestSourcesOf(request, registration.descriptor.ref)
          if (
            canonicalSha256(durableInput.scope) !== canonicalSha256(scopeOf(sources)) ||
            canonicalSha256(replayAuthority.scope) !== canonicalSha256(durableInput.scope) ||
            !matchesSelectedSnapshot(replayAuthority, sources, registration.descriptor) ||
            !matchesPredecessorAuthority(replayAuthority, sources, this) ||
            sources.ticketRevision.workflowId !== durableInput.scope.workflowId ||
            ticketRevision.ticketRevisionSha256 !== sources.ticketRevision.ticketRevisionSha256 ||
            workflowIdFor(sources.target.repository, ticketRevision.readyTicket.reference) !==
              sources.workflowId ||
            ticketRevisionSha256For(ticketRevision.readyTicket, ticketRevision.scenarioCoverage) !==
              ticketRevision.ticketRevisionSha256
          ) {
            throw catalogError("identity_mismatch", registration.descriptor.ref)
          }
          try {
            const task = registration.buildTask(request)
            const title = Schema.decodeUnknownSync(BoundedTaskTitle)(task.title)
            const prompt = Schema.decodeUnknownSync(BoundedTaskPrompt)(task.prompt)
            const authority = Schema.decodeUnknownSync(StageTaskAuthority)(task.authority)
            if (
              canonicalSha256(authority) !==
                canonicalSha256({
                  ticketRevision: sources.ticketRevision,
                  sources: sources.sources,
                  ...(sources.revisionIntent === undefined
                    ? {}
                    : { revisionIntent: sources.revisionIntent }),
                  ...structureTaskAuthority(request),
                }) ||
              task.resultSchema !== registration.resultSchema
            ) {
              throw new Error("task authority or result Schema does not match registration")
            }
            return { title, prompt, authority, resultSchema: registration.resultSchema }
          } catch (cause) {
            throw catalogError("malformed_task", registration.descriptor.ref, cause)
          }
        },
        catch: (cause) => {
          if (cause instanceof StageCatalogError) return cause
          return catalogError(
            isStageProduceInput(input.input) ? "malformed_request" : "malformed_input",
            diagnosticContract(input.input),
            cause,
          )
        },
      }),
    prepareOutput: (input) =>
      Effect.try({
        try: () => {
          const registration = this.#registration(input.contract)
          const bytes = encodedBytes(input.result)
          if (bytes > MAX_AGENT_OUTPUT_BYTES || bytes > registration.descriptor.maxResultBytes) {
            throw catalogError("result_too_large", registration.descriptor.ref)
          }
          const result = Schema.decodeUnknownSync(
            registration.resultSchema,
            exactParseOptions,
          )(input.result)
          const context = Schema.decodeUnknownSync(StageExecutionContext)(input.context)
          if (context.scope.stageKey !== registration.descriptor.stageKey) {
            throw catalogError("identity_mismatch", registration.descriptor.ref)
          }
          try {
            const output = Schema.decodeUnknownSync(PreparedStageOutput)(
              registration.prepareOutput(result, context),
            )
            if (
              (registration.descriptor.kind === "document" && output._tag !== "Document") ||
              (registration.descriptor.kind === "implementation" &&
                output._tag !== "ImplementationStep")
            ) {
              throw new Error("prepared output tag does not match registered stage kind")
            }
            return output
          } catch (cause) {
            throw catalogError("malformed_output", registration.descriptor.ref, cause)
          }
        },
        catch: (cause) =>
          cause instanceof StageCatalogError
            ? cause
            : catalogError("malformed_result", input.contract, cause),
      }),
  })

  #registration(ref: StageContractRef): RuntimeRegistration {
    const decoded = Schema.decodeUnknownSync(StageContractRef)(ref)
    const registration = this.#byReference.get(referenceKey(decoded))
    if (registration === undefined) {
      throw new StageCatalogError({
        reason: "unknown_reference",
        reference: referenceKey(decoded),
      })
    }
    return registration
  }
}

function encodedBytes(value: unknown): number {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("value is not JSON encodable")
  return Buffer.byteLength(encoded, "utf8")
}

function catalogError(
  reason: StageCatalogError["reason"],
  ref: StageContractRef,
  cause?: unknown,
): StageCatalogError {
  return new StageCatalogError({
    reason,
    reference: referenceKey(ref),
    ...(cause === undefined ? {} : { cause: boundedCause(cause) }),
  })
}

function isStageProduceInput(input: unknown): boolean {
  return input !== null && typeof input === "object" && "contractVersion" in input
}

function diagnosticContract(input: unknown): StageContractRef {
  if (input !== null && typeof input === "object" && "contract" in input) {
    try {
      return Schema.decodeUnknownSync(StageContractRef)(input.contract)
    } catch {
      // Fall through to a bounded diagnostic reference.
    }
  }
  return { name: "malformed", contractVersion: 1 }
}

function requestSourcesOf(request: unknown, ref: StageContractRef): ExactStageSources {
  if (request === null || typeof request !== "object" || !("sources" in request)) {
    throw catalogError("malformed_request", ref)
  }
  return Schema.decodeUnknownSync(ExactStageSources, exactParseOptions)(request.sources)
}

function structureTaskAuthority(request: unknown) {
  if (request === null || typeof request !== "object" || !("authority" in request)) return {}
  return {
    structureAuthority: Schema.decodeUnknownSync(StructureAuthority)(request.authority),
  }
}

function scopeOf(sources: ExactStageSources) {
  return {
    workflowId: sources.workflowId,
    generation: sources.generation,
    stageKey: sources.stageKey,
    runOrdinal: sources.runOrdinal,
    stageRevision: sources.stageRevision,
    workflowDefinitionSha256: sources.workflowDefinitionSha256,
    stageDefinitionSha256: sources.stageDefinitionSha256,
  }
}

function matchesSelectedSnapshot(
  authority: StageReplayAuthority,
  sources: ExactStageSources,
  descriptor: StageContractDescriptor,
): boolean {
  const snapshot = authority.stageSnapshot
  return (
    snapshot.stageKey === sources.stageKey &&
    snapshot.stageDefinitionSha256 === sources.stageDefinitionSha256 &&
    canonicalSha256(snapshot.contract) === canonicalSha256(descriptor.ref) &&
    snapshot.contractRegistrationSha256 === descriptor.registrationSha256
  )
}

function matchesPredecessorAuthority(
  authority: StageReplayAuthority,
  sources: ExactStageSources,
  catalog: TrustedStageCatalog,
): boolean {
  if (
    authority.acceptedPointers.length !== sources.sources.length ||
    authority.predecessorSnapshots.length !== sources.sources.length
  ) {
    return false
  }
  return sources.sources.every((source, index) => {
    const acceptedPointer = authority.acceptedPointers[index]
    const snapshot = authority.predecessorSnapshots[index]
    if (acceptedPointer === undefined || snapshot === undefined) return false
    let descriptor: StageContractDescriptor
    try {
      descriptor = catalog.descriptor(source.acceptedPointer.contract)
    } catch {
      return false
    }
    return (
      canonicalSha256(source.acceptedPointer) === canonicalSha256(acceptedPointer) &&
      snapshot.stageKey === source.artifact.stageKey &&
      snapshot.stageDefinitionSha256 === source.acceptedPointer.snapshotSha256 &&
      canonicalSha256(snapshot.contract) === canonicalSha256(source.acceptedPointer.contract) &&
      snapshot.contractRegistrationSha256 === source.acceptedPointer.contractRegistrationSha256 &&
      descriptor.registrationSha256 === source.acceptedPointer.contractRegistrationSha256
    )
  })
}

export type StageCatalogPort = {
  readonly describe: (
    ref: StageContractRef,
  ) => Effect.Effect<StageContractDescriptor, StageCatalogError>
  readonly validateCompatibility: (
    definition: StageDefinition,
  ) => Effect.Effect<void, StageCatalogError>
  readonly assembleRequest: (input: {
    readonly contract: StageContractRef
    readonly sources: ExactStageSources
    readonly local?: JsonValue
    readonly maxEncodedInputBytes: number
  }) => Effect.Effect<JsonValue, StageCatalogError>
  readonly buildTask: (input: {
    readonly input: unknown
    readonly ticketRevision: TicketRevision
    readonly replayAuthority: StageReplayAuthority
  }) => Effect.Effect<AgentTask<unknown, unknown>, StageCatalogError>
  readonly prepareOutput: (input: {
    readonly contract: StageContractRef
    readonly result: unknown
    readonly context: StageExecutionContext
  }) => Effect.Effect<PreparedStageOutput, StageCatalogError>
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
        const failedSnapshot = snapshotForSelection(stageSnapshots, cause.selection)
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
        }),
      { concurrency: 1, discard: true },
    )
    const definition = yield* Effect.try({
      try: () =>
        normalizeWorkflowDefinition({
          contractVersion: 1,
          definitionVersion: 1,
          stages: input.snapshots.map((snapshot) => snapshot.definition),
        }),
      catch: (cause) => {
        if (cause instanceof WorkflowDefinitionValidationError) {
          return new WorkflowDefinitionValidationError({
            phase: cause.phase,
            reason: cause.reason,
            workflowDefinitionSha256: input.workflowDefinitionSha256,
            ...(cause.stageKey === undefined ? {} : { stageKey: cause.stageKey }),
            ...(cause.sequencePosition === undefined
              ? {}
              : { sequencePosition: cause.sequencePosition }),
            ...(cause.cause === undefined ? {} : { cause: cause.cause }),
          })
        }
        return validationError(
          "pure",
          "incompatible_definition",
          undefined,
          undefined,
          cause,
          input.workflowDefinitionSha256,
        )
      },
    })
    const validatedSnapshots = yield* Effect.forEach(
      definition.stages,
      (stage, index) =>
        resolveExecutableSnapshot(input, input.workflowDefinitionSha256, stage, index + 1).pipe(
          Effect.flatMap((validated) => {
            const persisted = input.snapshots[index]!
            const fields = {
              workflowDefinitionSha256: input.workflowDefinitionSha256,
              stageKey: stage.key,
              sequencePosition: index + 1,
              contractRef: stage.contract,
              harnessRef: stage.producer.harness,
            }
            if (validated.contractRegistrationSha256 !== persisted.contractRegistrationSha256) {
              return Effect.fail(
                new WorkflowDefinitionValidationError({
                  phase: "contract",
                  reason: "registration_hash_mismatch",
                  ...fields,
                  expectedRegistrationSha256: persisted.contractRegistrationSha256,
                  actualRegistrationSha256: validated.contractRegistrationSha256,
                }),
              )
            }
            if (validated.harnessRegistrationSha256 !== persisted.harnessRegistrationSha256) {
              return Effect.fail(
                new WorkflowDefinitionValidationError({
                  phase: "harness",
                  reason: "registration_hash_mismatch",
                  ...fields,
                  expectedRegistrationSha256: persisted.harnessRegistrationSha256,
                  actualRegistrationSha256: validated.harnessRegistrationSha256,
                }),
              )
            }
            return Effect.succeed(validated)
          }),
        ),
      { concurrency: 1 },
    )
    const selections = firstSeenSelections(
      validatedSnapshots.map(({ definition: stage }) => ({
        ref: stage.producer.harness,
        agent: stage.producer.agent,
        model: stage.producer.model,
      })),
    )
    yield* input.agentHarness.validateAvailability({ selections }).pipe(
      Effect.mapError((cause) => {
        const failedSnapshot = snapshotForSelection(validatedSnapshots, cause.selection)
        return new WorkflowDefinitionValidationError({
          phase: "availability",
          reason: "unavailable_agent_model",
          workflowDefinitionSha256: input.workflowDefinitionSha256,
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
  })

function snapshotForSelection(
  snapshots: ReadonlyArray<typeof ExecutableStageSnapshot.Type>,
  selection: AgentHarnessSelection | undefined,
) {
  if (selection === undefined) return undefined
  const selectionSha256 = canonicalSha256(selection)
  return snapshots.find(
    ({ definition: stage }) =>
      canonicalSha256({
        ref: stage.producer.harness,
        agent: stage.producer.agent,
        model: stage.producer.model,
      }) === selectionSha256,
  )
}

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
      ...(stage.activation.mode === "conditional"
        ? ([[stage.activation.policy, "qrspi.activation"]] as const)
        : []),
      [stage.designPolicy, "qrspi.design-policy"] as const,
      [stage.promotionPolicy, "qrspi.promotion-policy"] as const,
      [stage.structurePolicy, "qrspi.structure-policy"] as const,
    ]
    if (
      policyRefs.some(
        ([ref, supportedName]) =>
          ref !== undefined && (ref.name !== supportedName || ref.version !== 1),
      )
    ) {
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
    if (
      harness.ref.name !== stageHarnessRef.name ||
      harness.ref.version !== stageHarnessRef.version
    ) {
      return yield* Effect.fail(
        new WorkflowDefinitionValidationError({
          phase: "harness",
          reason: "incompatible_definition",
          ...fields,
        }),
      )
    }
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
