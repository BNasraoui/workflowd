import { Option, Stream } from "effect"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type {
  AgentListInput,
  AgentListOutput,
  ModelListInput,
  ModelListOutput,
  OpenCodeClient,
  SessionActive,
  SessionInfo,
  SessionInterruptResponse,
  SessionMessageAssistant,
  SessionMessagesResponse,
} from "@opencode-ai/client"
import { ClientError } from "@opencode-ai/client"
import {
  type OpenCodeAdapter,
  type OpenCodeAssistantMessage,
  type OpenCodeAvailabilityInput,
  type OpenCodeCreateSessionInput,
  type OpenCodeMessageError,
  type OpenCodePromptSessionInput,
  type OpenCodeSession,
  type OpenCodeSessionEvent,
  type OpenCodeSessionInput,
  type OpenCodeProviderAvailability,
  validateOpenCodeAvailability,
} from "./adapter"

/**
 * Narrow view of the @opencode-ai/client promise surface used by the v2
 * adapter, so tests can fake the client without the full API object.
 */
export type OpenCodeV2Client = {
  readonly session: {
    readonly create: (
      input: {
        readonly title?: string
        readonly agent?: string
        readonly model?: { readonly id: string; readonly providerID: string }
        readonly location: { readonly directory: string }
      },
      options?: { readonly signal?: AbortSignal },
    ) => Promise<SessionInfo>
    readonly active: (options?: {
      readonly signal?: AbortSignal
    }) => Promise<Record<string, SessionActive>>
    readonly get: (
      input: { readonly sessionID: string },
      options?: { readonly signal?: AbortSignal },
    ) => Promise<SessionInfo>
    readonly prompt: (
      input: {
        readonly sessionID: string
        readonly text: string
        readonly delivery?: "steer" | "queue"
      },
      options?: { readonly signal?: AbortSignal },
    ) => Promise<unknown>
    readonly interrupt: (
      input: { readonly sessionID: string },
      options?: { readonly signal?: AbortSignal },
    ) => Promise<SessionInterruptResponse>
  }
  readonly message: {
    readonly list: (
      input: { readonly sessionID: string; readonly limit?: number },
      options?: { readonly signal?: AbortSignal },
    ) => Promise<SessionMessagesResponse>
  }
  readonly agent: {
    readonly list: (
      input?: AgentListInput,
      options?: { readonly signal?: AbortSignal },
    ) => Promise<AgentListOutput>
  }
  readonly model: {
    readonly list: (
      input?: ModelListInput,
      options?: { readonly signal?: AbortSignal },
    ) => Promise<ModelListOutput>
  }
  readonly event: {
    // v2 event frames are untrusted JSON on the wire (the published client
    // types lag the dev-line encoding); normalization validates them.
    readonly subscribe: (options?: { readonly signal?: AbortSignal }) => AsyncIterable<unknown>
  }
}

export function makeOpenCodeV2Client(
  client: OpenCodeClient,
  transport: { readonly baseUrl: string; readonly headers: Record<string, string> },
): OpenCodeV2Client {
  return {
    ...client,
    session: {
      ...client.session,
      // TODO(opencode-v2-client-drift): today's v2-line dev server (verified
      // against opencode 0.0.0-dev-202608300437) requires the prompt payload
      // to be nested as `{ prompt: { text } }`, while every published
      // @opencode-ai/client build (beta 18684 and dev 18693) still serializes
      // the older flat `{ text }` shape that the server rejects with
      // InvalidRequestError "Missing key [\"prompt\"]". Bridge that one
      // endpoint with a direct fetch until the published client catches up,
      // then drop this override and call client.session.prompt directly.
      prompt: async (input, options) => {
        const url = new URL(
          `api/session/${encodeURIComponent(input.sessionID)}/prompt`,
          transport.baseUrl,
        )
        const response = await fetch(url, {
          method: "POST",
          headers: { ...transport.headers, "content-type": "application/json" },
          signal: options?.signal ?? null,
          body: JSON.stringify({
            prompt: { text: input.text },
            ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
          }),
        })
        if (response.status !== 200) {
          const body = await response.text().catch(() => "")
          throw new ClientError("UnexpectedStatus", {
            cause: { status: response.status, body },
          })
        }
        return response.json()
      },
      // TODO(opencode-v2-client-drift): same drift as the prompt override —
      // the v2-line dev server answers POST .../interrupt with 204 No Content
      // while the published client declares 200 + `{ interrupted }`. Accept
      // both; a 204 ack counts as a confirmed interrupt.
      interrupt: async (input, options) => {
        const url = new URL(
          `api/session/${encodeURIComponent(input.sessionID)}/interrupt`,
          transport.baseUrl,
        )
        const response = await fetch(url, {
          method: "POST",
          headers: transport.headers,
          signal: options?.signal ?? null,
        })
        if (response.status !== 204 && response.status !== 200) {
          throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
        }
        if (response.status === 204) return { interrupted: true }
        const body = readRecord(await response.json().catch(() => undefined))
        return body !== undefined && readBoolean(body, "interrupted")
          ? { interrupted: false }
          : { interrupted: true }
      },
    },
  }
}

export class ClientOpenCodeAdapter implements OpenCodeAdapter {
  constructor(private readonly client: OpenCodeV2Client) {}

  async createSession(
    input: OpenCodeCreateSessionInput,
    signal: AbortSignal,
  ): Promise<OpenCodeSession> {
    const info = await this.client.session.create(
      {
        title: input.title,
        // v2 binds the agent and model to the session instead of the prompt.
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined
          ? {}
          : { model: { id: input.model.modelID, providerID: input.model.providerID } }),
        location: { directory: input.directory },
      },
      { signal },
    )
    return { id: info.id }
  }

  async promptSession(input: OpenCodePromptSessionInput, signal: AbortSignal): Promise<void> {
    await this.client.session.prompt(
      {
        sessionID: input.sessionID,
        // TODO(opencode-v2-structured-output): the v2 API has no equivalent of
        // the v1 `format: { type: "json_schema", schema, retryCount }` prompt
        // field. Prompt metadata is free-form pass-through and the generate
        // endpoints return plain text only, so the schema is requested via
        // plain prompting below. Invalid output still flows through the
        // existing retry loop (structuredOutputRetryCount / invalidOutput
        // "retry") because the structured payload fails to decode. Revisit
        // once the v2 server grows a structured-output contract.
        text: withStructuredOutputInstruction(input.parts, input.format),
        // "queue" mirrors the v1 prompt_async dispatch semantics: the prompt
        // is accepted immediately and executes when the session is free.
        delivery: "queue",
      },
      { signal },
    )
  }

  subscribeSessionEvents(
    input: { readonly directory: string },
    signal: AbortSignal,
  ): Promise<AsyncIterable<OpenCodeSessionEvent>> {
    return Promise.resolve(
      normalizeV2Events(
        (subscriptionSignal) => this.client.event.subscribe({ signal: subscriptionSignal }),
        signal,
      ),
    )
  }

  async getSessionStatus(
    input: OpenCodeSessionInput,
    signal: AbortSignal,
  ): Promise<SessionStatus | undefined> {
    const active = await this.client.session.active({ signal })
    // v2 replaces GET /session/status with GET /api/session/active, which only
    // lists currently running sessions. Everything else maps to idle, which is
    // what the v1 status lifecycle reports for a session that finished its
    // turn; the structured session reacts to idle by listing messages.
    return active[input.sessionID] === undefined ? { type: "idle" } : { type: "busy" }
  }

  async sessionExists(input: OpenCodeSessionInput, signal: AbortSignal): Promise<boolean> {
    try {
      await this.client.session.get({ sessionID: input.sessionID }, { signal })
      return true
    } catch (cause) {
      if (hasErrorTag(cause, "SessionNotFoundError")) return false
      if (cause instanceof ClientError && cause.reason === "UnexpectedStatus") {
        const status = errorStatus(cause)
        throw new Error(`OpenCode session probe failed with HTTP ${String(status)}`, { cause })
      }
      throw cause
    }
  }

  async listSessionMessages(
    input: OpenCodeSessionInput,
    signal: AbortSignal,
  ): Promise<ReadonlyArray<OpenCodeAssistantMessage>> {
    const response = await this.client.message.list(
      { sessionID: input.sessionID, limit: 20 },
      { signal },
    )
    return response.data
      .filter((message): message is SessionMessageAssistant => message.type === "assistant")
      .map(normalizeV2AssistantMessage)
  }

  async abortSession(input: OpenCodeSessionInput, signal: AbortSignal): Promise<boolean> {
    const response = await this.client.session.interrupt({ sessionID: input.sessionID }, { signal })
    return response.interrupted
  }

  async validateAvailability(input: OpenCodeAvailabilityInput, signal: AbortSignal): Promise<void> {
    const parameters =
      input.directory === undefined ? {} : { location: { directory: input.directory } }
    const [agents, models] = await Promise.all([
      this.client.agent.list(parameters, { signal }),
      this.client.model.list(parameters, { signal }),
    ])
    const modelIDsByProvider = new Map<string, Array<string>>()
    for (const model of models.data) {
      // v2-line dev builds serve the model id as `id`; the beta client types
      // declare `modelID`. Accept either so the cutover survives minor drift.
      const modelID = model.modelID ?? model.id
      const bucket = modelIDsByProvider.get(model.providerID)
      if (bucket === undefined) modelIDsByProvider.set(model.providerID, [modelID])
      else bucket.push(modelID)
    }
    const providers: Array<OpenCodeProviderAvailability> = [...modelIDsByProvider.entries()].map(
      ([id, modelIDs]) => ({ id, modelIDs }),
    )
    validateOpenCodeAvailability(
      input,
      // Same drift story as the model id above: dev builds omit `name` and
      // serve the agent identifier as `id` only.
      agents.data.map((agent) => agent.name ?? agent.id),
      providers,
    )
  }
}

function withStructuredOutputInstruction(
  parts: OpenCodePromptSessionInput["parts"],
  format: OpenCodePromptSessionInput["format"],
): string {
  const text = parts.map((part) => part.text).join("\n")
  return [
    text,
    "",
    "Respond with exactly one JSON value and nothing else.",
    "Do not wrap it in prose, markdown, or code fences.",
    `The value must validate against this JSON Schema: ${JSON.stringify(format.schema)}`,
  ].join("\n")
}

// TODO(opencode-v2-structured-output): v2 assistant messages carry no
// `structured` field, so the JSON payload requested via plain prompting is
// recovered from the assistant text. Remove this extraction once the v2 API
// grows a first-class structured output contract.
export function extractStructuredPayload(text: string): unknown {
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim())
  const firstValue = trimmed.search(/[[{]/)
  if (firstValue > 0) candidates.push(trimmed.slice(firstValue))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      continue
    }
  }
  return undefined
}

function normalizeV2AssistantMessage(message: SessionMessageAssistant): OpenCodeAssistantMessage {
  const text = message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const structured =
    message.error === undefined && message.time.completed !== undefined
      ? extractStructuredPayload(text)
      : undefined
  return {
    id: message.id,
    role: "assistant",
    time: {
      created: message.time.created,
      ...(message.time.completed === undefined ? {} : { completed: message.time.completed }),
    },
    ...(structured === undefined ? {} : { structured }),
    ...(message.error === undefined ? {} : { error: message.error }),
  }
}

// The v2 event wire format drifted between the published beta client (which
// mirrors openapi.json: session.status / session.idle / session.execution.failed
// / session.message.content.updated) and the v2-line dev builds actually cut
// over to, which re-encode everything as session.next.* events (verified
// against opencode 0.0.0-dev-202608300437). The normalizer therefore treats
// frames as untrusted JSON and maps both encodings into the internal union.
function normalizeV2Event(event: unknown): OpenCodeSessionEvent | undefined {
  const wire = readRecord(event)
  if (wire === undefined) return undefined
  const type = readString(wire, "type")
  const data = readRecord(wire["data"])
  if (type === undefined || data === undefined) return undefined
  const sessionID = readString(data, "sessionID")
  const timestamp = readNumber(data, "timestamp") ?? readNumber(wire, "created")

  if (type.startsWith("session.next.")) {
    return normalizeDevLineEvent(type, data, sessionID, timestamp)
  }
  return normalizeSpecEvent(type, data, sessionID, timestamp)
}

function normalizeDevLineEvent(
  type: string,
  data: Readonly<Record<string, unknown>>,
  sessionID: string | undefined,
  timestamp: number | undefined,
): OpenCodeSessionEvent | undefined {
  switch (type) {
    case "session.next.step.started":
      return sessionID === undefined
        ? undefined
        : { type: "session.status", sessionID, status: { type: "busy" } }
    case "session.next.step.ended":
      return sessionID === undefined
        ? undefined
        : { type: "session.status", sessionID, status: { type: "idle" } }
    case "session.next.step.failed": {
      const error = readMessageError(data["error"])
      if (sessionID === undefined || error === undefined) return undefined
      return { type: "session.error", sessionID, error }
    }
    case "session.next.text.ended":
      return sessionID === undefined ? undefined : terminalTextMessage(data, sessionID, timestamp)
    default:
      return undefined
  }
}

function normalizeSpecEvent(
  type: string,
  data: Readonly<Record<string, unknown>>,
  sessionID: string | undefined,
  timestamp: number | undefined,
): OpenCodeSessionEvent | undefined {
  switch (type) {
    case "session.message.content.updated": {
      // Message updates arrive as content diffs without a completion time, so
      // they never settle a structured session on their own; terminal
      // detection falls back to the idle event plus message listing, matching
      // the v1 status fallback path.
      if (sessionID === undefined) return undefined
      const messageID = readString(data, "messageID")
      return {
        type: "message.updated",
        sessionID,
        message: {
          ...(messageID === undefined ? {} : { id: messageID }),
          role: "assistant",
          time: { created: timestamp ?? 0 },
        },
      }
    }
    case "session.status": {
      const status = readStatus(data["status"])
      if (sessionID === undefined || status === undefined) return undefined
      return { type: "session.status", sessionID, status }
    }
    case "session.idle":
      return sessionID === undefined
        ? undefined
        : { type: "session.status", sessionID, status: { type: "idle" } }
    case "session.execution.failed": {
      const error = readMessageError(data["error"])
      if (sessionID === undefined || error === undefined) return undefined
      return { type: "session.error", sessionID, error }
    }
    default:
      return undefined
  }
}

function terminalTextMessage(
  data: Readonly<Record<string, unknown>>,
  sessionID: string,
  timestamp: number | undefined,
): OpenCodeSessionEvent {
  // The finished assistant text: expose it as a message.updated candidate
  // with the structured payload recovered from the text so the structured
  // session can settle immediately; without a parsable payload the message
  // carries no completion time and terminal detection falls back to the
  // status/message-listing path.
  const text = readString(data, "text")
  const structured = text === undefined ? undefined : extractStructuredPayload(text)
  const messageID = readString(data, "assistantMessageID")
  return {
    type: "message.updated",
    sessionID,
    message: {
      ...(messageID === undefined ? {} : { id: messageID }),
      role: "assistant",
      time: {
        created: timestamp ?? 0,
        ...(structured === undefined ? {} : { completed: timestamp ?? 0 }),
      },
      ...(structured === undefined ? {} : { structured }),
    },
  }
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null) return undefined
  return Object.fromEntries(Object.entries(value))
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function readNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key]
  return typeof value === "number" ? value : undefined
}

function readBoolean(record: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === "boolean" ? value : undefined
}

function readMessageError(value: unknown): OpenCodeMessageError | undefined {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const type = readString(record, "type")
  const message = readString(record, "message")
  if (type !== undefined && message !== undefined) return { type, message }
  // v1-style `{ name, data: { message } }` provider errors, defensively.
  const name = readString(record, "name")
  const nested = readRecord(record["data"])
  const nestedMessage = nested === undefined ? undefined : readString(nested, "message")
  if (name !== undefined && nestedMessage !== undefined) return { name, message: nestedMessage }
  return undefined
}

function readStatus(value: unknown): SessionStatus | undefined {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const type = readString(record, "type")
  if (type === "idle") return { type: "idle" }
  if (type === "busy") return { type: "busy" }
  if (type === "retry") {
    const attempt = readNumber(record, "attempt")
    const message = readString(record, "message")
    const next = readNumber(record, "next")
    if (attempt !== undefined && message !== undefined && next !== undefined) {
      return { type: "retry", attempt, message, next }
    }
  }
  return undefined
}

async function* normalizeV2Events(
  subscribe: (signal: AbortSignal) => AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncIterable<OpenCodeSessionEvent> {
  const controller = new AbortController()
  const interrupt = () => controller.abort(signal.reason)
  if (signal.aborted) interrupt()
  else signal.addEventListener("abort", interrupt, { once: true })

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    signal.removeEventListener("abort", interrupt)
    controller.abort()
  }

  const events = Stream.fromAsyncIterable(subscribe(controller.signal), (cause) =>
    cause instanceof Error ? cause : new Error(String(cause)),
  ).pipe(Stream.filterMap((event) => Option.fromNullable(normalizeV2Event(event))))

  const iterator = Stream.toAsyncIterable(events)[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      yield next.value
    }
  } finally {
    cleanup()
    await iterator.return?.()
  }
}

function hasErrorTag(cause: unknown, tag: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    (cause as { readonly _tag: unknown })._tag === tag
  )
}

function errorStatus(cause: ClientError): unknown {
  const inner = cause.cause
  if (typeof inner !== "object" || inner === null || !("status" in inner)) return undefined
  return inner.status
}
