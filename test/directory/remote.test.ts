import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted, Schedule, Schema } from "effect"
import { connect } from "@nats-io/transport-node"
import { jetstream, jetstreamManager } from "@nats-io/jetstream"
import { DirectoryObserve, directoryBytes, directoryMac } from "../../src/directory/wire"
import { generateKeyPairSync, sign } from "node:crypto"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { SqlClient } from "effect/unstable/sql"
import { canonicalJson } from "../../src/kernel/session-store-support"
import { JsonValueSchema } from "../../src/json"
import { externalRecipientId } from "../../src/directory/proof"
import { DirectoryRunner, DirectorySnapshot } from "../../src/directory/contract"
import { startDirectoryDaemon } from "./harness"
import { OpenCode } from "@opencode-ai/client/effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SdkOpenCodeAdapter, makeOpenCodeSdkClient } from "../../src/opencode/adapter"
import { AgentRunProvider } from "../../src/kernel/agent-run-ingress"
import { runManagedDirectoryObservation } from "../../src/directory/managed-observations"

test("two-host directory uses authenticated NATS observations and installed Codex discovery without leaking source secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccw3-directory-"))
  const nats = Bun.spawn(
    [
      "nats-server",
      "-js",
      "--auth",
      "isolated-fixture-token",
      "-a",
      "127.0.0.1",
      "-p",
      "-1",
      "-sd",
      join(root, "nats"),
    ],
    { stderr: "pipe", stdout: "ignore" },
  )
  const reader = nats.stderr.getReader()
  let logs = ""
  let daemon: Awaited<ReturnType<typeof startDirectoryDaemon>> | undefined
  let runner: ReturnType<typeof Bun.spawn> | undefined
  let runnerLogs: Promise<string> | undefined
  let hostB: Awaited<ReturnType<typeof startDirectoryDaemon>> | undefined
  const relays: Bun.Server<undefined>[] = []
  let passed = false
  try {
    const port = await Effect.runPromise(
      Effect.tryPromise(async () => {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) throw new Error("NATS exited")
          logs += new TextDecoder().decode(chunk.value)
          const match = /Listening for client connections on 127\.0\.0\.1:(\d+)/.exec(logs)
          if (match) return match[1]!
        }
      }).pipe(Effect.timeout("5 seconds")),
    )
    const key = join(root, "host-b.key")
    await writeFile(key, "isolated-host-b-credential-".repeat(3), { mode: 0o600 })
    const binary = join(root, "codex-fixture")
    await writeFile(
      binary,
      `#!/usr/bin/env bun\nprocess.argv[2] = "normal"; await import(${JSON.stringify(join(import.meta.dir, "../execution/fixtures/codex-app-server.mjs"))});`,
      { mode: 0o700 },
    )
    daemon = await startDirectoryDaemon("host-a", join(root, "host-a.db"), {
      WORKFLOWD_DIRECTORY_PEERS: JSON.stringify({ "host-b": key }),
      WORKFLOWD_NATS_SERVERS: `nats://127.0.0.1:${port}`,
      WORKFLOWD_NATS_TOKEN: "isolated-fixture-token",
      WORKFLOWD_DIRECTORY_REFRESH_MS: "200",
      WORKFLOWD_DIRECTORY_LEASE_MS: "2000",
      WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "true",
      WORKFLOWD_AGENT_RUN_CODEX_BIN: binary,
    })
    hostB = await startDirectoryDaemon("host-b", join(root, "host-b.db"))
    const nativeFor = () => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) =>
          Response.json({
            data: {
              id: new URL(request.url).pathname.split("/").at(-1),
              projectID: "fixture",
              cost: 0,
              tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 1, updated: 1 },
              location: { directory: "/tmp/owned" },
            },
          }),
      })
      relays.push(server)
      return server
    }
    const nativeA = nativeFor()
    const nativeB = nativeFor()
    const observeNative = (host: NonNullable<typeof daemon>, native: Bun.Server<undefined>) =>
      host.runtime.runPromise(
        runManagedDirectoryObservation({
          endpointIdentity: native.url.toString(),
          leaseMs: 90_000,
          now: () => new Date(),
        }).pipe(
          Effect.provideService(
            AgentRunProvider,
            new SdkOpenCodeAdapter(
              makeOpenCodeSdkClient(
                OpenCode.make({ baseUrl: native.url.toString() }).pipe(
                  Effect.provide(FetchHttpClient.layer),
                ),
              ),
            ),
          ),
        ),
      )
    const seed = (host: NonNullable<typeof daemon>, hostId: string) =>
      host.runtime.runPromise(
        Effect.gen(function* () {
          const runs = yield* AgentRunStore
          const sessions = yield* KernelSessionStore
          const now = new Date()
          const runId = "agent-run-two-host"
          yield* runs.create({
            runId,
            route: "fixture",
            executorKind: "opencode",
            providerId: "provider",
            modelId: "same-model",
            agent: "fixture",
            repository: "fixture",
            directory: "/tmp/owned",
            prompt: "inert",
            promptSha256: "a".repeat(64),
            parentSessionId: null,
            resumePrompt: null,
            maxAttempts: 2,
            createdAt: now,
          })
          yield* runs.claimSpawn({ runId, now })
          yield* sessions.registerResource({
            resourceId: "owned",
            owningHostId: hostId,
            absolutePath: "/tmp/owned",
            kind: "worktree",
            createdAt: now,
          })
          yield* sessions.registerSession({
            sessionId: "opencode-session-same",
            nativeSessionId: "ses_same",
            providerKind: "opencode",
            providerVersion: 1,
            providerId: "fixture",
            serverId: "fixture",
            owningHostId: hostId,
            endpointAlias: "local",
            endpointIdentity: (hostId === "host-a" ? nativeA : nativeB).url.toString(),
            resourceId: "owned",
            createdAt: now,
          })
          yield* runs.markSpawned({
            runId,
            resourceId: "owned",
            sessionId: "opencode-session-same",
            nativeSessionId: "ses_same",
            now,
          })
          yield* runs.markVerified({ runId, outputTokens: 1, now })
        }),
      )
    await seed(daemon, "host-a")
    await seed(hostB, "host-b")
    await observeNative(daemon, nativeA)
    await observeNative(hostB, nativeB)
    const enroll = async (host: NonNullable<typeof daemon>, hostId: string) => {
      const owner = generateKeyPairSync("ed25519")
      const publicKey = owner.publicKey.export({ type: "spki", format: "der" }).toString("base64")
      const relay = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (request) => {
          const challenge = Schema.decodeUnknownSync(JsonValueSchema)(await request.json())
          return Response.json({
            signature: sign(null, Buffer.from(canonicalJson(challenge)), owner.privateKey).toString(
              "base64",
            ),
          })
        },
      })
      relays.push(relay)
      const document = {
        protocol: "workflowd-directory-register-v1",
        hostId,
        publicKey,
        revision: 1,
        endpoint: {
          harness: "codex",
          transport: "relay-http",
          address: relay.url.toString(),
          nativeSessionId: "same-native-name",
        },
      }
      const registration = {
        ...document,
        signature: sign(null, Buffer.from(canonicalJson(document)), owner.privateKey).toString(
          "base64",
        ),
      }
      const response = await host.request("/directory/registrations", {
        method: "POST",
        body: JSON.stringify(registration),
      })
      expect(response.status).toBe(202)
      expect(
        (
          await host.request("/directory/registrations", {
            method: "POST",
            body: JSON.stringify({
              ...registration,
              recipientId: `managed:${hostId}:agent-run-two-host`,
              cleanup: true,
            }),
          })
        ).status,
      ).toBe(400)
      await host.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const counts =
            yield* sql`SELECT (SELECT count(*) FROM kernel_agent_runs) AS runs, (SELECT count(*) FROM kernel_sessions) AS sessions, (SELECT count(*) FROM kernel_working_resources) AS resources`
          expect(counts[0]).toEqual({ runs: 1, sessions: 1, resources: 1 })
          expect((yield* (yield* AgentRunStore).read("agent-run-two-host"))?.state).toBe("verified")
        }),
      )
      expect(
        (
          await host.request("/directory/registrations", {
            method: "POST",
            body: JSON.stringify(registration),
          })
        ).status,
      ).toBe(202)
      return externalRecipientId(publicKey)
    }
    const externalA = await enroll(daemon, "host-a")
    const externalB = await enroll(hostB, "host-b")
    const snapshot = Schema.decodeUnknownSync(DirectorySnapshot)(
      await (await daemon.request("/directory")).json(),
    )
    expect(snapshot.runners.find((runner) => runner.hostId === "host-b")).toMatchObject({
      runnerId: "runner:host-b",
      status: "unavailable",
      observedAt: null,
      catalog: { capabilities: [], sources: [] },
    })
    const attacker = await connect({
      servers: `nats://127.0.0.1:${port}`,
      token: "isolated-fixture-token",
    })
    try {
      const command = await daemon.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const rows =
            yield* sql`SELECT request_json FROM directory_peer_observations WHERE host_id = 'host-b'`
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DirectoryObserve))(
            rows[0]?.request_json,
          )
        }),
      )
      const document = {
        version: 1 as const,
        kind: "directory_page" as const,
        hostId: "host-b",
        coordinatorHostId: "host-a",
        generation: command.generation,
        nonce: command.nonce,
        page: 0,
        total: 1,
        content: JSON.stringify({
          snapshot: {
            agents: [],
            runners: [
              {
                runnerId: "runner:host-b",
                hostId: "host-b",
                status: "active",
                observedAt: new Date().toISOString(),
                expiresAt: command.expiresAt,
                catalog: { capabilities: [], sources: [] },
              },
            ],
          },
          registrations: [],
        }),
      }
      const ack = await jetstream(attacker).publish(
        "workflowd.v1.commands.directory-host-a",
        directoryBytes({
          ...document,
          signature: directoryMac(Redacted.make("another-hosts-proof-key"), document),
        }),
      )
      const manager = await jetstreamManager(attacker)
      await Effect.runPromise(
        Effect.tryPromise(async () => {
          const consumer = await manager.consumers.info("WORKFLOWD_COMMANDS_V1", "directory-host-a")
          if (consumer.ack_floor.stream_seq < ack.seq)
            throw new Error("Waiting for forged observation acknowledgement")
        }).pipe(Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 80 })),
      )
      const refused = Schema.decodeUnknownSync(DirectorySnapshot)(
        await (await daemon.request("/directory")).json(),
      )
      expect(refused.runners.find((r) => r.hostId === "host-b")?.status).toBe("unavailable")
    } finally {
      await attacker.drain()
    }
    const startRunner = () => {
      const child = Bun.spawn(["bun", "src/remote-runner.ts"], {
        env: {
          PATH: process.env.PATH ?? "",
          WORKFLOWD_REMOTE_HOST_ID: "host-b",
          WORKFLOWD_REMOTE_DATABASE_PATH: join(root, "host-b.db"),
          WORKFLOWD_NATS_SERVERS: `nats://127.0.0.1:${port}`,
          WORKFLOWD_NATS_TOKEN: "isolated-fixture-token",
          WORKFLOWD_DIRECTORY_COORDINATOR_HOST: "host-a",
          WORKFLOWD_DIRECTORY_CREDENTIAL_FILE: key,
          WORKFLOWD_AGENT_RUN_CODEX_BIN: binary,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      runner = child
      runnerLogs = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).then((parts) => parts.join("\n"))
    }
    startRunner()
    const coordinator = daemon
    let observed = snapshot
    await Effect.runPromise(
      Effect.tryPromise(async () => {
        observed = Schema.decodeUnknownSync(DirectorySnapshot)(
          await (await coordinator.request("/directory")).json(),
        )
        if (observed.runners.find((r) => r.hostId === "host-b")?.status !== "active")
          throw new Error("Waiting for authenticated observation")
      }).pipe(Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 80 })),
    ).catch(() => undefined)
    expect(observed.runners.find((r) => r.hostId === "host-b")?.status).toBe("active")
    expect(
      observed.runners.find((r) => r.hostId === "host-b")?.catalog.capabilities[0],
    ).toMatchObject({
      identity: { host: "host-b", executor: "codex:local", model: "first" },
      availability: "unknown",
      thinking: { defaultEffort: "deliberate" },
    })
    expect(JSON.stringify(observed)).not.toContain("credential-secret")
    expect(JSON.stringify(observed)).not.toContain("private@example.com")
    expect(JSON.stringify(observed)).not.toContain("isolated-host-b-credential")
    expect(observed.agents.map((agent) => agent.recipientId).sort()).toEqual(
      [
        externalA,
        externalB,
        "managed:host-a:agent-run-two-host",
        "managed:host-b:agent-run-two-host",
      ].sort(),
    )
    expect(
      observed.runners
        .flatMap((r) => r.catalog.capabilities)
        .filter((capability) => capability.identity.model === "first")
        .map((capability) => capability.identity.host)
        .sort(),
    ).toEqual(["host-a", "host-b"])
    for (const agent of observed.agents)
      expect(
        (await coordinator.request(`/directory/agents/${encodeURIComponent(agent.recipientId)}`))
          .status,
      ).toBe(200)
    const perHost: unknown = await (
      await coordinator.request("/directory/capabilities?host=host-b")
    ).json()
    expect(perHost).toMatchObject({ runners: [{ hostId: "host-b" }] })
    const perHostRunners = Schema.decodeUnknownSync(
      Schema.Struct({ runners: Schema.Array(DirectoryRunner) }),
    )(perHost).runners
    expect(perHostRunners).toHaveLength(1)
    expect(
      perHostRunners[0]?.catalog.capabilities.some(
        (capability) =>
          capability.identity.host === "host-b" && capability.identity.model === "first",
      ),
    ).toBe(true)
    // A real transport partition must expire the persisted observation without a new request succeeding.
    nats.kill("SIGSTOP")
    await Effect.runPromise(
      Effect.tryPromise(async () => {
        observed = Schema.decodeUnknownSync(DirectorySnapshot)(
          await (await coordinator.request("/directory")).json(),
        )
        if (observed.runners.find((r) => r.hostId === "host-b")?.status !== "expired")
          throw new Error("Waiting for observation expiry")
      }).pipe(Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 160 })),
    )
    expect(
      observed.runners
        .find((r) => r.hostId === "host-b")
        ?.catalog.capabilities.every((capability) => capability.availability === "unavailable"),
    ).toBe(true)
    expect(
      observed.agents
        .filter((agent) => agent.hostId === "host-b")
        .every((agent) => !agent.deliverable),
    ).toBe(true)
    nats.kill("SIGCONT")
    runner?.kill()
    await runner?.exited
    await runnerLogs
    await hostB.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const sessions = yield* KernelSessionStore
        yield* sessions.registerSession({
          sessionId: "opencode-session-reconnected",
          nativeSessionId: "ses_reconnected",
          providerKind: "opencode",
          providerVersion: 1,
          providerId: "fixture",
          serverId: "fixture",
          owningHostId: "host-b",
          endpointAlias: "local",
          endpointIdentity: nativeB.url.toString(),
          resourceId: "owned",
          createdAt: new Date(),
        })
        yield* sql`UPDATE kernel_agent_runs SET session_id = 'opencode-session-reconnected', native_session_id = 'ses_reconnected', updated_at = ${new Date().toISOString()} WHERE run_id = 'agent-run-two-host'`
        const runs = yield* AgentRunStore
        yield* runs.markVerified({ runId: "agent-run-two-host", outputTokens: 2, now: new Date() })
      }),
    )
    await observeNative(hostB, nativeB)
    startRunner()
    await Effect.runPromise(
      Effect.tryPromise(async () => {
        observed = Schema.decodeUnknownSync(DirectorySnapshot)(
          await (await coordinator.request("/directory")).json(),
        )
        if (
          observed.runners.find((r) => r.hostId === "host-b")?.status !== "active" ||
          observed.agents.find((a) => a.recipientId === "managed:host-b:agent-run-two-host")
            ?.endpoint?.nativeSessionId !== "ses_reconnected"
        )
          throw new Error("Waiting for runner reconnect")
      }).pipe(Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 160 })),
    )
    expect(
      observed.agents.find((agent) => agent.recipientId === "managed:host-b:agent-run-two-host")
        ?.bindingVersion,
    ).toBeGreaterThan(2)
    expect(observed.agents.find((agent) => agent.recipientId === externalB)?.origin).toBe(
      "external",
    )
    passed = true
  } finally {
    nats.kill("SIGCONT")
    await daemon?.stop()
    await hostB?.stop()
    for (const relay of relays) await relay.stop(true)
    runner?.kill()
    await runner?.exited
    if (!passed && runnerLogs !== undefined) console.log(await runnerLogs)
    nats.kill()
    await nats.exited
    await reader.cancel()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
