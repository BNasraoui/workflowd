import { expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Cause, Effect, Layer } from "effect"
import { loadConfig } from "../src/config"
import { AgentHarness } from "../src/agent-harness"
import { GitHub } from "../src/github"
import { AgentRunIngress } from "../src/kernel/agent-run-ingress"
import { AgentRunWatchdog } from "../src/kernel/agent-run-watchdog"
import { ClaudeResumeWorker } from "../src/kernel/claude-resume-worker"
import { KernelEventStore } from "../src/kernel/event-store"
import { KernelJobStore } from "../src/kernel/job-store"
import { DOGFOOD_ENRICHMENT_CONTRACT, DogfoodStore } from "../src/kernel/dogfood-store"
import {
  AGENT_RUNS_ENRICHMENT_CONTRACT,
  AgentRunsEnrichmentStore,
} from "../src/kernel/agent-runs-enrichment-store"
import { TestJobCanary } from "../src/kernel/test-job-canary"
import { makeLiveLayer } from "../src/layers"
import { Automation } from "../src/opencode"
import { WorkflowStore } from "../src/store/contracts"
import { Workspace } from "../src/workspace"
import { WorkflowStart } from "../src/qrspi/workflow-start"

const qrspiDefinition = {
  contractVersion: 1,
  definitionVersion: 1,
  stages: [
    {
      key: "questions",
      kind: "document",
      contract: { name: "qrspi.questions", contractVersion: 1 },
      activation: { mode: "enabled" },
      definitionVersion: 1,
      maxEncodedInputBytes: 16_384,
      producer: {
        harness: { name: "opencode", version: 1 },
        agent: "qrspi-questions",
        model: "openai/gpt-5.6-sol",
        timeoutMs: 60_000,
        retry: { maxAttempts: 3, backoffMs: 1_000 },
      },
      outputPolicy: {
        _tag: "Artifact",
        pathTemplate: "docs/qrspi/{ticketId}/01-questions.md",
        mediaType: "text/markdown",
      },
      reviewPolicy: { mode: "none" },
      humanGatePolicy: { mode: "none" },
    },
  ],
}

const sixStageDefinition = {
  ...qrspiDefinition,
  stages: ["questions", "research", "design", "structure", "plan", "implementation"].map((key) => ({
    ...qrspiDefinition.stages[0],
    key,
    kind: key === "implementation" ? "implementation" : "document",
    contract: { name: `qrspi.${key}`, contractVersion: 1 },
    producer: { ...qrspiDefinition.stages[0]!.producer, agent: "qrspi-stage" },
    outputPolicy:
      key === "implementation"
        ? {
            _tag: "ImplementationCheckpoint",
            contractId: "qrspi.implementation-checkpoint",
            contractVersion: 1,
          }
        : {
            _tag: "Artifact",
            pathTemplate: `docs/qrspi/{ticketId}/${key}.md`,
            mediaType: "text/markdown",
          },
    ...(key === "design"
      ? {
          designPolicy: { name: "qrspi.design-policy", version: 1 },
          promotionPolicy: { name: "qrspi.promotion-policy", version: 1 },
        }
      : {}),
    ...(key === "structure"
      ? { structurePolicy: { name: "qrspi.structure-policy", version: 1 } }
      : {}),
  })),
}

test("starts and restarts the full live layer with both kernel stores", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-layers-kernel-stores-"))
  try {
    const privateKeyPath = join(directory, "github.pem")
    const databasePath = join(directory, "workflowd.db")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }))
    const config = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: privateKeyPath,
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_DATABASE_PATH: databasePath,
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
        WORKFLOWD_QRSPI_TOKEN: "kickoff-secret",
        WORKFLOWD_QRSPI_INSTALLATION_ID: "91",
        WORKFLOWD_QRSPI_REPOSITORY_ID: "42",
        WORKFLOWD_QRSPI_REPOSITORY: "example-owner/example",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID: "workspace-42",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE: directory,
        WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify(qrspiDefinition),
        WORKFLOWD_AGENT_RUN_TOKEN: "agent-run-secret",
        WORKFLOWD_AGENT_RUN_ROUTES: "implement=zai-coding-plan/glm-5.3-flash",
        WORKFLOWD_AGENT_RUN_REPOSITORIES: `workflowd=${directory}`,
      },
      { home: directory },
    )

    const start = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* KernelEventStore
          const jobs = yield* KernelJobStore
          yield* WorkflowStore
          yield* WorkflowStart
          const testJobs = yield* TestJobCanary
          const agentRuns = yield* AgentRunIngress
          const watchdog = yield* AgentRunWatchdog
          const claudeResume = yield* ClaudeResumeWorker
          const dogfood = yield* DogfoodStore
          const agentRunsEnrichment = yield* AgentRunsEnrichmentStore
          // Both supervised iterations run once against the empty store so
          // the composed worker pipelines execute, not just resolve.
          const watchdogStatus = yield* watchdog.iteration
          const claudeStatus = yield* claudeResume.iteration
          if (watchdogStatus !== "idle" || claudeStatus !== "idle") {
            return yield* Effect.die(new Error("expected idle iterations on an empty store"))
          }
          const dogfoodContract = (yield* dogfood.sessions()).contract
          const agentRunsContract = (yield* agentRunsEnrichment.sessions()).contract
          return {
            methods: [
              events.readReadyDeliveries,
              jobs.readRecoverable,
              testJobs.submit,
              agentRuns.register,
              dogfood.sessions,
              agentRunsEnrichment.sessions,
            ],
            dogfoodContract,
            agentRunsContract,
          }
        }).pipe(
          Effect.provide(
            makeLiveLayer(config).pipe(
              Layer.provide(SqliteClient.layer({ filename: databasePath })),
            ),
          ),
        ),
      )

    const first = await start()
    expect(first.methods.every((method) => typeof method === "function")).toBe(true)
    expect(first.dogfoodContract).toBe(DOGFOOD_ENRICHMENT_CONTRACT)
    expect(first.agentRunsContract).toBe(AGENT_RUNS_ENRICHMENT_CONTRACT)
    expect((await start()).methods.every((method) => typeof method === "function")).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("composes the reusable agent harness with the live ports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-layers-"))
  try {
    const privateKeyPath = join(directory, "github.pem")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }))
    const config = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: privateKeyPath,
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
        WORKFLOWD_QRSPI_TOKEN: "kickoff-secret",
        WORKFLOWD_QRSPI_INSTALLATION_ID: "91",
        WORKFLOWD_QRSPI_REPOSITORY_ID: "42",
        WORKFLOWD_QRSPI_REPOSITORY: "example-owner/example",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID: "workspace-42",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE: directory,
        WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify(qrspiDefinition),
      },
      { home: directory },
    )
    const Live = makeLiveLayer(config).pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    )

    const methods = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const github = yield* GitHub
        const automation = yield* Automation
        const agentHarness = yield* AgentHarness
        const workspace = yield* Workspace
        const workflowStart = yield* WorkflowStart
        return [
          store.claimNextJob,
          github.publishReview,
          automation.prepareReview,
          agentHarness.createSession,
          workspace.prepareReview,
          workflowStart.start,
        ]
      }).pipe(Effect.provide(Live)),
    )

    expect(methods.every((method) => typeof method === "function")).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("composes the explicit six-contract catalog by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-layers-stage-catalog-"))
  try {
    const privateKeyPath = join(directory, "github.pem")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }))
    const config = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: privateKeyPath,
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
        WORKFLOWD_QRSPI_TOKEN: "kickoff-secret",
        WORKFLOWD_QRSPI_INSTALLATION_ID: "91",
        WORKFLOWD_QRSPI_REPOSITORY_ID: "42",
        WORKFLOWD_QRSPI_REPOSITORY: "example-owner/example",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID: "workspace-42",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE: directory,
        WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify(sixStageDefinition),
      },
      { home: directory },
    )
    const Live = makeLiveLayer(config).pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    )
    const preflight = await Effect.runPromise(
      Effect.gen(function* () {
        const workflowStart = yield* WorkflowStart
        return yield* workflowStart.preflight.pipe(Effect.result)
      }).pipe(Effect.provide(Live)),
    )
    expect(preflight).toMatchObject({
      _tag: "Failure",
      failure: { phase: "availability", reason: "unavailable_agent_model" },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("composes disabled QRSPI ingress as an unauthorized service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-layers-disabled-"))
  try {
    const privateKeyPath = join(directory, "github.pem")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }))
    const config = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: privateKeyPath,
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
      },
      { home: directory },
    )
    const Live = makeLiveLayer(config).pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    )

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const workflowStart = yield* WorkflowStart
        return yield* Effect.exit(workflowStart.start({}))
      }).pipe(Effect.provide(Live)),
    )

    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ _tag: "Fail", error: { _tag: "WorkflowStartUnauthorized" } }] },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("keeps unrelated services available when configured QRSPI is closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-layers-closed-"))
  try {
    const privateKeyPath = join(directory, "github.pem")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }))
    const config = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: privateKeyPath,
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
        WORKFLOWD_QRSPI_TOKEN: "kickoff-secret",
        WORKFLOWD_QRSPI_INSTALLATION_ID: "91",
        WORKFLOWD_QRSPI_REPOSITORY_ID: "42",
        WORKFLOWD_QRSPI_REPOSITORY: "example-owner/example",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID: "workspace-42",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE: directory,
        WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify({
          ...qrspiDefinition,
          stages: [
            {
              ...qrspiDefinition.stages[0],
              contract: { name: "qrspi.missing", contractVersion: 1 },
            },
          ],
        }),
      },
      { home: directory },
    )
    const Live = makeLiveLayer(config).pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WorkflowStore
        const github = yield* GitHub
        const automation = yield* Automation
        const agentHarness = yield* AgentHarness
        const workspace = yield* Workspace
        const workflowStart = yield* WorkflowStart
        return {
          methods: [
            store.claimNextJob,
            github.publishReview,
            automation.prepareReview,
            agentHarness.createSession,
            workspace.prepareReview,
          ],
          closed: yield* Effect.result(workflowStart.start({})),
        }
      }).pipe(Effect.provide(Live)),
    )

    expect(result.methods.every((method) => typeof method === "function")).toBe(true)
    expect(result.closed).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "WorkflowStartValidationError",
        phase: "contract",
        reason: "unknown_contract_reference",
      },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("fails live composition when the configured GitHub key cannot be read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-layers-missing-key-"))
  try {
    const config = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: join(directory, "missing.pem"),
        GITHUB_WEBHOOK_SECRET: "secret",
        OPENCODE_SERVER_PASSWORD: "password",
        WORKFLOWD_OPENCODE_ATTACH_URL: "https://mint.example-tailnet.ts.net:4096",
        WORKFLOWD_QRSPI_TOKEN: "kickoff-secret",
        WORKFLOWD_QRSPI_INSTALLATION_ID: "91",
        WORKFLOWD_QRSPI_REPOSITORY_ID: "42",
        WORKFLOWD_QRSPI_REPOSITORY: "example-owner/example",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID: "workspace-42",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE: directory,
        WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify(qrspiDefinition),
      },
      { home: directory },
    )
    const Live = makeLiveLayer(config).pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    )

    const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(Live)))

    expect(Cause.findErrorOption(exit._tag === "Failure" ? exit.cause : Cause.empty)).toMatchObject(
      {
        _tag: "Some",
        value: expect.any(Error),
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
