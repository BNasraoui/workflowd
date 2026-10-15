import { expect, test } from "bun:test"
import { Effect, Logger, Stream } from "effect"
import { SdkOpenCodeAdapter, type OpenCodeSdkClient } from "../../src/opencode/adapter"

const requested = {
  agents: ["pr-reviewer"],
  model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" },
}

for (const scenario of [
  { agents: undefined, models: undefined, agentPresent: null, modelPresent: null },
  { agents: [], models: [], agentPresent: false, modelPresent: false },
  { agents: ["pr-reviewer", "general"], models: [], agentPresent: true, modelPresent: false },
  {
    agents: ["general"],
    models: [{ providerID: "zai-coding-plan", id: "glm-5.3-flash" }],
    agentPresent: false,
    modelPresent: true,
  },
]) {
  test(`failed availability logs returned catalogs: ${JSON.stringify(scenario)}`, async () => {
    const client: OpenCodeSdkClient = {
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
        scenario.agents === undefined
          ? Effect.fail(new Error("agent request failed"))
          : Effect.succeed(scenario.agents),
      listModels: () =>
        scenario.models === undefined
          ? Effect.fail(new Error("model request failed"))
          : Effect.succeed(scenario.models),
      listProviders: () => Effect.succeed([]),
      sessionTelemetry: () => Effect.succeed(undefined),
    }
    const logs: unknown[] = []
    const adapter = new SdkOpenCodeAdapter(
      client,
      undefined,
      "http://test-user:test-password@127.0.0.1:4098/reviewer?token=test-token#test-fragment",
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = yield* adapter.validateAvailability(requested).pipe(Effect.result)
          expect(result._tag).toBe("Failure")
        }
      }).pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))]))),
    )
    expect(logs).toEqual(
      Array(2).fill([
        "OpenCode availability check failed",
        {
          serverUrl: "http://127.0.0.1:4098/reviewer",
          agentCount: scenario.agents?.length ?? null,
          modelCount: scenario.models?.length ?? null,
          agents: [{ name: "pr-reviewer", present: scenario.agentPresent }],
          model: { name: "zai-coding-plan/glm-5.3-flash", present: scenario.modelPresent },
        },
      ]),
    )
  })
}
