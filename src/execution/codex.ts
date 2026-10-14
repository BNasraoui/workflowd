import {
  withCredentialAdmissionPromise,
  startAgentHost,
  readAgentHostOutput,
  requestAgentHost,
} from "../agent-host/client"
import { Schema } from "effect"
import type { DiscoverySource, ExecutionModel } from "../execution-capabilities"
import { RpcRequestError } from "../resident/rpc"
import { startCodexDiscovery } from "./codex-process"

// Verified against codex-cli 0.159.1 `app-server generate-ts` native v2 bindings.
// Effort names are provider-defined strings in that contract, not a workflowd enum.
const ModelPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      model: Schema.String,
      displayName: Schema.String,
      supportedReasoningEfforts: Schema.Array(
        Schema.Struct({ reasoningEffort: Schema.String, description: Schema.String }),
      ),
      defaultReasoningEffort: Schema.String,
      inputModalities: Schema.Array(Schema.String),
      isDefault: Schema.Boolean,
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
})
const Config = Schema.Struct({
  config: Schema.Struct({ model_provider: Schema.NullOr(Schema.String) }),
})
const Account = Schema.Struct({
  account: Schema.NullOr(Schema.Unknown),
  requiresOpenaiAuth: Schema.Boolean,
})

export function makeCodexDiscovery(
  executor: string,
  options: {
    readonly command: ReadonlyArray<string>
    readonly home?: string
    readonly credentialSocket?: string | undefined
  },
): DiscoverySource {
  return {
    executor,
    kind: "codex",
    protocol: "codex-app-server/model/list",
    discover: (signal) =>
      options.credentialSocket === undefined
        ? withCredentialAdmissionPromise(options.credentialSocket, "codex", async () => {
            const server = startCodexDiscovery(options.command, options.home, signal)
            try {
              await server.initialize()
              const config = Schema.decodeUnknownSync(Config)(
                await server.request("config/read", { includeLayers: false }),
              )
              const account = Schema.decodeUnknownSync(Account)(
                await server.request("account/read", { refreshToken: false }),
              )
              if (account.requiresOpenaiAuth && account.account === null)
                return { status: "unauthenticated" }
              const models: ExecutionModel[] = []
              let cursor: string | null = null
              const cursors = new Set<string>()
              do {
                const page = Schema.decodeUnknownSync(ModelPage)(
                  await server.request("model/list", { cursor, limit: 100, includeHidden: true }),
                )
                models.push(
                  ...page.data.map((model) => ({
                    provider: config.config.model_provider,
                    model: model.model,
                    selectionModel: model.id,
                    name: model.displayName,
                    efforts: model.supportedReasoningEfforts.map((effort) => ({
                      id: effort.reasoningEffort,
                      description: effort.description,
                    })),
                    defaultEffort: model.defaultReasoningEffort,
                    defaultModel: model.isDefault,
                    modalities: { input: model.inputModalities },
                    // The native model/list may use a bundled catalog. Authentication
                    // and advertisement are observations, not per-model entitlement proof.
                    availability: "unknown" as const,
                  })),
                )
                cursor = page.nextCursor
                if (cursor !== null) {
                  if (cursors.has(cursor) || cursors.size >= 100)
                    throw new Error("Invalid Codex catalog pagination")
                  cursors.add(cursor)
                }
              } while (cursor !== null)
              return models
            } catch (error) {
              if (
                (error instanceof RpcRequestError && error.code === -32601) ||
                Schema.isSchemaError(error)
              )
                return { status: "unsupported" }
              throw error
            } finally {
              await server.close()
            }
          })
        : discoverThroughHost(options.credentialSocket, signal),
  }
}

const HostCatalog = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["unsupported", "unauthenticated"]) }),
  Schema.Array(
    Schema.Struct({
      provider: Schema.NullOr(Schema.String),
      model: Schema.String,
      selectionModel: Schema.String,
      name: Schema.String,
      efforts: Schema.Array(Schema.Struct({ id: Schema.String, description: Schema.String })),
      defaultEffort: Schema.String,
      defaultModel: Schema.Boolean,
      modalities: Schema.Struct({ input: Schema.Array(Schema.String) }),
      availability: Schema.Literal("unknown"),
    }),
  ),
])

async function discoverThroughHost(socket: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const process = await startAgentHost(socket, {
    runId: `discovery-${crypto.randomUUID()}`,
    profile: "codex-discovery",
    directory: "",
    prompt: "",
    model: null,
    timeoutMs: 30000,
  })
  try {
    return Schema.decodeUnknownSync(HostCatalog)(
      JSON.parse(await readAgentHostOutput(socket, process, 8_000_000, signal)),
    )
  } finally {
    await requestAgentHost(socket, {
      operation: "stop",
      runId: process.runId,
      launchId: process.launchId,
    })
  }
}
