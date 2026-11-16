import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Server } from "node:http"
import { tmpdir } from "node:os"
import { generateKeyPairSync } from "node:crypto"
import { Effect, Exit, Option, Scope } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { loadCapabilityGatewayConfig, loadConfig } from "../../src/config"
import { makeLiveLayer } from "../../src/layers"
import { SandboxDispatch } from "../../src/sandbox/dispatch"
import { seedCapabilityRun } from "./fixture"
import { makeDaemonCapability } from "../../src/sandbox/capability-control"
import { serveCapabilityGateway } from "../../src/capability-gateway-server"
import { serveCapabilityListener } from "../../src/capability-gateway/http"
import { loopbackCertificate, tlsFront } from "../helpers/loopback-tls"
import { client } from "./gateway-process"
import { requiredEnvironment } from "../helpers/config"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"

test("configured live composition settles prior leases, which revokes their grants on the control socket, and refuses an actions-native launch before external effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-composition-"))
  const socket = join(root, "control", "gateway.sock")
  const listenSocket = join(root, "front", "gateway.sock")
  const front = await tlsFront(await loopbackCertificate(root), listenSocket)
  const gateway = {
    noscope: { binary: fixtureExecutable("noscope"), configHome: root },
    providerId: "anthropic",
    credentialRole: "fixture",
    maxStreams: 4,
    maxStreamsPerRun: 2,
    storePath: join(root, "gateway.db"),
    controlSocket: socket,
    daemon: { uid: process.getuid!(), gid: process.getgid!() },
    listen: {
      socket: listenSocket,
      front: { uid: process.getuid!(), gid: process.getgid!() },
      service: front.service,
    },
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
    WORKFLOWD_CAPABILITY_CONTROL: JSON.stringify({ socket }),
    WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "false",
  }
  const scope = Effect.runSync(Scope.make())
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
      loadConfig({ ...environment, WORKFLOWD_CAPABILITY_CONTROL: undefined }),
    ).rejects.toThrow("Native Actions requires")
    // workflowd's section names the socket and the budget of a new run; the gateway's section is
    // not workflowd's, and each count of the budget is a positive integer.
    for (const bad of [
      { socket, unexpected: true },
      { socket, storePath: gateway.storePath },
      { socket: "relative.sock" },
      { socket, budget: { calls: 0 } },
      { socket, budget: { outputTokens: -600000 } },
      { socket, budget: { maxTokens: 1.5 } },
      { socket, budget: { maxTokens: "128000" } },
      { socket, budget: { calls: 2000, unexpected: 1 } },
    ])
      await expect(
        loadConfig({ ...environment, WORKFLOWD_CAPABILITY_CONTROL: JSON.stringify(bad) }),
      ).rejects.toThrow()
    await expect(
      loadConfig({ ...environment, WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(gateway) }),
    ).rejects.toThrow("belongs to the gateway process")
    const loaded = await loadConfig(environment, { home: root })
    expect(loaded.agentRuns?.capabilityControl).toEqual({
      socket,
      budget: { calls: 2000, outputTokens: 600000, maxTokens: 128000 },
    })
    const named = await loadConfig(
      {
        ...environment,
        WORKFLOWD_CAPABILITY_CONTROL: JSON.stringify({ socket, budget: { outputTokens: 5000 } }),
      },
      { home: root },
    )
    expect(named.agentRuns?.capabilityControl?.budget).toEqual({
      calls: 2000,
      outputTokens: 5000,
      maxTokens: 128000,
    })
    // The gateway's process reads its section alone, with its listener, store and socket.
    expect(
      loadCapabilityGatewayConfig({ WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(gateway) }),
    ).toEqual(gateway)
    expect(() => loadCapabilityGatewayConfig({})).toThrow("is required")
    expect(() =>
      loadCapabilityGatewayConfig({
        WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({ ...gateway, maxStreamsPerRun: 5 }),
      }),
    ).toThrow('Expected a value between 1 and 4\n  at ["maxStreamsPerRun"]')
    const { listen: _listen, ...unlistened } = gateway
    for (const bad of [
      unlistened,
      { ...gateway, listen: { host: "127.0.0.1", port: 1 } },
      { ...gateway, listen: { ...gateway.listen, socket: "front/gateway.sock" } },
      { ...gateway, listen: { ...gateway.listen, front: { uid: -1, gid: 0 } } },
      { ...gateway, listen: { ...gateway.listen, service: "Gateway.example" } },
      { ...gateway, listen: { ...gateway.listen, service: "gateway.example:0" } },
      { ...gateway, storePath: "gateway.db" },
      { ...gateway, daemon: { uid: -1, gid: 0 } },
    ])
      expect(() =>
        loadCapabilityGatewayConfig({ WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(bad) }),
      ).toThrow()
    await Effect.runPromise(
      serveCapabilityGateway({ WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(gateway) }).pipe(
        Scope.provide(scope),
      ),
    )
    const challenge = async () =>
      (await client(front).request("/capabilities/v1/challenge?lease=lease")).status
    // Discovery is optional in the composition API; this boundary fixture does
    // not ask for a provider catalog, preflight, or an executor launch.
    const { executionCapabilities: _discovery, ...config } = loaded
    await Effect.runPromise(
      Effect.gen(function* () {
        const { sql, runs } = yield* seedCapabilityRun(Date.now(), true, undefined, {
          gatewayStore: false,
        })
        const run = yield* runs.read("run")
        if (!run) throw new Error("fixture run missing")
        yield* sql`UPDATE kernel_agent_runs SET directory=${join(root, "run")} WHERE run_id='run'`
        // workflowd granted the run before this start; its runner may ask for a challenge.
        yield* (yield* makeDaemonCapability({ socket, reconcileEveryMs: 3600000 })).authorize("run")
        expect(yield* Effect.promise(challenge)).toBe(200)
        yield* Effect.gen(function* () {
          const selected = yield* Effect.serviceOption(SandboxDispatch)
          if (Option.isNone(selected)) throw new Error("configured dispatch unavailable")
          const dispatch = selected.value
          // The start settled the prior lease; the gateway revoked its run.
          for (let waited = 0; (yield* Effect.promise(challenge)) !== 503; waited++) {
            if (waited > 100) throw new Error("the settled lease kept its grant")
            yield* Effect.sleep("20 millis")
          }
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
    await Effect.runPromise(Scope.close(scope, Exit.void))
    front.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("the gateway config bounds its streams: an idle limit of 1 ms to the listener's socket timeout of two minutes, a stale sweep every 100 ms to a minute, and at most maxStreams for a run", async () => {
  const gateway = {
    noscope: { binary: "/fixture/noscope", configHome: "/fixture" },
    providerId: "anthropic",
    credentialRole: "fixture",
    maxStreams: 2,
    maxStreamsPerRun: 2,
    storePath: "/fixture/gateway.db",
    controlSocket: "/fixture/control/gateway.sock",
    daemon: { uid: 1000, gid: 1000 },
    listen: {
      socket: "/fixture/front/gateway.sock",
      front: { uid: 1001, gid: 1001 },
      service: "gateway.example.ts.net",
    },
  }
  const load = (keys: Record<string, unknown>) =>
    loadCapabilityGatewayConfig({
      WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({ ...gateway, ...keys }),
    })
  for (const [keys, reason] of [
    [{ streamIdleMs: 0 }, 'Expected a value between 1 and 120000\n  at ["streamIdleMs"]'],
    [{ streamIdleMs: -1 }, 'Expected a value between 1 and 120000\n  at ["streamIdleMs"]'],
    [{ streamIdleMs: 120001 }, 'Expected a value between 1 and 120000\n  at ["streamIdleMs"]'],
    [{ streamIdleMs: 1.5 }, 'Expected an integer\n  at ["streamIdleMs"]'],
    [{ streamIdleMs: "1000" }, 'Expected number\n  at ["streamIdleMs"]'],
    [{ maxStreams: 513 }, 'Expected a value between 1 and 512\n  at ["maxStreams"]'],
    [{ staleSweepMs: 99 }, 'Expected a value between 100 and 60000\n  at ["staleSweepMs"]'],
    [{ staleSweepMs: 60001 }, 'Expected a value between 100 and 60000\n  at ["staleSweepMs"]'],
    [{ staleSweepMs: 250.5 }, 'Expected an integer\n  at ["staleSweepMs"]'],
    [
      { maxStreams: 1, maxStreamsPerRun: 2 },
      'Expected a value of at most maxStreams\n  at ["maxStreamsPerRun"]',
    ],
  ] as const)
    expect(() => load(keys)).toThrow(reason)
  expect(load({ streamIdleMs: 1 }).streamIdleMs).toBe(1)
  expect(load({ streamIdleMs: 120000 }).streamIdleMs).toBe(120000)
  // A socket idle this long is destroyed under a silent stream, so the bound is this timeout.
  const root = await mkdtemp(join(tmpdir(), "gateway-timeout-"))
  const socketTimeout = spyOn(Server.prototype, "setTimeout")
  try {
    const close = await serveCapabilityListener(
      {
        socket: join(root, "front", "gateway.sock"),
        front: { uid: process.getuid!(), gid: process.getgid!() },
        service: "gateway.example.ts.net",
      },
      async () => new Response(null),
    )
    await close()
    // Bun's HTTP server applies its socket timeout again as it starts to listen: each call is the
    // listener's one timeout.
    const calls = socketTimeout.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    for (let call = 1; call <= calls; call++)
      expect(socketTimeout).toHaveBeenNthCalledWith(call, 120000, expect.any(Function))
  } finally {
    socketTimeout.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
  expect(load({}).streamIdleMs).toBeUndefined()
  expect(load({ staleSweepMs: 100 }).staleSweepMs).toBe(100)
  expect(load({ staleSweepMs: 60000 }).staleSweepMs).toBe(60000)
  expect(load({}).staleSweepMs).toBeUndefined()
})

test("the gateway's listener is a Unix socket: a listen section with a host or a port is refused", () => {
  const gateway = {
    noscope: { binary: "/fixture/noscope", configHome: "/fixture" },
    providerId: "anthropic",
    credentialRole: "fixture",
    maxStreams: 2,
    maxStreamsPerRun: 2,
    storePath: "/fixture/gateway.db",
    controlSocket: "/fixture/control/gateway.sock",
    daemon: { uid: 1000, gid: 1000 },
  }
  const listen = {
    socket: "/fixture/front/gateway.sock",
    front: { uid: 1001, gid: 1001 },
    service: "gateway.example.ts.net",
  }
  const load = (section: Record<string, unknown>) =>
    loadCapabilityGatewayConfig({
      WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({ ...gateway, listen: section }),
    }).listen
  for (const [section, key] of [
    [{ ...listen, host: "127.0.0.1" }, "host"],
    [{ ...listen, port: 8443 }, "port"],
    [{ host: "127.0.0.1", port: 0 }, "host"],
  ] as const)
    expect(() => load(section)).toThrow(`Expected no excess property\n  at ["listen"]["${key}"]`)
  expect(load(listen)).toEqual(listen)
  expect(load({ ...listen, service: "gateway.example.ts.net:8443" }).service).toBe(
    "gateway.example.ts.net:8443",
  )
})

test("the gateway's login directory is an absolute path of letters, digits, '.', '_', '-' and '/' only, as the provider file's command takes it", () => {
  const gateway = {
    noscope: { binary: "/fixture/noscope", configHome: "/fixture" },
    providerId: "anthropic",
    credentialRole: "claude",
    maxStreams: 2,
    maxStreamsPerRun: 2,
    storePath: "/fixture/gateway.db",
    controlSocket: "/fixture/control/gateway.sock",
    daemon: { uid: 1000, gid: 1000 },
    listen: {
      socket: "/fixture/front/gateway.sock",
      front: { uid: 1001, gid: 1001 },
      service: "gateway.example.ts.net",
    },
  }
  const load = (directory: string) =>
    loadCapabilityGatewayConfig({
      WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify({ ...gateway, login: { directory } }),
    }).login?.directory
  expect(load("/var/lib/gateway-1/login_dir.d")).toBe("/var/lib/gateway-1/login_dir.d")
  for (const directory of [
    "login",
    "/var/lib/gateway login",
    "/var/lib/$HOME",
    '/var/lib/"login"',
    "/var/lib/'login'",
    "/var/lib/login\\n",
    "/var/lib/login\nmint = x",
    "/var/lib/login;id",
    "/var/lib/`id`",
    "/",
  ])
    expect(() => load(directory)).toThrow('at ["login"]["directory"]')
})
