import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { generateKeyPairSync } from "node:crypto"
import { Effect, Option } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { loadCapabilityGatewayConfig, loadConfig } from "../../src/config"
import { makeLiveLayer } from "../../src/layers"
import { SandboxDispatch } from "../../src/sandbox/dispatch"
import { bindRunSession, seedCapabilityRun } from "./fixture"
import { makeCapabilityStore } from "../../src/capability-gateway/store"
import { requiredEnvironment } from "../helpers/config"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"

test("configured live composition settles prior leases, which revokes their grants, and refuses an actions-native launch before external effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-composition-"))
  const gateway = {
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
    for (const [bad, reason] of [
      [{ ...gateway, unexpected: true }, 'Expected no excess property\n  at ["unexpected"]'],
      [
        { ...gateway, maxStreamsPerRun: 5 },
        'Expected a value between 1 and 4\n  at ["maxStreamsPerRun"]',
      ],
    ] as const)
      await expect(
        loadConfig({ ...environment, WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(bad) }),
      ).rejects.toThrow(reason)
    const loaded = await loadConfig(environment, { home: root })
    expect(loaded.agentRuns?.capabilityGateway).toEqual(gateway)
    // The gateway's own process needs a listen address; workflowd accepts and ignores one.
    const listen = { host: "127.0.0.1", port: 0 }
    const served = { ...gateway, listen }
    expect(
      (
        await loadConfig(
          { ...environment, WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(served) },
          { home: root },
        )
      ).agentRuns?.capabilityGateway,
    ).toEqual(served)
    expect(
      loadCapabilityGatewayConfig({ WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(served) }, root),
    ).toEqual({ gateway: served, databasePath: join(root, ".local/state/workflowd/workflowd.db") })
    expect(() => loadCapabilityGatewayConfig({}, root)).toThrow("is required")
    expect(() =>
      loadCapabilityGatewayConfig({ WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(gateway) }, root),
    ).toThrow("requires a listen address")
    for (const [bad, reason] of [
      [{ host: "gateway.example", port: 1 }, `at ["listen"]["host"]`],
      [
        { host: "127.0.0.1", port: 65536 },
        'Expected a value between 0 and 65535\n  at ["listen"]["port"]',
      ],
    ] as const)
      expect(() =>
        loadCapabilityGatewayConfig(
          { WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({ ...gateway, listen: bad }) },
          root,
        ),
      ).toThrow(reason)
    // Discovery is optional in the composition API; this boundary fixture does
    // not ask for a provider catalog, preflight, or an executor launch.
    const { executionCapabilities: _discovery, ...config } = loaded
    await Effect.runPromise(
      Effect.gen(function* () {
        const { sql, runs } = yield* seedCapabilityRun(Date.now(), true)
        const authority = yield* makeCapabilityStore
        const now = Date.now()
        const { binding } = yield* bindRunSession(now, {
          jti: "composition-jti",
          digest: "a".repeat(64),
          expiresAt: now + 60000,
        })
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

test("the gateway config bounds its streams: an idle limit of 1 ms to ten minutes, and at most maxStreams for a run", () => {
  const gateway = {
    noscope: { binary: "/fixture/noscope", configHome: "/fixture" },
    providerId: "anthropic",
    credentialRole: "fixture",
    maxStreams: 2,
    maxStreamsPerRun: 2,
    listen: { host: "127.0.0.1", port: 0 },
  }
  const load = (keys: Record<string, unknown>) =>
    loadCapabilityGatewayConfig(
      { WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({ ...gateway, ...keys }) },
      "/fixture",
    ).gateway
  for (const [keys, reason] of [
    [{ streamIdleMs: 0 }, 'Expected a value between 1 and 600000\n  at ["streamIdleMs"]'],
    [{ streamIdleMs: -1 }, 'Expected a value between 1 and 600000\n  at ["streamIdleMs"]'],
    [{ streamIdleMs: 600001 }, 'Expected a value between 1 and 600000\n  at ["streamIdleMs"]'],
    [{ streamIdleMs: 1.5 }, 'Expected an integer\n  at ["streamIdleMs"]'],
    [{ streamIdleMs: "1000" }, 'Expected number\n  at ["streamIdleMs"]'],
    [{ maxStreams: 513 }, 'Expected a value between 1 and 512\n  at ["maxStreams"]'],
    [
      { maxStreams: 1, maxStreamsPerRun: 2 },
      'Expected a value of at most maxStreams\n  at ["maxStreamsPerRun"]',
    ],
  ] as const)
    expect(() => load(keys)).toThrow(reason)
  expect(load({ streamIdleMs: 1 }).streamIdleMs).toBe(1)
  expect(load({ streamIdleMs: 600000 }).streamIdleMs).toBe(600000)
  expect(load({}).streamIdleMs).toBeUndefined()
})
