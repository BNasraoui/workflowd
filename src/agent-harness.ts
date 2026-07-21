import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { Context, Data, Effect, JSONSchema, Schema } from "effect"
import {
  AgentLaunchIntentEnvelope,
  MAX_AGENT_LAUNCH_INTENT_BYTES,
  MAX_AGENT_OUTPUT_BYTES,
  boundedAgentPayload,
} from "./agent-payload"
import { normalizeError } from "./errors"
import type { OpenCodeAdapter, OpenCodeModel } from "./opencode/adapter"
import { StructuredSession, StructuredSessionError } from "./opencode/structured-session"

export {
  AgentLaunchIntentEnvelope,
  AgentOutputEnvelope,
  MAX_AGENT_LAUNCH_INTENT_BYTES,
  MAX_AGENT_OUTPUT_BYTES,
} from "./agent-payload"

const BoundedIdentifier = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
)
const BoundedReference = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
  Schema.pattern(/^\S+$/),
)
const PositiveInt = Schema.Int.pipe(Schema.positive())

export const AgentHarnessRef = Schema.Struct({
  name: BoundedIdentifier,
  version: PositiveInt,
})
export type AgentHarnessRef = typeof AgentHarnessRef.Type

export const AgentRetryPolicy = Schema.Struct({
  maxAttempts: PositiveInt.pipe(Schema.lessThanOrEqualTo(10)),
  structuredOutputRetryCount: Schema.Int.pipe(Schema.nonNegative(), Schema.lessThanOrEqualTo(10)),
  invalidOutput: Schema.Literal("retry", "fail"),
})
export type AgentRetryPolicy = typeof AgentRetryPolicy.Type

export const AgentExecutionScope = Schema.Union(
  Schema.TaggedStruct("WorkflowScope", {
    workflowId: BoundedReference,
  }),
  Schema.TaggedStruct("GenerationScope", {
    workflowId: BoundedReference,
    generation: PositiveInt,
  }),
)
export type AgentExecutionScope = typeof AgentExecutionScope.Type

const LeaseToken = Schema.String.pipe(Schema.minLength(16), Schema.maxLength(128))
const IsoTimestamp = Schema.String.pipe(
  Schema.maxLength(32),
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
)

export const SessionReference = Schema.Struct({
  sessionReferenceId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  predecessorSessionReferenceId: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  ),
  serverId: BoundedIdentifier,
  endpointAlias: BoundedIdentifier,
  directory: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
  nativeSessionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  scope: AgentExecutionScope,
  operationId: BoundedReference,
  operationRevision: PositiveInt,
  attempt: PositiveInt,
  leaseToken: LeaseToken,
  createdAt: IsoTimestamp,
  state: Schema.Literal("created", "prompted", "succeeded", "failed", "superseded"),
})
export type SessionReference = typeof SessionReference.Type

export type AgentHarnessDefinition<Input, InputEncoded, Output, OutputEncoded> = {
  readonly ref: AgentHarnessRef
  readonly agent: string
  readonly model: string
  readonly inputSchema: Schema.Schema<Input, InputEncoded, never>
  readonly outputSchema: Schema.Schema<Output, OutputEncoded, never>
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly promptContract: string
  readonly title: (input: Input) => string
  readonly prompt: (input: Input) => string
  readonly timeoutMs: number
  readonly retryPolicy: AgentRetryPolicy
}

export type AgentExecutionContext = {
  readonly directory: string
  readonly scope: AgentExecutionScope
  readonly operationId: string
  readonly operationRevision: number
  readonly attempt: number
  readonly leaseToken: string
  readonly requestedAt: Date
}

export type AgentLaunchIntent<Input> = {
  readonly sessionReferenceId: string
  readonly harness: AgentHarnessRef
  readonly definitionHash: string
  readonly agent: string
  readonly model: string
  readonly input: Input
  readonly scope: AgentExecutionScope
  readonly operationId: string
  readonly operationRevision: number
  readonly attempt: number
  readonly leaseToken: string
  readonly directory: string
  readonly timeoutMs: number
  readonly retryPolicy: AgentRetryPolicy
  readonly requestedAt: string
}

export const AgentLaunchIntentSchema = Schema.Struct({
  sessionReferenceId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  harness: AgentHarnessRef,
  definitionHash: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
  agent: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  model: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  input: Schema.Unknown,
  scope: AgentExecutionScope,
  operationId: BoundedReference,
  operationRevision: PositiveInt,
  attempt: PositiveInt,
  leaseToken: LeaseToken,
  directory: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
  timeoutMs: PositiveInt.pipe(Schema.lessThanOrEqualTo(86_400_000)),
  retryPolicy: AgentRetryPolicy,
  requestedAt: IsoTimestamp,
})

export type PreparedAgentWork<Input, Output, OutputEncoded> = {
  readonly launchIntent: AgentLaunchIntent<Input>
  readonly title: string
  readonly prompt: string
  readonly model: OpenCodeModel
  readonly outputSchema: Schema.Schema<Output, OutputEncoded, never>
  readonly outputJsonSchema: object
  readonly maxOutputBytes: number
  readonly pollIntervalMs: number
}

export class AgentHarnessError extends Data.TaggedError("AgentHarnessError")<{
  readonly operation: string
  readonly cause: Error
  readonly retryable: boolean
}> {}

type HarnessRegistration = {
  readonly ref: AgentHarnessRef
}

type RuntimeDefinition = HarnessRegistration & {
  readonly agent: string
  readonly model: string
  readonly inputSchema: Schema.Schema<unknown, unknown, unknown>
  readonly outputSchema: Schema.Schema<unknown, unknown, unknown>
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly promptContract: string
  readonly timeoutMs: number
  readonly retryPolicy: AgentRetryPolicy
}

type RegisteredDefinition = {
  readonly source: HarnessRegistration
  readonly definition: RuntimeDefinition
  readonly definitionHash: string
  readonly inputJsonSchema: object
  readonly outputJsonSchema: object
}

const DefinitionMetadata = Schema.Struct({
  ref: AgentHarnessRef,
  agent: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(64),
    Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  ),
  model: Schema.String.pipe(
    Schema.maxLength(256),
    Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s/][^\s]*$/),
  ),
  promptContract: BoundedIdentifier,
  timeoutMs: PositiveInt.pipe(Schema.lessThanOrEqualTo(86_400_000)),
  retryPolicy: AgentRetryPolicy,
  maxInputBytes: PositiveInt,
  maxOutputBytes: PositiveInt,
})

const ExecutionContextSchema = Schema.Struct({
  directory: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
  scope: AgentExecutionScope,
  operationId: BoundedReference,
  operationRevision: PositiveInt,
  attempt: PositiveInt,
  leaseToken: LeaseToken,
  requestedAt: Schema.DateFromSelf,
})

const HarnessConfig = Schema.Struct({
  serverId: BoundedIdentifier,
  endpointAlias: BoundedIdentifier,
  pollIntervalMs: PositiveInt.pipe(Schema.lessThanOrEqualTo(60_000)),
})
type HarnessConfig = typeof HarnessConfig.Type

const referenceKey = (ref: AgentHarnessRef) => `${ref.name}@${ref.version}`

function decodeRuntimeDefinition(definition: HarnessRegistration): RuntimeDefinition {
  const invalid = () => new Error(`Invalid AgentHarness definition ${referenceKey(definition.ref)}`)
  if (!("agent" in definition) || typeof definition.agent !== "string") throw invalid()
  if (!("model" in definition) || typeof definition.model !== "string") throw invalid()
  if (!("inputSchema" in definition) || !Schema.isSchema(definition.inputSchema)) throw invalid()
  if (!("outputSchema" in definition) || !Schema.isSchema(definition.outputSchema)) throw invalid()
  if (!("maxInputBytes" in definition) || typeof definition.maxInputBytes !== "number")
    throw invalid()
  if (!("maxOutputBytes" in definition) || typeof definition.maxOutputBytes !== "number")
    throw invalid()
  if (!("promptContract" in definition) || typeof definition.promptContract !== "string") {
    throw invalid()
  }
  if (!("timeoutMs" in definition) || typeof definition.timeoutMs !== "number") throw invalid()
  if (!("retryPolicy" in definition)) throw invalid()
  return {
    ref: definition.ref,
    agent: definition.agent,
    model: definition.model,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    maxInputBytes: definition.maxInputBytes,
    maxOutputBytes: definition.maxOutputBytes,
    promptContract: definition.promptContract,
    timeoutMs: definition.timeoutMs,
    retryPolicy: Schema.decodeUnknownSync(AgentRetryPolicy)(definition.retryPolicy),
  }
}

export class TrustedAgentHarnessCatalog {
  readonly definitions: ReadonlyArray<HarnessRegistration>
  readonly #byReference = new Map<string, RegisteredDefinition>()

  constructor(definitions: ReadonlyArray<HarnessRegistration>) {
    for (const definition of definitions) {
      const runtime = decodeRuntimeDefinition(definition)
      Schema.decodeUnknownSync(DefinitionMetadata)(runtime)
      const key = referenceKey(runtime.ref)
      if (runtime.maxInputBytes > MAX_AGENT_LAUNCH_INTENT_BYTES) {
        throw new Error(
          `AgentHarness ${key} input limit ${runtime.maxInputBytes} exceeds durable launch envelope ${MAX_AGENT_LAUNCH_INTENT_BYTES}`,
        )
      }
      if (runtime.maxOutputBytes > MAX_AGENT_OUTPUT_BYTES) {
        throw new Error(
          `AgentHarness ${key} output limit ${runtime.maxOutputBytes} exceeds durable output envelope ${MAX_AGENT_OUTPUT_BYTES}`,
        )
      }
      const inputJsonSchema = JSONSchema.make(runtime.inputSchema)
      const outputJsonSchema = JSONSchema.make(runtime.outputSchema)
      if (this.#byReference.has(key)) {
        throw new Error(`Duplicate AgentHarness reference ${key}`)
      }
      this.#byReference.set(key, {
        source: definition,
        definition: runtime,
        definitionHash: definitionHash(runtime, inputJsonSchema, outputJsonSchema),
        inputJsonSchema,
        outputJsonSchema,
      })
    }
    this.definitions = definitions
  }

  definition(ref: AgentHarnessRef): HarnessRegistration {
    return this.registration(ref).definition
  }

  registration(ref: AgentHarnessRef): RegisteredDefinition {
    const decoded = Schema.decodeUnknownSync(AgentHarnessRef)(ref)
    const key = referenceKey(decoded)
    const registration = this.#byReference.get(key)
    if (registration === undefined) {
      throw new Error(`Unknown AgentHarness reference ${key}`)
    }
    return registration
  }

  registrationFor(definition: HarnessRegistration): RegisteredDefinition {
    const registration = this.registration(definition.ref)
    if (registration.source !== definition) {
      throw new Error(`Untrusted AgentHarness definition ${referenceKey(definition.ref)}`)
    }
    return registration
  }
}

export type AgentHarnessPort = {
  readonly validateAvailability: (input: {
    readonly refs: ReadonlyArray<AgentHarnessRef>
    readonly directory?: string
  }) => Effect.Effect<void, AgentHarnessError>
  readonly prepare: <Input, InputEncoded, Output, OutputEncoded>(
    definition: AgentHarnessDefinition<Input, InputEncoded, Output, OutputEncoded>,
    input: InputEncoded,
    context: AgentExecutionContext,
  ) => Effect.Effect<PreparedAgentWork<Input, Output, OutputEncoded>, AgentHarnessError>
  readonly createSession: <Input, Output, OutputEncoded>(
    prepared: PreparedAgentWork<Input, Output, OutputEncoded>,
  ) => Effect.Effect<SessionReference, AgentHarnessError>
  readonly resumeSession: <Input, Output, OutputEncoded>(
    prepared: PreparedAgentWork<Input, Output, OutputEncoded>,
    reference: SessionReference,
  ) => Effect.Effect<Output, AgentHarnessError>
  readonly abortSession: (reference: SessionReference) => Effect.Effect<void, AgentHarnessError>
}

export const AgentHarness = Context.GenericTag<AgentHarnessPort>("workflowd/AgentHarness")

export class OpenCodeAgentHarness implements AgentHarnessPort {
  readonly #config: HarnessConfig

  constructor(
    private readonly adapter: OpenCodeAdapter,
    private readonly catalog: TrustedAgentHarnessCatalog,
    config: HarnessConfig,
  ) {
    this.#config = Schema.decodeUnknownSync(HarnessConfig)(config)
  }

  readonly validateAvailability: AgentHarnessPort["validateAvailability"] = (input) =>
    Effect.forEach(
      input.refs,
      (ref) => {
        const registration = this.resolve(ref, "select harness")
        return Effect.flatMap(registration, ({ definition }) =>
          this.attempt("validate OpenCode availability", true, (signal) =>
            this.adapter.validateAvailability(
              {
                ...(input.directory === undefined ? {} : { directory: input.directory }),
                agents: [definition.agent],
                model: parseModel(definition.model),
              },
              signal,
            ),
          ),
        )
      },
      { concurrency: 1, discard: true },
    )

  readonly prepare: AgentHarnessPort["prepare"] = (definition, input, context) =>
    Effect.gen(this, function* () {
      const registration = yield* Effect.try({
        try: () => this.catalog.registrationFor(definition),
        catch: (cause) => this.error("select harness", cause, false),
      })
      const decodedContext = yield* Schema.decodeUnknown(ExecutionContextSchema)(context).pipe(
        Effect.mapError((cause) => this.error("validate agent execution context", cause, false)),
      )
      const decodedInput = yield* Schema.decodeUnknown(definition.inputSchema)(input).pipe(
        Effect.mapError((cause) => this.error("validate agent prompt input", cause, false)),
      )
      yield* Schema.decodeUnknown(
        boundedAgentPayload(definition.maxInputBytes, "Agent harness input"),
      )(decodedInput).pipe(
        Effect.mapError((cause) => this.error("validate encoded agent prompt input", cause, false)),
      )
      const request = yield* Effect.try({
        try: () => ({
          title: boundedText(definition.title(decodedInput), 256, "session title"),
          prompt: boundedText(definition.prompt(decodedInput), 32_768, "session prompt"),
        }),
        catch: (cause) => this.error("prepare agent prompt", cause, false),
      })
      const directory = resolve(decodedContext.directory)
      const launchIntent = {
        sessionReferenceId: randomUUID(),
        harness: definition.ref,
        definitionHash: registration.definitionHash,
        agent: definition.agent,
        model: definition.model,
        input: decodedInput,
        scope: decodedContext.scope,
        operationId: decodedContext.operationId,
        operationRevision: decodedContext.operationRevision,
        attempt: decodedContext.attempt,
        leaseToken: decodedContext.leaseToken,
        directory,
        timeoutMs: definition.timeoutMs,
        retryPolicy: definition.retryPolicy,
        requestedAt: decodedContext.requestedAt.toISOString(),
      }
      yield* Schema.decodeUnknown(AgentLaunchIntentSchema)(launchIntent).pipe(
        Effect.flatMap((decoded) => Schema.decodeUnknown(AgentLaunchIntentEnvelope)(decoded)),
        Effect.mapError((cause) =>
          this.error("validate durable agent launch intent", cause, false),
        ),
      )
      return {
        launchIntent,
        title: request.title,
        prompt: request.prompt,
        model: parseModel(definition.model),
        outputSchema: definition.outputSchema,
        outputJsonSchema: registration.outputJsonSchema,
        maxOutputBytes: definition.maxOutputBytes,
        pollIntervalMs: this.#config.pollIntervalMs,
      }
    })

  readonly createSession: AgentHarnessPort["createSession"] = (prepared) => {
    const session = this.structuredSession(prepared)
    const create = this.attempt("create session", true, (signal) => session.create(signal))
    return create.pipe(
      Effect.flatMap((created) =>
        Schema.decodeUnknown(SessionReference)({
          sessionReferenceId: prepared.launchIntent.sessionReferenceId,
          serverId: this.#config.serverId,
          endpointAlias: this.#config.endpointAlias,
          directory: created.directory,
          nativeSessionId: created.sessionID,
          scope: prepared.launchIntent.scope,
          operationId: prepared.launchIntent.operationId,
          operationRevision: prepared.launchIntent.operationRevision,
          attempt: prepared.launchIntent.attempt,
          leaseToken: prepared.launchIntent.leaseToken,
          createdAt: new Date().toISOString(),
          state: "created",
        }).pipe(Effect.mapError((cause) => this.error("build SessionReference", cause, false))),
      ),
    )
  }

  readonly resumeSession: AgentHarnessPort["resumeSession"] = (prepared, reference) => {
    const mismatch =
      sessionEndpointMismatch(this.#config, reference) ??
      sessionMismatch(prepared.launchIntent, reference)
    if (mismatch !== undefined) {
      return Effect.fail(this.error("validate SessionReference", new Error(mismatch), false))
    }
    const retryable = prepared.launchIntent.retryPolicy.invalidOutput === "retry"
    return this.attempt("run structured agent session", retryable, (signal) =>
      this.structuredSession(prepared).resume(
        { sessionID: reference.nativeSessionId, directory: reference.directory },
        signal,
      ),
    ).pipe(
      Effect.timeoutFail({
        duration: prepared.launchIntent.timeoutMs,
        onTimeout: () =>
          this.error(
            "run structured agent session",
            new Error(`Agent execution timed out after ${prepared.launchIntent.timeoutMs}ms`),
            true,
          ),
      }),
    )
  }

  readonly abortSession: AgentHarnessPort["abortSession"] = (reference) => {
    const mismatch = sessionEndpointMismatch(this.#config, reference)
    if (mismatch !== undefined) {
      return Effect.fail(this.error("abort session", new Error(mismatch), false))
    }
    return this.attempt("abort session", true, (signal) =>
      this.adapter.abortSession(
        { sessionID: reference.nativeSessionId, directory: reference.directory },
        signal,
      ),
    ).pipe(
      Effect.flatMap((aborted) =>
        aborted
          ? Effect.void
          : Effect.fail(
              this.error("abort session", new Error("OpenCode did not confirm the abort"), true),
            ),
      ),
      Effect.timeoutFail({
        duration: "5 seconds",
        onTimeout: () =>
          this.error("abort session", new Error("OpenCode session abort timed out"), true),
      }),
    )
  }

  private structuredSession<Input, Output, OutputEncoded>(
    prepared: PreparedAgentWork<Input, Output, OutputEncoded>,
  ) {
    return new StructuredSession(
      this.adapter,
      {
        directory: prepared.launchIntent.directory,
        title: prepared.title,
        agent: prepared.launchIntent.agent,
        model: prepared.model,
        format: {
          type: "json_schema",
          schema: prepared.outputJsonSchema,
          retryCount: prepared.launchIntent.retryPolicy.structuredOutputRetryCount,
        },
        prompt: prepared.prompt,
        pollIntervalMs: prepared.pollIntervalMs,
        maxOutputBytes: prepared.maxOutputBytes,
      },
      prepared.outputSchema,
    )
  }

  private resolve(ref: AgentHarnessRef, operation: string) {
    return Effect.try({
      try: () => this.catalog.registration(ref),
      catch: (cause) => this.error(operation, cause, false),
    })
  }

  private attempt<A>(
    operation: string,
    retryable: boolean,
    run: (signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<A, AgentHarnessError> {
    return Effect.tryPromise({
      try: run,
      catch: (cause) => {
        if (cause instanceof StructuredSessionError) {
          const invalidOutput =
            cause.operation === "decode structured session output" ||
            cause.message.includes("decode structured session output") ||
            cause.cause.message.includes("decode structured session output")
          return this.error(
            invalidOutput ? "decode structured session output" : cause.operation,
            cause.cause,
            invalidOutput ? retryable : true,
          )
        }
        return this.error(operation, cause, retryable)
      },
    })
  }

  private error(operation: string, cause: unknown, retryable: boolean) {
    return new AgentHarnessError({ operation, cause: normalizeError(cause), retryable })
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

function boundedText(value: string, maximum: number, name: string): string {
  if (value.length === 0 || value.length > maximum) {
    throw new Error(`${name} must contain between 1 and ${maximum} characters`)
  }
  return value
}

function sessionMismatch<Input>(
  intent: AgentLaunchIntent<Input>,
  reference: SessionReference,
): string | undefined {
  if (reference.sessionReferenceId !== intent.sessionReferenceId) return "reference ID changed"
  if (reference.directory !== intent.directory) return "directory changed"
  if (reference.operationId !== intent.operationId) return "operation changed"
  if (reference.operationRevision !== intent.operationRevision) return "operation revision changed"
  if (reference.attempt !== intent.attempt) return "attempt changed"
  if (reference.leaseToken !== intent.leaseToken) return "lease token changed"
  if (JSON.stringify(reference.scope) !== JSON.stringify(intent.scope)) return "scope changed"
  return undefined
}

function sessionEndpointMismatch(
  config: HarnessConfig,
  reference: SessionReference,
): string | undefined {
  if (reference.serverId !== config.serverId) return "server changed"
  if (reference.endpointAlias !== config.endpointAlias) return "endpoint changed"
  return undefined
}

function definitionHash(
  definition: RuntimeDefinition,
  inputJsonSchema: object,
  outputJsonSchema: object,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        ref: definition.ref,
        agent: definition.agent,
        model: definition.model,
        promptContract: definition.promptContract,
        timeoutMs: definition.timeoutMs,
        retryPolicy: definition.retryPolicy,
        maxInputBytes: definition.maxInputBytes,
        maxOutputBytes: definition.maxOutputBytes,
        inputSchema: inputJsonSchema,
        outputSchema: outputJsonSchema,
      }),
    )
    .digest("hex")
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (!hasOnlyStringProperties(value)) throw new Error("Canonical JSON cannot contain symbols")
  const record = value
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}

function hasOnlyStringProperties(value: object): value is Readonly<Record<string, unknown>> {
  return Object.getOwnPropertySymbols(value).length === 0
}
