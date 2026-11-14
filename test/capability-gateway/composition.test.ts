import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { generateKeyPairSync } from "node:crypto"
import { Effect, Option } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { loadConfig } from "../../src/config"
import { makeLiveLayer } from "../../src/layers"
import { SandboxDispatch } from "../../src/sandbox/dispatch"
import { seedCapabilityRun, transport } from "./fixture"
import { makeCapabilityStore } from "../../src/capability-gateway/store"
import { requiredEnvironment } from "../helpers/config"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"

test("configured live composition revokes prior grants and refuses P2 native launch before external effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-composition-"))
  const gateway = {
    nodeBinary: fixtureExecutable("node"),
    noscope: { binary: fixtureExecutable("noscope"), configHome: root },
    providerId: "anthropic",
    credentialRole: "fixture",
    maxStreams: 4,
    maxStreamsPerRun: 2,
  }
  const policy = {
    alias: "fixture",
    repository: "fixture/repo",
    repositoryId: 12,
    installationId: 1,
    workflowSha: "a".repeat(40),
    appActorId: 56,
    agentImage: `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"b".repeat(64)}`,
    tailscaleClientId: "fixture",
    tailscaleAudience: "fixture",
    privateBootstrap: { repositoryOwnerId: 34, mode: "actions-native" },
  }
  const environment = {
    ...requiredEnvironment,
    GITHUB_PRIVATE_KEY_PATH: join(root, "app.pem"),
    WORKFLOWD_DATABASE_PATH: join(root, "db.sqlite"),
    WORKFLOWD_AGENT_RUN_TOKEN: "fixture-run-token",
    WORKFLOWD_AGENT_RUN_REPOSITORIES: `fixture=${root}`,
    WORKFLOWD_AGENT_RUN_SANDBOX_REPOSITORIES: JSON.stringify([policy]),
    WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(gateway),
    WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "false",
  }
  try {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    await writeFile(
      environment.GITHUB_PRIVATE_KEY_PATH,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    )
    await expect(
      loadConfig({ ...environment, WORKFLOWD_AGENT_RUN_TOKEN: undefined }),
    ).rejects.toThrow("WORKFLOWD_AGENT_RUN_TOKEN is required")
    await expect(
      loadConfig({ ...environment, WORKFLOWD_CAPABILITY_GATEWAY: undefined }),
    ).rejects.toThrow("Native Actions requires")
    for (const bad of [
      { ...gateway, unexpected: true },
      { ...gateway, maxStreamsPerRun: 5 },
    ])
      await expect(
        loadConfig({ ...environment, WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(bad) }),
      ).rejects.toThrow()
    const loaded = await loadConfig(environment, { home: root })
    expect(loaded.agentRuns?.capabilityGateway).toEqual(gateway)
    // Discovery is optional in the composition API; this boundary fixture does
    // not ask for a provider catalog, preflight, or an executor launch.
    const { executionCapabilities: _discovery, ...config } = loaded
    await Effect.runPromise(
      Effect.gen(function* () {
        const { sql, runs, leases } = yield* seedCapabilityRun(Date.now())
        const authority = yield* makeCapabilityStore
        const now = Date.now()
        const challenge = yield* authority.challenge("run", transport, now)
        const binding = yield* authority.bind(
          challenge,
          "composition-jti",
          "a".repeat(64),
          now + 60000,
          now,
        )
        yield* leases.bind("run", 78, 1, transport)
        const run = yield* runs.read("run")
        if (!run) throw new Error("fixture run missing")
        yield* sql`UPDATE kernel_agent_runs SET directory=${join(root, "run")} WHERE run_id='run'`
        expect((yield* authority.authorize(binding, "a".repeat(64), now)).runId).toBe("run")
        yield* Effect.gen(function* () {
          const selected = yield* Effect.serviceOption(SandboxDispatch)
          if (Option.isNone(selected)) throw new Error("configured dispatch unavailable")
          const dispatch = selected.value
          expect(
            (yield* Effect.result(authority.authorize(binding, "a".repeat(64), now)))._tag,
          ).toBe("Failure")
          const native = {
            ...run,
            runId: "unstarted",
            directory: join(root, "unstarted"),
            executorKind: "claude" as const,
          }
          if (!dispatch.prepareNative) throw new Error("native boundary missing")
          expect((yield* Effect.result(dispatch.prepareNative(native)))._tag).toBe("Failure")
          expect(
            (yield* Effect.result(
              dispatch.launch(native, { providerID: "anthropic", modelID: "fixture-model" }),
            ))._tag,
          ).toBe("Failure")
          expect((yield* sql`SELECT count(*) AS count FROM sandbox_publications`)[0]?.count).toBe(0)
        }).pipe(Effect.provide(makeLiveLayer(config)))
      }).pipe(
        Effect.provide(AgentRunStoreLive),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.scoped,
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
