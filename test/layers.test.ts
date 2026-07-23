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
      cause: { _tag: "Fail", error: { _tag: "WorkflowStartUnauthorized" } },
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
          closed: yield* Effect.either(workflowStart.start({})),
        }
      }).pipe(Effect.provide(Live)),
    )

    expect(result.methods.every((method) => typeof method === "function")).toBe(true)
    expect(result.closed).toMatchObject({
      _tag: "Left",
      left: {
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

    expect(Cause.failureOption(exit._tag === "Failure" ? exit.cause : Cause.empty)).toMatchObject({
      _tag: "Some",
      value: expect.any(Error),
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
