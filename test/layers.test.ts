import { expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { loadConfig } from "../src/config"
import { AgentHarness } from "../src/agent-harness"
import { GitHub } from "../src/github"
import { makeLiveLayer } from "../src/layers"
import { Automation } from "../src/opencode"
import { WorkflowStore } from "../src/store/contracts"
import { Workspace } from "../src/workspace"
import { WorkflowStart } from "../src/qrspi/workflow-start"

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
        WORKFLOWD_QRSPI_DEFINITION_JSON: JSON.stringify({
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
                harnessId: "opencode",
                harnessVersion: 1,
                agent: "qrspi-questions",
                model: "openai/gpt-5.6-sol",
                timeoutMs: 60_000,
                retry: { maxAttempts: 3, backoffMs: 1_000 },
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
        }),
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
