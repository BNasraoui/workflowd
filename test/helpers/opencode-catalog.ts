import { Effect, Stream } from "effect"
import type { OpenCodeSdkClient } from "../../src/opencode/adapter"

const unexpected = () => Effect.die("Unexpected call on catalog-only OpenCode client")

export function catalogClient(
  agents: ReadonlyArray<string> | undefined,
  models: ReadonlyArray<{ providerID: string; id: string }> | undefined,
): OpenCodeSdkClient {
  return {
    setSessionEnvironment: unexpected,
    createSession: unexpected,
    promptSession: unexpected,
    subscribeEvents: () => Stream.die("Unexpected subscription on catalog-only OpenCode client"),
    activeSessions: unexpected,
    sessionOutcome: unexpected,
    listMessages: unexpected,
    interruptSession: unexpected,
    generateText: unexpected,
    listAgents: () =>
      agents === undefined
        ? Effect.fail(new Error("agent request failed"))
        : Effect.succeed(agents),
    listModels: () =>
      models === undefined
        ? Effect.fail(new Error("model request failed"))
        : Effect.succeed(models),
    listProviders: unexpected,
    sessionTelemetry: unexpected,
  }
}
