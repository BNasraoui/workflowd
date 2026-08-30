import type { OpenCodeClient } from "@opencode-ai/client/effect"
import { AbsolutePath, Agent, Location, Model, Session } from "@opencode-ai/client/effect"
import { Data, DateTime, Effect, Filter, Option, Schema, Stream } from "effect"
import { JsonValueSchema, type JsonValue } from "../json"

export type OpenCodeModel = {
  readonly providerID: string
  readonly modelID: string
}

export type OpenCodeCreateSessionInput = {
  readonly directory: string
  readonly title: string
  readonly agent: string
  readonly model: OpenCodeModel
}

type OpenCodeSession = { readonly id: string }

export type OpenCodePromptSessionInput = {
  readonly sessionID: string
  readonly directory: string
  readonly agent: string
  readonly model: OpenCodeModel
  readonly text: string
}

type OpenCodeSessionInput = {
  readonly sessionID: string
  readonly directory: string
}

type OpenCodeSessionDirectoryInput = { readonly directory: string }
type OpenCodeSdkDirectoryInput = { readonly directory?: string }

export type OpenCodeSessionStatus =
  { readonly type: "busy" } | { readonly type: "retry" } | { readonly type: "idle" }

export type OpenCodeAssistantMessage = {
  readonly id?: string
  readonly role: "assistant"
  readonly time: { readonly created: number; readonly completed?: number }
  readonly error?: unknown
}

export type OpenCodeSessionEvent =
  | {
      readonly type: "message.updated"
      readonly sessionID: string
      readonly message: OpenCodeAssistantMessage
    }
  | {
      readonly type: "session.status"
      readonly sessionID: string
      readonly status: OpenCodeSessionStatus
    }
  | {
      readonly type: "session.error"
      readonly sessionID?: string
      readonly error?: unknown
    }

// The v2 wire feed is global; the seam narrows it to the transitions workflowd
// observes. `directory` carries the event's location so subscriptions can stay
// scoped to one working tree.
export type OpenCodeWireEvent =
  | {
      readonly type: "session.status"
      readonly sessionID: string
      readonly directory?: string
      readonly status: OpenCodeSessionStatus
    }
  | { readonly type: "session.idle"; readonly sessionID: string; readonly directory?: string }
  | {
      readonly type: "execution.succeeded"
      readonly sessionID: string
      readonly directory?: string
    }
  | {
      readonly type: "execution.failed"
      readonly sessionID: string
      readonly directory?: string
      readonly error?: unknown
    }
  | {
      readonly type: "execution.interrupted"
      readonly sessionID: string
      readonly directory?: string
    }

export type OpenCodeGenerateStructuredInput = {
  readonly sessionID: string
  readonly directory: string
  readonly jsonSchema: object
  readonly feedback?: string
}

type OpenCodeAvailabilityInput = {
  readonly directory?: string
  readonly agents: ReadonlyArray<string>
  readonly model: OpenCodeModel
}

type OpenCodeModelAvailability = {
  readonly providerID: string
  readonly id: string
}

type SdkCall<Input, Output> = (input: Input) => Effect.Effect<Output, Error>

export type OpenCodeSdkClient = {
  readonly createSession: SdkCall<OpenCodeCreateSessionInput, OpenCodeSession>
  readonly promptSession: SdkCall<
    {
      readonly sessionID: string
      readonly agent: string
      readonly model: OpenCodeModel
      readonly text: string
    },
    void
  >
  readonly subscribeEvents: () => Stream.Stream<OpenCodeWireEvent, Error>
  readonly activeSessions: SdkCall<void, ReadonlyArray<string>>
  readonly sessionOutcome: SdkCall<
    { readonly sessionID: string },
    { readonly id: string; readonly idle: boolean } | undefined
  >
  readonly listMessages: SdkCall<
    { readonly sessionID: string; readonly limit: number },
    ReadonlyArray<OpenCodeAssistantMessage>
  >
  readonly interruptSession: SdkCall<{ readonly sessionID: string }, boolean>
  readonly generateText: SdkCall<{ readonly sessionID: string; readonly prompt: string }, string>
  readonly listAgents: SdkCall<OpenCodeSdkDirectoryInput, ReadonlyArray<string>>
  readonly listModels: SdkCall<OpenCodeSdkDirectoryInput, ReadonlyArray<OpenCodeModelAvailability>>
}

export class OpenCodeAdapterError extends Data.TaggedError("OpenCodeAdapterError")<{
  readonly operation: string
  readonly cause: unknown
}> {
  override get message(): string {
    return `${this.operation}: ${toError(this.cause).message}`
  }
}

type AdapterCall<Input, Output> = (input: Input) => Effect.Effect<Output, OpenCodeAdapterError>

export type OpenCodeAdapter = {
  readonly createSession: AdapterCall<OpenCodeCreateSessionInput, OpenCodeSession>
  readonly promptSession: AdapterCall<OpenCodePromptSessionInput, void>
  readonly subscribeSessionEvents: (
    input: OpenCodeSessionDirectoryInput,
  ) => Stream.Stream<OpenCodeSessionEvent, OpenCodeAdapterError>
  readonly getSessionStatus: AdapterCall<OpenCodeSessionInput, OpenCodeSessionStatus | undefined>
  readonly sessionExists: AdapterCall<OpenCodeSessionInput, boolean>
  readonly listSessionMessages: AdapterCall<
    OpenCodeSessionInput,
    ReadonlyArray<OpenCodeAssistantMessage>
  >
  readonly abortSession: AdapterCall<OpenCodeSessionInput, boolean>
  readonly validateAvailability: AdapterCall<OpenCodeAvailabilityInput, void>
  readonly generateStructured: AdapterCall<OpenCodeGenerateStructuredInput, JsonValue>
}

const MESSAGE_LOOKUP_LIMIT = 20

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))

class OpenCodeAvailabilityError extends Error {
  readonly unavailable: ReadonlyArray<string>

  constructor(unavailable: ReadonlyArray<string>) {
    super(`Unavailable OpenCode integration: ${unavailable.join(", ")}`)
    this.name = "OpenCodeAvailabilityError"
    this.unavailable = unavailable
  }
}

class OpenCodeStructuredOutputError extends Error {
  constructor(message: string, options?: { readonly cause: unknown }) {
    super(message, options)
    this.name = "OpenCodeStructuredOutputError"
  }
}

function validateOpenCodeAvailability(
  requested: Pick<OpenCodeAvailabilityInput, "agents" | "model">,
  availableAgents: ReadonlyArray<string>,
  availableModels: ReadonlyArray<OpenCodeModelAvailability>,
): void {
  const agents = new Set(availableAgents)
  const unavailable = requested.agents
    .filter((agent) => !agents.has(agent))
    .map((agent) => `agent ${agent}`)
  const model = availableModels.find(
    (candidate) =>
      candidate.providerID === requested.model.providerID &&
      candidate.id === requested.model.modelID,
  )
  if (model === undefined) {
    unavailable.push(`model ${requested.model.providerID}/${requested.model.modelID}`)
  }
  if (unavailable.length > 0) {
    throw new OpenCodeAvailabilityError(unavailable)
  }
}

// The extraction request rides the session's own context through
// `session.generate`, which reads a preview of the transcript without writing
// to it. The working agent never sees this prompt, the schema, or any retry
// feedback.
export function structuredExtractionPrompt(jsonSchema: object, feedback?: string): string {
  const sections = [
    "Produce the final result of this session as a single JSON value that conforms to this JSON Schema:",
    JSON.stringify(jsonSchema),
    "Respond with the JSON value only. No prose, no code fences.",
  ]
  if (feedback !== undefined) {
    sections.push(`A previous attempt failed validation with: ${feedback}`)
  }
  return sections.join("\n")
}

function parseStructuredText(text: string): JsonValue {
  const trimmed = text.trim()
  const unfenced = trimmed.startsWith("```")
    ? trimmed
        .replace(/^```[a-zA-Z]*\r?\n/, "")
        .replace(/\r?\n```$/, "")
        .trim()
    : trimmed
  try {
    return Schema.decodeUnknownSync(JsonValueSchema)(JSON.parse(unfenced))
  } catch (cause) {
    throw new OpenCodeStructuredOutputError("Structured extraction did not return JSON", { cause })
  }
}

export class SdkOpenCodeAdapter implements OpenCodeAdapter {
  constructor(private readonly client: OpenCodeSdkClient) {}

  readonly createSession: OpenCodeAdapter["createSession"] = (input) =>
    this.call("create session", this.client.createSession(input))

  readonly promptSession: OpenCodeAdapter["promptSession"] = (input) =>
    this.call(
      "prompt session",
      this.client.promptSession({
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        text: input.text,
      }),
    )

  readonly subscribeSessionEvents: OpenCodeAdapter["subscribeSessionEvents"] = (input) =>
    this.client.subscribeEvents().pipe(
      Stream.filter(
        (event) => event.directory === undefined || event.directory === input.directory,
      ),
      Stream.mapError(
        (cause) => new OpenCodeAdapterError({ operation: "subscribe to session events", cause }),
      ),
      Stream.mapEffect((event) => this.normalizeWireEvent(event)),
      Stream.flatMap(Stream.fromIterable),
    )

  readonly getSessionStatus: OpenCodeAdapter["getSessionStatus"] = (input) =>
    this.call("get session status", this.client.activeSessions(undefined)).pipe(
      Effect.flatMap((active) =>
        active.includes(input.sessionID)
          ? Effect.succeed<OpenCodeSessionStatus | undefined>({ type: "busy" })
          : this.call(
              "get session status",
              this.client.sessionOutcome({ sessionID: input.sessionID }),
            ).pipe(
              Effect.map((session) =>
                session === undefined ? undefined : ({ type: "idle" } as const),
              ),
            ),
      ),
    )

  readonly sessionExists: OpenCodeAdapter["sessionExists"] = (input) =>
    this.call("probe session", this.client.sessionOutcome({ sessionID: input.sessionID })).pipe(
      Effect.map((session) => session !== undefined),
    )

  readonly listSessionMessages: OpenCodeAdapter["listSessionMessages"] = (input) =>
    this.call(
      "list session messages",
      this.client.listMessages({ sessionID: input.sessionID, limit: MESSAGE_LOOKUP_LIMIT }),
    )

  readonly abortSession: OpenCodeAdapter["abortSession"] = (input) =>
    this.call("abort session", this.client.interruptSession({ sessionID: input.sessionID }))

  readonly validateAvailability: OpenCodeAdapter["validateAvailability"] = (input) => {
    const parameters = input.directory === undefined ? {} : { directory: input.directory }
    return this.call(
      "validate OpenCode availability",
      Effect.all([this.client.listAgents(parameters), this.client.listModels(parameters)], {
        concurrency: 2,
      }).pipe(
        Effect.flatMap(([agents, models]) =>
          Effect.try({
            try: () => validateOpenCodeAvailability(input, agents, models),
            catch: toError,
          }),
        ),
      ),
    )
  }

  readonly generateStructured: OpenCodeAdapter["generateStructured"] = (input) =>
    this.call(
      "generate structured output",
      this.client
        .generateText({
          sessionID: input.sessionID,
          prompt: structuredExtractionPrompt(
            input.jsonSchema,
            ...(input.feedback === undefined ? [] : [input.feedback]),
          ),
        })
        .pipe(
          Effect.flatMap((text) =>
            Effect.try({ try: () => parseStructuredText(text), catch: toError }),
          ),
        ),
    )

  private normalizeWireEvent(
    event: OpenCodeWireEvent,
  ): Effect.Effect<ReadonlyArray<OpenCodeSessionEvent>, OpenCodeAdapterError> {
    switch (event.type) {
      case "session.status":
        return Effect.succeed([
          { type: "session.status", sessionID: event.sessionID, status: event.status },
        ])
      case "session.idle":
        return Effect.succeed([
          { type: "session.status", sessionID: event.sessionID, status: { type: "idle" } },
        ])
      case "execution.failed":
        return Effect.succeed([
          {
            type: "session.error",
            sessionID: event.sessionID,
            ...(event.error === undefined ? {} : { error: event.error }),
          },
        ])
      case "execution.interrupted":
        return Effect.succeed([
          {
            type: "session.error",
            sessionID: event.sessionID,
            error: new Error("OpenCode session was interrupted"),
          },
        ])
      case "execution.succeeded":
        // v2 has no event carrying the finished message, so surface the latest
        // completed assistant message to keep the v1-shaped answer signal.
        return this.call(
          "list session messages",
          this.client.listMessages({ sessionID: event.sessionID, limit: MESSAGE_LOOKUP_LIMIT }),
        ).pipe(
          Effect.map((messages) => {
            const completed = [...messages]
              .filter((message) => message.time.completed !== undefined)
              .sort((left, right) => right.time.created - left.time.created)[0]
            return completed === undefined
              ? [
                  {
                    type: "session.status" as const,
                    sessionID: event.sessionID,
                    status: { type: "idle" as const },
                  },
                ]
              : [
                  {
                    type: "message.updated" as const,
                    sessionID: event.sessionID,
                    message: completed,
                  },
                ]
          }),
        )
    }
  }

  private call<A>(
    operation: string,
    effect: Effect.Effect<A, Error>,
  ): Effect.Effect<A, OpenCodeAdapterError> {
    return Effect.mapError(effect, (cause) => new OpenCodeAdapterError({ operation, cause }))
  }
}

type RawTime = { readonly created?: unknown; readonly completed?: unknown }

function toEpochMillis(value: unknown): number | undefined {
  if (typeof value === "number") return value
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value)
  return undefined
}

function normalizeRawAssistantMessage(raw: {
  readonly id?: string
  readonly time?: RawTime
  readonly error?: unknown
}): OpenCodeAssistantMessage {
  const created = toEpochMillis(raw.time?.created) ?? 0
  const completed = toEpochMillis(raw.time?.completed)
  return {
    ...(raw.id === undefined ? {} : { id: raw.id }),
    role: "assistant",
    time: { created, ...(completed === undefined ? {} : { completed }) },
    ...(raw.error === undefined ? {} : { error: raw.error }),
  }
}

const toSessionID = (value: string) => Session.ID.make(value)
const toAgentID = (value: string) => Agent.ID.make(value)
const toModelRef = (model: OpenCodeModel) =>
  Model.Ref.make({
    id: Model.ID.make(model.modelID),
    providerID: Model.Ref.fields.providerID.make(model.providerID),
  })
const toLocationRef = (directory: string) =>
  Location.Ref.make({ directory: AbsolutePath.make(directory) })
const toLocationFilter = (directory: string | undefined) =>
  directory === undefined ? undefined : { location: { directory } }

const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  (cause as { readonly _tag: unknown })._tag === "SessionNotFoundError"

type WireEventData = {
  readonly sessionID?: unknown
  readonly status?: { readonly type?: unknown }
  readonly error?: unknown
}

export type RawWireEvent = {
  readonly type: string
  readonly location?: { readonly directory: string } | undefined
  readonly data: unknown
}

const wireEventFilter = Filter.fromPredicateOption((event: RawWireEvent) =>
  Option.fromUndefinedOr(toWireEvent(event)),
)

export function toWireEvent(event: RawWireEvent): OpenCodeWireEvent | undefined {
  const data = (event.data ?? {}) as WireEventData
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  if (sessionID === undefined) return undefined
  const directory = event.location?.directory
  const located = directory === undefined ? {} : { directory }
  switch (event.type) {
    case "session.status": {
      const statusType = data.status?.type
      if (statusType !== "busy" && statusType !== "retry" && statusType !== "idle") {
        return undefined
      }
      return { type: "session.status", sessionID, status: { type: statusType }, ...located }
    }
    case "session.idle":
      return { type: "session.idle", sessionID, ...located }
    case "session.execution.succeeded":
      return { type: "execution.succeeded", sessionID, ...located }
    case "session.execution.interrupted":
      return { type: "execution.interrupted", sessionID, ...located }
    case "session.execution.failed":
      return {
        type: "execution.failed",
        sessionID,
        ...(data.error === undefined ? {} : { error: data.error }),
        ...located,
      }
    default:
      return undefined
  }
}

export function makeOpenCodeSdkClient(
  clientEffect: Effect.Effect<OpenCodeClient, Error>,
): OpenCodeSdkClient {
  const withClient = <A>(
    run: (client: OpenCodeClient) => Effect.Effect<A, Error>,
  ): Effect.Effect<A, Error> => Effect.flatMap(clientEffect, run)
  return {
    createSession: (input) =>
      withClient((client) =>
        client.session
          .create({
            title: input.title,
            agent: toAgentID(input.agent),
            model: toModelRef(input.model),
            location: toLocationRef(input.directory),
          })
          .pipe(Effect.map((session) => ({ id: session.id }))),
      ),
    promptSession: (input) =>
      withClient((client) =>
        client.session
          .switchAgent({ sessionID: toSessionID(input.sessionID), agent: toAgentID(input.agent) })
          .pipe(
            Effect.andThen(
              client.session.switchModel({
                sessionID: toSessionID(input.sessionID),
                model: toModelRef(input.model),
              }),
            ),
            Effect.andThen(
              client.session.prompt({ sessionID: toSessionID(input.sessionID), text: input.text }),
            ),
            Effect.asVoid,
          ),
      ),
    subscribeEvents: () =>
      Stream.unwrap(
        Effect.map(clientEffect, (client) =>
          client.event
            .subscribe()
            .pipe(Stream.mapError(toError), Stream.filterMap(wireEventFilter)),
        ),
      ),
    activeSessions: () =>
      withClient((client) =>
        client.session.active().pipe(Effect.map((active) => Object.keys(active))),
      ),
    sessionOutcome: (input) =>
      withClient((client) =>
        client.session.get({ sessionID: toSessionID(input.sessionID) }).pipe(
          Effect.map((session): { readonly id: string; readonly idle: boolean } | undefined => ({
            id: session.id,
            idle: "time" in session && toEpochMillis(session.time.idle) !== undefined,
          })),
          Effect.catch((cause) =>
            isNotFound(cause) ? Effect.succeed(undefined) : Effect.fail(cause),
          ),
        ),
      ),
    listMessages: (input) =>
      withClient((client) =>
        client.message
          .list({ sessionID: toSessionID(input.sessionID), limit: input.limit, order: "desc" })
          .pipe(
            Effect.map((page) =>
              page.data
                .filter((message) => message.type === "assistant")
                .map(normalizeRawAssistantMessage),
            ),
          ),
      ),
    interruptSession: (input) =>
      withClient((client) =>
        client.session
          .interrupt({ sessionID: toSessionID(input.sessionID) })
          .pipe(Effect.map((outcome) => outcome.interrupted)),
      ),
    generateText: (input) =>
      withClient((client) =>
        client.session
          .generate({ sessionID: toSessionID(input.sessionID), prompt: input.prompt })
          .pipe(Effect.map((generated) => generated.text)),
      ),
    listAgents: (input) =>
      withClient((client) =>
        client.agent
          .list(toLocationFilter(input.directory))
          .pipe(Effect.map((agents) => agents.data.map((agent) => agent.name))),
      ),
    listModels: (input) =>
      withClient((client) =>
        client.model
          .list(toLocationFilter(input.directory))
          .pipe(
            Effect.map((models) =>
              models.data.map((model) => ({ providerID: model.providerID, id: model.id })),
            ),
          ),
      ),
  }
}
