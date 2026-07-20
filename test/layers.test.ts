import { expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { loadConfig } from "../src/config"
import { GitHub } from "../src/github"
import { makeLiveLayer } from "../src/layers"
import { Automation } from "../src/opencode"
import { WorkflowStore } from "../src/store/contracts"
import { Workspace } from "../src/workspace"

test("composes the four live ports from AppConfig and SqlClient", async () => {
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
        const workspace = yield* Workspace
        return [
          store.claimNextJob,
          github.publishReview,
          automation.runReview,
          workspace.prepareReview,
        ]
      }).pipe(Effect.provide(Live)),
    )

    expect(methods.every((method) => typeof method === "function")).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
