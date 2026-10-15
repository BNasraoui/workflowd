import { expect, test } from "bun:test"
import { Effect, Fiber, Logger, Stream } from "effect"
import { TestClock } from "effect/testing"
import { OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "../../src/agent-harness"
import { makePullRequestHarnessDefinitions, OpenCodeAutomationAdapter } from "../../src/opencode"
import { validateOpenCodeStartup } from "../../src/startup-validation"
import { SdkOpenCodeAdapter, type OpenCodeSdkClient } from "../../src/opencode/adapter"

const requested = {
  agents: ["pr-reviewer"],
  model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" },
}

function catalogClient(
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

for (const scenario of [
  { agents: undefined, models: undefined, agentPresent: null, modelPresent: null },
  { agents: [], models: [], agentPresent: false, modelPresent: false },
  { agents: ["pr-reviewer", "general"], models: [], agentPresent: true, modelPresent: false },
  {
    agents: [],
    models: [{ providerID: "zai-coding-plan", id: "glm-5.3-flash" }],
    agentPresent: false,
    modelPresent: true,
  },
  {
    agents: ["general"],
    models: [{ providerID: "zai-coding-plan", id: "glm-5.3-flash" }],
    agentPresent: false,
    modelPresent: true,
  },
]) {
  test(`failed availability logs returned catalogs: ${JSON.stringify(scenario)}`, async () => {
    const client = catalogClient(scenario.agents, scenario.models)
    const logs: unknown[] = []
    const adapter = new SdkOpenCodeAdapter(
      client,
      undefined,
      "http://test-user:test-password@127.0.0.1:4098/reviewer?token=test-token#test-fragment",
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = yield* adapter
            .validateAvailability({ ...requested, directory: "/reviewer" })
            .pipe(Effect.result)
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            const cause = result.failure.cause
            if (!(cause instanceof Error)) throw new Error("Expected an Error cause")
            if (scenario.agents?.length === 0 || scenario.models?.length === 0) {
              expect(cause.name).toBe("OpenCodeCatalogNotReadyError")
              expect(cause.message).toContain("OpenCode catalogs are not ready")
              expect(cause.message).not.toContain("Unavailable OpenCode integration")
            } else if (scenario.agents !== undefined) {
              expect(cause.message).toContain("Unavailable OpenCode integration: agent pr-reviewer")
            }
          }
        }
      }).pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))]))),
    )
    expect(logs).toEqual(
      Array(2).fill([
        "OpenCode availability check failed",
        {
          serverUrl: "http://127.0.0.1:4098/reviewer",
          directory: "/reviewer",
          agentCount: scenario.agents?.length ?? null,
          modelCount: scenario.models?.length ?? null,
          agents: [{ name: "pr-reviewer", present: scenario.agentPresent }],
          model: { name: "zai-coding-plan/glm-5.3-flash", present: scenario.modelPresent },
        },
      ]),
    )
  })
}

test("startup waits for cold catalogs using the existing bounded retry", async () => {
  let reads = 0
  const parameters: unknown[] = []
  const adapter = new SdkOpenCodeAdapter({
    ...catalogClient([], []),
    listAgents: (input) =>
      Effect.sync(() => {
        parameters.push(input)
        return ++reads === 1 ? [] : ["pr-reviewer"]
      }),
    listModels: (input) =>
      Effect.sync(() => {
        parameters.push(input)
        return reads === 1 ? [] : [{ providerID: "zai-coding-plan", id: "glm-5.3-flash" }]
      }),
  })
  const definitions = makePullRequestHarnessDefinitions({
    reviewerAgent: "pr-reviewer",
    fixerAgent: "pr-fixer",
    model: "zai-coding-plan/glm-5.3-flash",
    pollIntervalMs: 1,
    timeoutMs: 1_000,
  })
  const automation = new OpenCodeAutomationAdapter(
    new OpenCodeAgentHarness(adapter, new TrustedAgentHarnessCatalog([definitions.review]), {
      serverId: "reviewer",
      endpointAlias: "reviewer",
      pollIntervalMs: 1,
    }),
    definitions,
  )
  const logs: unknown[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const startup = yield* automation
        .validateAvailability({ fixWorkEnabled: false })
        .pipe(validateOpenCodeStartup, Effect.forkChild)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(startup)
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])),
    ),
  )
  expect(reads).toBe(2)
  expect(parameters).toEqual([{}, {}, {}, {}])
  expect(logs[0]).toMatchObject([
    "OpenCode availability check failed",
    { directory: null, agentCount: 0, modelCount: 0 },
  ])
  expect(JSON.stringify(logs)).toContain("OpenCodeCatalogNotReadyError")
})
