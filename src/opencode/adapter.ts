import { agentGitEnvironment, type AgentGitConfig } from "../agent-git/config"
import { workerEnvironment } from "../resident/environment"
import { Data, Effect, Schema, Stream } from "effect"
import { JsonValueSchema, type JsonValue } from "../json"
import type { OpenCodeModelAvailability } from "./model-capabilities"
export { makeOpenCodeSdkClient, toWireEvent, type RawWireEvent } from "./sdk-client"
export type { OpenCodeModelAvailability } from "./model-capabilities"

export type OpenCodeModel = {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

export type OpenCodeCreateSessionInput = {
  readonly id?: string
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
  readonly delivery?: "queue"
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

/**
 * One live observation of a session's generation progress, read from
 * `session.get`. The token counters are the managed runner's progress
 * signal: first-token verification and no-progress wedge detection both
 * compare successive observations of `outputTokens`.
 */
export type OpenCodeSessionTelemetry = {
  /** Missing identity from a legacy provider is not native binding proof. */
  readonly sessionID?: string
  readonly directory: string
  readonly outputTokens: number
  readonly updatedAtMs: number
  readonly idle: boolean
  readonly outcome?: "succeeded" | "failed" | "interrupted"
  readonly finalMessage?: string | null
}

type SdkCall<Input, Output> = (input: Input) => Effect.Effect<Output, Error>

export type OpenCodeSdkClient = {
  readonly setSessionEnvironment: SdkCall<
    { readonly sessionID: string; readonly variables: Readonly<Record<string, string>> },
    void
  >
  readonly createSession: SdkCall<OpenCodeCreateSessionInput, OpenCodeSession>
  readonly promptSession: SdkCall<
    {
      readonly sessionID: string
      readonly agent: string
      readonly model: OpenCodeModel
      readonly text: string
      readonly delivery?: "queue"
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
  readonly listProviders: SdkCall<OpenCodeSdkDirectoryInput, ReadonlyArray<string>>
  readonly sessionTelemetry: SdkCall<
    { readonly sessionID: string },
    OpenCodeSessionTelemetry | undefined
  >
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
  readonly listProviders: AdapterCall<OpenCodeSdkDirectoryInput, ReadonlyArray<string>>
  readonly listModels: AdapterCall<
    OpenCodeSdkDirectoryInput,
    ReadonlyArray<OpenCodeModelAvailability>
  >
  readonly sessionTelemetry: AdapterCall<
    { readonly sessionID: string },
    OpenCodeSessionTelemetry | undefined
  >
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

class OpenCodeCatalogNotReadyError extends Error {
  constructor(agentCount: number, modelCount: number) {
    super(
      `OpenCode catalogs are empty (${agentCount} agents, ${modelCount} models); plugins may still be activating or no agents/providers may be configured for this location`,
    )
    this.name = "OpenCodeCatalogNotReadyError"
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
  // OpenCode lists are snapshots: a newly loaded (or idle-evicted) location
  // can answer before its plugins register agents and providers.
  if (availableAgents.length === 0 || availableModels.length === 0) {
    throw new OpenCodeCatalogNotReadyError(availableAgents.length, availableModels.length)
  }
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
  constructor(
    private readonly client: OpenCodeSdkClient,
    private readonly git?: AgentGitConfig,
    private readonly serverUrl?: string,
  ) {}

  readonly setSessionEnvironment = (input: {
    readonly sessionID: string
    readonly variables: Readonly<Record<string, string>>
  }) =>
    this.call(
      "set session environment",
      this.client.setSessionEnvironment({
        ...input,
        variables: { ...input.variables, ...agentGitEnvironment(this.git) },
      }),
    )

  readonly createSession: OpenCodeAdapter["createSession"] = (input) =>
    this.call("create session", this.client.createSession(input)).pipe(
      Effect.tap((session) =>
        this.git === undefined
          ? Effect.void
          : this.setSessionEnvironment({
              sessionID: session.id,
              variables: { ...workerEnvironment(), ...agentGitEnvironment(this.git) },
            }),
      ),
    )

  readonly promptSession: OpenCodeAdapter["promptSession"] = (input) =>
    this.call(
      "prompt session",
      this.client.promptSession({
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        text: input.text,
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
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
      Effect.suspend(() => {
        let agents: ReadonlyArray<string> | undefined
        let models: ReadonlyArray<OpenCodeModelAvailability> | undefined
        return Effect.all(
          [
            this.client.listAgents(parameters).pipe(
              Effect.tap((value) =>
                Effect.sync(() => {
                  agents = value
                }),
              ),
            ),
            this.client.listModels(parameters).pipe(
              Effect.tap((value) =>
                Effect.sync(() => {
                  models = value
                }),
              ),
            ),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.flatMap(([agents, models]) =>
            Effect.try({
              try: () => validateOpenCodeAvailability(input, agents, models),
              catch: toError,
            }),
          ),
          Effect.tapError(() =>
            Effect.logWarning("OpenCode availability check failed", {
              serverUrl: publicServerUrl(this.serverUrl),
              directory: input.directory ?? null,
              agentCount: agents?.length ?? null,
              modelCount: models?.length ?? null,
              agents: input.agents.map((name) => ({
                name,
                present: agents?.includes(name) ?? null,
              })),
              model: {
                name: `${input.model.providerID}/${input.model.modelID}`,
                present:
                  models?.some(
                    (model) =>
                      model.providerID === input.model.providerID &&
                      model.id === input.model.modelID,
                  ) ?? null,
              },
            }),
          ),
        )
      }),
    )
  }

  readonly listProviders: OpenCodeAdapter["listProviders"] = (input) =>
    this.call("list providers", this.client.listProviders(input))

  readonly listModels: OpenCodeAdapter["listModels"] = (input) =>
    this.call("list models", this.client.listModels(input))

  readonly sessionTelemetry: OpenCodeAdapter["sessionTelemetry"] = (input) =>
    this.call("read session telemetry", this.client.sessionTelemetry(input))

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

function publicServerUrl(value: string | undefined): string | null {
  if (value === undefined || !URL.canParse(value)) return null
  const url = new URL(value)
  return `${url.origin}${url.pathname}`
}
