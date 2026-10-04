import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Schema } from "effect"
import { loadConfig } from "../src/config"
import { makeLiveLayer } from "../src/layers"
import { startHookService } from "../src/runtime"
import { AgentRunStore } from "../src/kernel/agent-run-store"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Agent, Model } from "@opencode-ai/client/effect"

test("execution-only directory automatically exposes accepted runs under authenticated stable recipients", async () => {
  const config = await loadConfig({
    WORKFLOWD_MODE: "execution",
    WORKFLOWD_HOST_ID: "host-a",
    WORKFLOWD_AGENT_RUN_TOKEN: "directory-secret",
    WORKFLOWD_AGENT_RUN_REPOSITORIES: "fixture=/tmp/fixture",
    WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "false",
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      const runs = yield* AgentRunStore
      const at = new Date()
      const input = {
        runId: "agent-run-directory",
        route: "fixture",
        providerId: "codex-cli",
        modelId: "same-model",
        executorKind: "codex" as const,
        agent: "worker",
        repository: "fixture",
        directory: "/tmp/fixture",
        prompt: "inert",
        promptSha256: "a".repeat(64),
        parentSessionId: null,
        resumePrompt: null,
        maxAttempts: 1,
        createdAt: at,
      }
      yield* runs.create(input)
      yield* runs.create(input)
      const server = yield* startHookService({ ...config, http: { ...config.http, port: 0 } })
      const get = (path: string, token = "directory-secret") =>
        Effect.tryPromise(() =>
          fetch(new URL(path, server.url), { headers: { authorization: `Bearer ${token}` } }),
        )
      const response = yield* get("/directory")
      expect(response.status).toBe(200)
      const snapshot = yield* Effect.tryPromise(() => response.json()).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ agents: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
          ),
        ),
      )
      expect(snapshot.agents).toHaveLength(1)
      expect(snapshot.agents[0]).toMatchObject({
        recipientId: "managed:host-a:agent-run-directory",
        hostId: "host-a",
        origin: "managed",
        runId: input.runId,
        status: "accepted",
        endpoint: null,
        deliverable: false,
      })
      expect((yield* get("/directory", "wrong-token")).status).toBe(401)
      expect((yield* get("/directory/agents/managed%3Ahost-a%3Aagent-run-directory")).status).toBe(
        200,
      )
      expect((yield* get("/directory/agents/missing")).status).toBe(404)
    }).pipe(
      Effect.provide(
        makeLiveLayer(config).pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))),
      ),
      Effect.scoped,
    ),
  )
})

test("automation composition serves the same authenticated directory with unavailable native discovery reported explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "directory-automation-"))
  let healthy = true
  const model = Model.Info.default(
    Model.Ref.fields.providerID.make("fixture"),
    Model.ID.make("native-model"),
  )
  const openCode = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      healthy
        ? Response.json({
            location: {
              directory: root,
              project: { id: "fixture", directory: root, canonical: root },
            },
            data: new URL(request.url).pathname.endsWith("/agent")
              ? [
                  Agent.Info.default(Agent.ID.make("pr-reviewer")),
                  Agent.Info.default(Agent.ID.make("pr-fixer")),
                ]
              : [model],
          })
        : new Response(null, { status: 503 }),
  })
  try {
    const keyPath = join(root, "fixture.pem")
    await writeFile(
      keyPath,
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
    )
    const config = await loadConfig(
      {
        GITHUB_APP_ID: "123",
        GITHUB_PRIVATE_KEY_PATH: keyPath,
        GITHUB_WEBHOOK_SECRET: "fixture",
        OPENCODE_SERVER_PASSWORD: "private-fixture-password",
        OPENCODE_SERVER_URL: openCode.url.toString(),
        WORKFLOWD_OPENCODE_ATTACH_URL: openCode.url.toString(),
        WORKFLOWD_HOST_ID: "host-a",
        WORKFLOWD_MODEL: "fixture/native-model",
        WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN: "directory-secret",
        WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "false",
      },
      { home: root },
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* startHookService({ ...config, http: { ...config.http, port: 0 } })
        healthy = false
        const response = yield* Effect.tryPromise(() =>
          fetch(new URL("/directory", server.url), {
            headers: { authorization: "Bearer directory-secret" },
          }),
        )
        expect(response.status).toBe(200)
        const snapshot: unknown = yield* Effect.tryPromise(() => response.json())
        expect(snapshot).toMatchObject({
          agents: [],
          runners: [
            {
              hostId: "host-a",
              status: "active",
              catalog: { capabilities: [], sources: [{ kind: "opencode", status: "unavailable" }] },
            },
          ],
        })
        expect(JSON.stringify(snapshot)).not.toContain("private-fixture-password")
      }).pipe(
        Effect.provide(
          makeLiveLayer(config).pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))),
        ),
        Effect.scoped,
      ),
    )
  } finally {
    await openCode.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
