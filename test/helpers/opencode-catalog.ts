import { Effect, Stream } from "effect"
import type { OpenCodeSdkClient } from "../../src/opencode/adapter"

export function catalogClient(
  agents: ReadonlyArray<string> | undefined,
  models: ReadonlyArray<{ providerID: string; id: string }> | undefined,
): OpenCodeSdkClient {
  return {
    setSessionEnvironment: () => Effect.void,
    createSession: () => Effect.succeed({ id: "ses_test" }),
    promptSession: () => Effect.void,
    subscribeEvents: () => Stream.empty,
    activeSessions: () => Effect.succeed([]),
    sessionOutcome: () => Effect.succeed(undefined),
    listMessages: () => Effect.succeed([]),
    interruptSession: () => Effect.succeed(true),
    generateText: () => Effect.succeed("{}"),
    listAgents: () =>
      agents === undefined
        ? Effect.fail(new Error("agent request failed"))
        : Effect.succeed(agents),
    listModels: () =>
      models === undefined
        ? Effect.fail(new Error("model request failed"))
        : Effect.succeed(models),
    listProviders: () => Effect.succeed([]),
    sessionTelemetry: () => Effect.succeed(undefined),
  }
}
