import type { OpenCodeClient } from "@opencode-ai/client/effect"
import { AbsolutePath, Agent, Location, Model, Session } from "@opencode-ai/client/effect"
import { DateTime, Effect, Filter, Option, Stream } from "effect"
import { withCredentialAdmission } from "../agent-host/client"
import { publicOpenCodeModel } from "./model-capabilities"
import type {
  OpenCodeAssistantMessage,
  OpenCodeModel,
  OpenCodeSdkClient,
  OpenCodeWireEvent,
} from "./adapter"

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))

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
    ...(model.variant === undefined ? {} : { variant: Model.VariantID.make(model.variant) }),
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
  credentialSocket?: string,
): OpenCodeSdkClient {
  const withClient = <A>(
    run: (client: OpenCodeClient) => Effect.Effect<A, Error>,
  ): Effect.Effect<A, Error> => Effect.flatMap(clientEffect, run)
  const withCredentialClient = <A>(run: (client: OpenCodeClient) => Effect.Effect<A, Error>) =>
    withCredentialAdmission(credentialSocket, "opencode", withClient(run))
  return {
    setSessionEnvironment: (input) =>
      withClient((client) =>
        client.session.environment({
          sessionID: toSessionID(input.sessionID),
          variables: input.variables,
        }),
      ),
    createSession: (input) =>
      withCredentialClient((client) =>
        client.session
          .create({
            ...(input.id === undefined ? {} : { id: toSessionID(input.id) }),
            title: input.title,
            agent: toAgentID(input.agent),
            model: toModelRef(input.model),
            location: toLocationRef(input.directory),
          })
          .pipe(Effect.map((session) => ({ id: session.id }))),
      ),
    promptSession: (input) =>
      withCredentialClient((client) =>
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
              client.session.prompt({
                sessionID: toSessionID(input.sessionID),
                text: input.text,
                delivery: input.delivery,
              }),
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
      withCredentialClient((client) =>
        client.session
          .generate({ sessionID: toSessionID(input.sessionID), prompt: input.prompt })
          .pipe(Effect.map((generated) => generated.text)),
      ),
    listAgents: (input) =>
      withCredentialClient((client) =>
        client.agent
          .list(toLocationFilter(input.directory))
          .pipe(Effect.map((agents) => agents.data.map((agent) => agent.name))),
      ),
    listModels: (input) =>
      withCredentialClient((client) =>
        client.model
          .list(toLocationFilter(input.directory))
          .pipe(Effect.map((models) => models.data.map(publicOpenCodeModel))),
      ),
    // `provider.list` returns only providers the server has configured with
    // credentials, so membership here is the authentication pre-flight; the
    // model catalog alone cannot distinguish an authenticated route from a
    // catalogued one.
    listProviders: (input) =>
      withCredentialClient((client) =>
        client.provider
          .list(toLocationFilter(input.directory))
          .pipe(Effect.map((providers) => providers.data.map((provider) => String(provider.id)))),
      ),
    sessionTelemetry: (input) =>
      withClient((client) =>
        client.session.get({ sessionID: toSessionID(input.sessionID) }).pipe(
          Effect.flatMap((session) =>
            Effect.gen(function* () {
              let idle = toEpochMillis(session.time.idle) !== undefined
              if (idle) {
                const queued = yield* client.session.inbox.list({
                  sessionID: toSessionID(input.sessionID),
                })
                if (queued.length > 0) idle = false
                else {
                  // A queued prompt can start while the inbox request is in flight.
                  session = yield* client.session.get({ sessionID: toSessionID(input.sessionID) })
                  idle = toEpochMillis(session.time.idle) !== undefined
                }
              }
              let outputTokens = session.tokens.output + session.tokens.reasoning
              let finalMessage: string | null = null
              // Session totals settle at execution end. Streamed assistant steps
              // already prove generation while the worker is still using tools.
              if (idle || outputTokens === 0) {
                const messages = yield* client.message.list({
                  sessionID: toSessionID(input.sessionID),
                  limit: 20,
                  order: "desc",
                })
                for (const message of messages.data) {
                  if (!idle) {
                    if (message.type === "assistant" && message.tokens !== undefined)
                      outputTokens += message.tokens.output + message.tokens.reasoning
                    continue
                  }
                  // Do not reuse a reply from before the latest user turn.
                  if (message.type === "user") break
                  if (message.type !== "assistant") continue
                  const text = message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
                  if (text.trim() !== "") {
                    finalMessage = text
                    break
                  }
                }
              }
              return {
                directory: session.location.directory,
                outputTokens,
                updatedAtMs: toEpochMillis(session.time.updated) ?? 0,
                idle,
                ...(idle ? { finalMessage } : {}),
                ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
              }
            }),
          ),
          Effect.catch((cause) =>
            isNotFound(cause) ? Effect.succeed(undefined) : Effect.fail(cause),
          ),
        ),
      ),
  }
}
