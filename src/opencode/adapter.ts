import type {
  AssistantMessage,
  Event,
  OpencodeClient,
  SessionStatus,
} from "@opencode-ai/sdk/v2/client"

export type OpenCodeModel = { readonly providerID: string; readonly modelID: string }

type OpenCodeCreateSessionInput = { readonly directory: string; readonly title: string }

type OpenCodeSession = { readonly id: string }

export type OpenCodePromptSessionInput = {
  readonly sessionID: string
  readonly directory: string
  readonly agent: string
  readonly model: OpenCodeModel
  readonly format: {
    readonly type: "json_schema"
    readonly schema: object
    readonly retryCount: number
  }
  readonly parts: ReadonlyArray<{
    readonly type: "text"
    readonly text: string
  }>
}

type OpenCodeSessionInput = { readonly sessionID: string; readonly directory: string }

type OpenCodeSessionDirectoryInput = { readonly directory: string }
type OpenCodeSdkDirectoryInput = { readonly directory?: string }

type OpenCodeAssistantMessage = {
  readonly role: AssistantMessage["role"]
  readonly time: AssistantMessage["time"]
  readonly structured?: AssistantMessage["structured"]
  readonly error?: AssistantMessage["error"]
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
      readonly status: SessionStatus
    }
  | {
      readonly type: "session.error"
      readonly sessionID?: string
      readonly error?: AssistantMessage["error"]
    }

type OpenCodeAvailabilityInput = { readonly directory?: string; readonly agents: ReadonlyArray<string>; readonly model: OpenCodeModel }

type OpenCodeProviderAvailability = { readonly id: string; readonly modelIDs: ReadonlyArray<string> }
type AdapterCall<Input, Output> = (input: Input, signal: AbortSignal) => Promise<Output>

export type OpenCodeSdkClient = {
  readonly createSession: AdapterCall<OpenCodeCreateSessionInput, OpenCodeSession>
  readonly promptSession: AdapterCall<OpenCodePromptSessionInput, void>
  readonly subscribeEvents: AdapterCall<OpenCodeSessionDirectoryInput, AsyncIterable<Event>>
  readonly getSessionStatuses: AdapterCall<
    OpenCodeSessionDirectoryInput,
    Readonly<Record<string, SessionStatus | undefined>>
  >
  readonly listSessionMessages: AdapterCall<
    OpenCodeSessionInput,
    ReadonlyArray<AssistantMessage>
  >
  readonly abortSession: AdapterCall<OpenCodeSessionInput, boolean>
  readonly listAgents: AdapterCall<OpenCodeSdkDirectoryInput, ReadonlyArray<string>>
  readonly listProviders: AdapterCall<
    OpenCodeSdkDirectoryInput,
    ReadonlyArray<OpenCodeProviderAvailability>
  >
}

export type OpenCodeAdapter = {
  readonly createSession: AdapterCall<OpenCodeCreateSessionInput, OpenCodeSession>
  readonly promptSession: AdapterCall<OpenCodePromptSessionInput, void>
  readonly subscribeSessionEvents: AdapterCall<OpenCodeSessionDirectoryInput, AsyncIterable<OpenCodeSessionEvent>>
  readonly getSessionStatus: AdapterCall<OpenCodeSessionInput, SessionStatus | undefined>
  readonly listSessionMessages: AdapterCall<OpenCodeSessionInput, ReadonlyArray<OpenCodeAssistantMessage>>
  readonly abortSession: AdapterCall<OpenCodeSessionInput, boolean>
  readonly validateAvailability: AdapterCall<OpenCodeAvailabilityInput, void>
}

class OpenCodeAvailabilityError extends Error {
  readonly unavailable: ReadonlyArray<string>

  constructor(unavailable: ReadonlyArray<string>) {
    super(`Unavailable OpenCode integration: ${unavailable.join(", ")}`)
    this.name = "OpenCodeAvailabilityError"
    this.unavailable = unavailable
  }
}

function validateOpenCodeAvailability(
  requested: Pick<OpenCodeAvailabilityInput, "agents" | "model">,
  availableAgents: ReadonlyArray<string>,
  availableProviders: ReadonlyArray<OpenCodeProviderAvailability>,
): void {
  const agents = new Set(availableAgents)
  const unavailable = requested.agents
    .filter((agent) => !agents.has(agent))
    .map((agent) => `agent ${agent}`)
  const provider = availableProviders.find(
    (candidate) => candidate.id === requested.model.providerID,
  )
  if (
    provider === undefined ||
    !provider.modelIDs.includes(requested.model.modelID)
  ) {
    unavailable.push(
      `model ${requested.model.providerID}/${requested.model.modelID}`,
    )
  }
  if (unavailable.length > 0) {
    throw new OpenCodeAvailabilityError(unavailable)
  }
}

export class SdkOpenCodeAdapter implements OpenCodeAdapter {
  constructor(private readonly client: OpenCodeSdkClient) {}

  async createSession(
    input: OpenCodeCreateSessionInput,
    signal: AbortSignal,
  ): Promise<OpenCodeSession> {
    return this.client.createSession(input, signal)
  }

  async promptSession(
    input: OpenCodePromptSessionInput,
    signal: AbortSignal,
  ): Promise<void> {
    await this.client.promptSession(input, signal)
  }

  async subscribeSessionEvents(
    input: OpenCodeSessionDirectoryInput,
    signal: AbortSignal,
  ): Promise<AsyncIterable<OpenCodeSessionEvent>> {
    return normalizeEvents(await this.client.subscribeEvents(input, signal))
  }

  async getSessionStatus(
    input: OpenCodeSessionInput,
    signal: AbortSignal,
  ): Promise<SessionStatus | undefined> {
    const statuses = await this.client.getSessionStatuses(
      { directory: input.directory },
      signal,
    )
    return statuses[input.sessionID]
  }

  async listSessionMessages(
    input: OpenCodeSessionInput,
    signal: AbortSignal,
  ): Promise<ReadonlyArray<OpenCodeAssistantMessage>> {
    return (await this.client.listSessionMessages(input, signal)).map(
      normalizeAssistantMessage,
    )
  }

  async abortSession(
    input: OpenCodeSessionInput,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.client.abortSession(input, signal)
  }

  async validateAvailability(
    input: OpenCodeAvailabilityInput,
    signal: AbortSignal,
  ): Promise<void> {
    const parameters =
      input.directory === undefined ? {} : { directory: input.directory }
    const [agents, providers] = await Promise.all([
      this.client.listAgents(parameters, signal),
      this.client.listProviders(parameters, signal),
    ])
    validateOpenCodeAvailability(input, agents, providers)
  }
}

export function makeOpenCodeSdkClient(client: OpencodeClient): OpenCodeSdkClient {
  return {
    createSession: async (input, signal) => {
      const response = await client.session.create<true>(input, {
        signal,
        throwOnError: true,
      })
      return { id: response.data.id }
    },
    promptSession: async (input, signal) => {
      await client.session.promptAsync<true>(
        {
          ...input,
          format: {
            ...input.format,
            schema: Object.fromEntries(Object.entries(input.format.schema)),
          },
          parts: [...input.parts],
        },
        { signal, throwOnError: true },
      )
    },
    subscribeEvents: async (input, signal) => {
      const subscription = await client.event.subscribe<true>(input, {
        signal,
        throwOnError: true,
        sseMaxRetryAttempts: 3,
      })
      return subscription.stream
    },
    getSessionStatuses: async (input, signal) => {
      const response = await client.session.status<true>(input, {
        signal,
        throwOnError: true,
      })
      return response.data
    },
    listSessionMessages: async (input, signal) => {
      const response = await client.session.messages<true>(
        { ...input, limit: 20 },
        { signal, throwOnError: true },
      )
      const messages: Array<AssistantMessage> = []
      for (const message of response.data) {
        if (message.info.role === "assistant") messages.push(message.info)
      }
      return messages
    },
    abortSession: async (input, signal) => {
      const response = await client.session.abort<true>(input, {
        signal,
        throwOnError: true,
      })
      return response.data
    },
    listAgents: async (input, signal) => {
      const response = await client.app.agents<true>(input, {
        signal,
        throwOnError: true,
      })
      return response.data.map((agent) => agent.name)
    },
    listProviders: async (input, signal) => {
      const response = await client.config.providers<true>(input, {
        signal,
        throwOnError: true,
      })
      return response.data.providers.map((provider) => ({
        id: provider.id,
        modelIDs: Object.keys(provider.models),
      }))
    },
  }
}

function normalizeAssistantMessage(
  message: AssistantMessage,
): OpenCodeAssistantMessage {
  return {
    role: message.role,
    time: message.time,
    ...(message.structured === undefined
      ? {}
      : { structured: message.structured }),
    ...(message.error === undefined ? {} : { error: message.error }),
  }
}

async function* normalizeEvents(
  stream: AsyncIterable<Event>,
): AsyncIterable<OpenCodeSessionEvent> {
  for await (const event of stream) {
    switch (event.type) {
      case "message.updated":
        if (event.properties.info.role === "assistant") {
          yield {
            type: "message.updated",
            sessionID: event.properties.sessionID,
            message: normalizeAssistantMessage(event.properties.info),
          }
        }
        break
      case "session.status":
        yield {
          type: "session.status",
          sessionID: event.properties.sessionID,
          status: event.properties.status,
        }
        break
      case "session.idle":
        yield {
          type: "session.status",
          sessionID: event.properties.sessionID,
          status: { type: "idle" },
        }
        break
      case "session.error":
        yield {
          type: "session.error",
          ...(event.properties.sessionID === undefined
            ? {}
            : { sessionID: event.properties.sessionID }),
          ...(event.properties.error === undefined
            ? {}
            : { error: event.properties.error }),
        }
        break
    }
  }
}
