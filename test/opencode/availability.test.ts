import { expect, test } from "bun:test"
import { Effect, Fiber, Layer, Logger, Stream } from "effect"
import { TestClock } from "effect/testing"
import { OpenCodeAgentHarness, TrustedAgentHarnessCatalog } from "../../src/agent-harness"
import {
  Automation,
  makeOpenCodeHarnessDefinitions,
  makePullRequestHarnessDefinitions,
  OpenCodeAutomationAdapter,
} from "../../src/opencode"
import { loadConfig } from "../../src/config"
import { WorkflowStart } from "../../src/qrspi/workflow-start"
import { startHookService } from "../../src/runtime"
import { normalizeWorkflowDefinition, workflowDefinitionSha256 } from "../../src/qrspi/domain"
import { questionsStageContract } from "../../src/qrspi/contracts"
import {
  TrustedStageCatalog,
  validateWorkflowDefinition,
  validatePersistedSnapshots,
} from "../../src/qrspi/stage-catalog"
import { agentGitTestEnvironment } from "../helpers/agent-git-config"
import { kernelLayer, qrspiDefinition, stubAdapters } from "../helpers/runtime"
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

const harnessDefinitions = makeOpenCodeHarnessDefinitions({
  reviewerAgent: "pr-reviewer",
  fixerAgent: "pr-fixer",
  model: "openai/gpt-5.6-sol",
  pollIntervalMs: 1,
  timeoutMs: 1_000,
})

const harnessFor = (client: OpenCodeSdkClient) =>
  new OpenCodeAgentHarness(
    new SdkOpenCodeAdapter(client),
    new TrustedAgentHarnessCatalog(Object.values(harnessDefinitions)),
    { serverId: "test", endpointAlias: "test", pollIntervalMs: 1 },
  )

test.each([0, 200])(
  "startup reports always-empty catalogs within 30 seconds (%i ms reads)",
  async (latency) => {
    let reads = 0
    let completed = false
    const automation = new OpenCodeAutomationAdapter(
      harnessFor({
        ...catalogClient([], []),
        listAgents: () =>
          Effect.sync(() => {
            reads += 1
            return []
          }).pipe(Effect.delay(latency)),
      }),
      harnessDefinitions,
    )
    const config = await loadConfig(
      {
        ...agentGitTestEnvironment,
        GITHUB_APP_ID: "123",
        WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
        WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "http://127.0.0.1:4096",
      },
      { home: "/tmp" },
    )
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const startup = yield* startHookService(config).pipe(
            Effect.result,
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true
              }),
            ),
            Effect.forkChild,
          )
          yield* TestClock.adjust("27 seconds")
          expect(completed).toBe(false)
          yield* TestClock.adjust("3 seconds")
          expect(completed).toBe(true)
          return yield* Fiber.join(startup)
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            kernelLayer(":memory:"),
            stubAdapters(),
            Layer.succeed(Automation, automation),
          ),
        ),
        Effect.provide(TestClock.layer()),
        Effect.provide(Logger.layer([])),
      ),
    )
    expect(reads).toBe(latency === 0 ? 15 : 14)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("OpenCode catalogs are empty (0 agents, 0 models)")
      expect(result.failure.message).toContain("plugins may still be activating")
      expect(result.failure.message).toContain(
        "no agents/providers may be configured for this location",
      )
      if (latency > 0) expect(result.failure.message).toContain("30 seconds")
    }
  },
)

for (const persisted of [false, true]) {
  test.each([
    { recovers: true, latency: 0, hung: false },
    { recovers: false, latency: 0, hung: false },
    { recovers: false, latency: 200, hung: false },
    { recovers: false, latency: 0, hung: true },
  ])(
    `QRSPI ${persisted ? "persisted" : "fresh"} catalog readiness: %j`,
    async ({ recovers, latency, hung }) => {
      let reads = 0
      let completed = false
      const agentHarness = harnessFor({
        ...catalogClient([], [{ providerID: "openai", id: "gpt-5.6-sol" }]),
        listAgents: () =>
          hung
            ? Effect.never
            : Effect.sync(() => (++reads > 1 && recovers ? ["qrspi-questions"] : [])).pipe(
                Effect.delay(latency),
              ),
      })
      const definition = normalizeWorkflowDefinition(qrspiDefinition)
      const stageCatalog = new TrustedStageCatalog([questionsStageContract]).port()
      const { stageSnapshots } = await Effect.runPromise(
        validateWorkflowDefinition({
          definition,
          stageCatalog,
          agentHarness: harnessFor(
            catalogClient(["qrspi-questions"], [{ providerID: "openai", id: "gpt-5.6-sol" }]),
          ),
        }),
      )
      const check = persisted
        ? validatePersistedSnapshots({
            workflowDefinitionSha256: workflowDefinitionSha256(definition),
            snapshots: stageSnapshots,
            stageCatalog,
            agentHarness,
          })
        : validateWorkflowDefinition({ definition, stageCatalog, agentHarness })
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const validation = yield* check.pipe(
            Effect.result,
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true
              }),
            ),
            Effect.forkChild,
          )
          yield* TestClock.adjust("1 second")
          expect(completed).toBe(false)
          yield* TestClock.adjust("29 seconds")
          expect(completed).toBe(true)
          return yield* Fiber.join(validation)
        }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))),
      )
      expect(reads).toBe(hung ? 0 : recovers ? 2 : latency === 0 ? 15 : 14)
      if (recovers) expect(result._tag).toBe("Success")
      else
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            phase: "availability",
            reason: "unavailable_agent_model",
            ...(hung
              ? {}
              : {
                  stageKey: "questions",
                  sequencePosition: 1,
                  harnessRef: { name: "opencode", version: 1 },
                }),
          },
        })
    },
  )
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
              expect(cause.message).toContain("OpenCode catalogs are empty")
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
  expect(logs[1]).toEqual([
    "OpenCode availability check failed; retrying",
    { operation: "validate OpenCode availability" },
  ])
})

// Use wall time here: TestClock cannot exercise Bun's socket idle timeout.
test.each([false, true])(
  "HTTP cold-catalog start returns its validation outcome (second check: %s)",
  async (secondCheck) => {
    let validations = 0
    let reads = 0
    const definition = normalizeWorkflowDefinition(qrspiDefinition)
    const stageCatalog = new TrustedStageCatalog([questionsStageContract]).port()
    const agentHarness = harnessFor({
      ...catalogClient([], [{ providerID: "openai", id: "gpt-5.6-sol" }]),
      listAgents: () =>
        Effect.suspend(() => {
          reads += 1
          // The first validation uses 3.8s; the second exhausts the shared
          // eight-second deadline with the catalog empty again.
          return Effect.succeed(
            secondCheck && validations === 1 && reads > 1 ? ["qrspi-questions"] : [],
          ).pipe(Effect.delay(secondCheck && validations === 1 ? 900 : 0))
        }),
    })
    const validate = Effect.suspend(() => {
      validations += 1
      return validateWorkflowDefinition({ definition, stageCatalog, agentHarness })
    })
    const loaded = await loadConfig(
      {
        ...agentGitTestEnvironment,
        GITHUB_APP_ID: "123",
        WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
        WORKFLOWD_ALLOWED_INSTALLATION_ACCOUNT_IDS: "81005232,319835875",
        GITHUB_PRIVATE_KEY_PATH: "/tmp/key",
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_REVIEW_OPENCODE_PASSWORD: "review-password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "http://127.0.0.1:4096",
        WORKFLOWD_QRSPI_TOKEN: "kickoff-secret",
        WORKFLOWD_QRSPI_INSTALLATION_ID: "91",
        WORKFLOWD_QRSPI_REPOSITORY_ID: "42",
        WORKFLOWD_QRSPI_REPOSITORY: "example-owner/example",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID: "workspace-42",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE: "/tmp",
        WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify(qrspiDefinition),
      },
      { home: "/tmp" },
    )
    const response = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* startHookService({
            ...loaded,
            http: { ...loaded.http, host: "127.0.0.1", port: 0 },
          })
          return yield* Effect.tryPromise(() =>
            fetch(`http://${server.hostname}:${server.port}/workflows/qrspi`, {
              method: "POST",
              headers: { authorization: "Bearer kickoff-secret" },
              body: "{}",
              signal: AbortSignal.timeout(9_500),
            }).then(async (response) => ({ status: response.status, body: await response.json() })),
          )
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            kernelLayer(":memory:"),
            stubAdapters(),
            Layer.succeed(WorkflowStart, {
              preflight: Effect.void,
              start: () =>
                validate.pipe(
                  Effect.andThen(validate),
                  Effect.andThen(Effect.die("empty catalog must fail validation")),
                ),
            }),
          ),
        ),
        Effect.provide(Logger.layer([])),
      ),
    )
    expect(response).toEqual({ status: 503, body: { error: "WorkflowStartValidationError" } })
    expect(validations).toBe(secondCheck ? 2 : 1)
    expect(reads).toBeGreaterThan(validations)
  },
  12_000,
)
