import { expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Option } from "effect"
import { loadConfig } from "../src/config"
import { AgentHarness } from "../src/agent-harness"
import { GitHub } from "../src/github"
import { makeLiveLayer } from "../src/layers"
import { Automation } from "../src/opencode"
import { WorkflowStore } from "../src/store/contracts"
import { Workspace } from "../src/workspace"
import { WorkflowStart } from "../src/qrspi/workflow-start"
import { StageCatalogService } from "../src/qrspi/stages"
import { QrspiWorkspace } from "../src/qrspi/workspace"
import { ArtifactPublicationRepositoryFactoryService } from "../src/qrspi/artifact-publication"

const qrspiDefinition = {
  contractVersion: 1,
  definitionVersion: 1,
  stages: [
    {
      key: "questions",
      kind: "document",
      activation: { mode: "enabled" },
      definitionVersion: 1,
      inputContract: {
        schemaId: "qrspi.questions.input",
        schemaVersion: 1,
        maxEncodedBytes: 16_384,
      },
      producer: {
        harnessId: "trusted.custom-document",
        harnessVersion: 7,
        agent: "configured-producer",
        model: "anthropic/claude-sonnet-4",
        timeoutMs: 75_000,
        retry: { maxAttempts: 5, backoffMs: 2_000 },
      },
      outputContract: {
        _tag: "Artifact",
        pathTemplate: "docs/qrspi/{ticketId}/01-questions.md",
        mediaType: "text/markdown",
      },
      reviewPolicy: { mode: "none" },
      humanGatePolicy: { mode: "none" },
      initialOperations: [
        {
          kind: "StageProduce",
          state: "ready",
          parentEffect: { success: "advance parent", failure: "fail Generation" },
        },
        {
          kind: "ArtifactPublish",
          state: "blocked",
          parentEffect: { success: "advance parent", failure: "fail Generation" },
        },
      ],
    },
  ],
}

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
        WORKFLOWD_QRSPI_TOKEN: "kickoff-secret",
        WORKFLOWD_QRSPI_INSTALLATION_ID: "91",
        WORKFLOWD_QRSPI_REPOSITORY_ID: "42",
        WORKFLOWD_QRSPI_REPOSITORY: "example-owner/example",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID: "workspace-42",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE: directory,
        WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify(qrspiDefinition),
        WORKFLOWD_GIT_SIGNING_KEY: "a".repeat(40),
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
        const stageCatalog = yield* StageCatalogService
        const qrspiWorkspace = yield* Effect.serviceOption(QrspiWorkspace)
        const artifactRepositoryFactory = yield* Effect.serviceOption(
          ArtifactPublicationRepositoryFactoryService,
        )
        return [
          store.claimNextJob,
          github.publishReview,
          automation.prepareReview,
          agentHarness.createSession,
          workspace.prepareReview,
          workflowStart.start,
          stageCatalog.resolve,
          Option.getOrThrow(qrspiWorkspace).withWorkspace,
          Option.getOrThrow(artifactRepositoryFactory).forDirectory,
        ]
      }).pipe(Effect.provide(Live)),
    )

    expect(methods.every((method) => typeof method === "function")).toBe(true)
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
      cause: { _tag: "Fail", error: { _tag: "WorkflowStartUnauthorized" } },
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
        WORKFLOWD_QRSPI_TOKEN: "kickoff-secret",
        WORKFLOWD_QRSPI_INSTALLATION_ID: "91",
        WORKFLOWD_QRSPI_REPOSITORY_ID: "42",
        WORKFLOWD_QRSPI_REPOSITORY: "example-owner/example",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE_ID: "workspace-42",
        WORKFLOWD_QRSPI_BEADS_WORKSPACE: directory,
        WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify(qrspiDefinition),
        WORKFLOWD_GIT_SIGNING_KEY: "a".repeat(40),
      },
      { home: directory },
    )
    const Live = makeLiveLayer(config).pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    )

    const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(Live)))

    expect(exit._tag).toBe("Failure")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
