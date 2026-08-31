import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Fiber, Scope } from "effect"
import {
  RemoteTransport,
  RemoteTransportLive,
  type RemoteTransportPort,
} from "../../src/remote/transport"
import type { RemoteNatsAuth } from "../../src/remote/auth"
import { mintPermissionedBroker } from "./nats-creds-fixture"

const container = `workflowd-nats-permissions-${process.pid}`
const port = 46_000 + (process.pid % 1_000)
let server = ""
let configDir = ""
const broker = mintPermissionedBroker()

const docker = async (...arguments_: ReadonlyArray<string>) => {
  const process = Bun.spawn(["docker", ...arguments_], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (status !== 0) throw new Error(`docker ${arguments_.join(" ")} failed: ${stderr}`)
  return stdout.trim()
}

const waitForServerReady = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const process = Bun.spawn(["docker", "logs", container], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    const logs = stdout + stderr
    if (logs.includes("Server is ready")) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("nats-server did not become ready")
}

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), "workflowd-nats-auth-"))
  await writeFile(join(configDir, "nats.conf"), broker.serverConfig, { mode: 0o644 })
  await docker(
    "run",
    "-d",
    "--name",
    container,
    "-p",
    `127.0.0.1:${port}:4222`,
    "-v",
    `${configDir}:/etc/nats:ro`,
    "nats:2.11.8-alpine",
    "-c",
    "/etc/nats/nats.conf",
  )
  await waitForServerReady()
  server = `nats://127.0.0.1:${port}`
}, 60_000)

afterAll(async () => {
  await docker("rm", "-f", container).catch(() => undefined)
  if (configDir !== "") await rm(configDir, { recursive: true, force: true }).catch(() => undefined)
}, 30_000)

const runAs = <A, E>(
  auth: RemoteNatsAuth,
  effect: Effect.Effect<A, E, RemoteTransportPort | Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(RemoteTransportLive({ servers: [server], auth })))),
  )

const coordinator: RemoteNatsAuth = { mode: "creds", creds: broker.coordinatorCreds }
const runnerA: RemoteNatsAuth = { mode: "creds", creds: broker.runnerCreds("host-a") }

const command = (id: string, hostId: string) => ({
  version: 1 as const,
  commandId: id,
  jobId: `job-${id}`,
  attempt: 1,
  generation: 1,
  hostId,
  kind: "probe" as const,
  issuedAt: "2026-08-14T12:00:00.000Z",
  expiresAt: "2026-08-14T12:01:00.000Z",
})

const result = (commandId: string, hostId: string) => ({
  version: 1 as const,
  resultId: `result-${commandId}`,
  commandId,
  jobId: `job-${commandId}`,
  attempt: 1,
  generation: 1,
  hostId,
  kind: "probe" as const,
  status: "succeeded" as const,
  observedAt: "2026-08-14T12:00:30.000Z",
})

/** A claude_resume command and its result ride the same subjects and grants
 * as the probe; this proves the broker needs no new permissions for the
 * kind. */
const claudeCommand = (id: string, hostId: string) => ({
  version: 1 as const,
  commandId: id,
  jobId: `job-${id}`,
  attempt: 1,
  generation: 1,
  hostId,
  kind: "claude_resume" as const,
  payload: {
    kind: "claude_resume" as const,
    hostId,
    nativeSessionId: "0c0ffee0-cafe-4dad-b0ba-000000000001",
    directory: "/home/example/repos/workflowd",
    prompt: '{"task":"WAKE"}',
    extractionSchemaJson: '{"type":"object"}',
    turnTimeoutMs: 120_000,
  },
  issuedAt: "2026-08-14T12:00:00.000Z",
  expiresAt: "2026-08-14T12:10:00.000Z",
})

const claudeResult = (commandId: string, hostId: string) => ({
  version: 1 as const,
  resultId: `result-${commandId}`,
  commandId,
  jobId: `job-${commandId}`,
  attempt: 1,
  generation: 1,
  hostId,
  kind: "claude_resume" as const,
  status: "succeeded" as const,
  output: '{"acknowledged":true,"summary":"woken"}',
  observedAt: "2026-08-14T12:00:30.000Z",
})

describe.serial("permissioned NATS broker with per-identity creds", () => {
  test("coordinator creds administer JetStream and a runner works its own host end to end", async () => {
    await runAs(
      coordinator,
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        yield* transport.ensureInfrastructure()
        yield* transport.publishCommand(command("own-host", "host-a"))
      }),
    )

    const deliveries = await runAs(
      runnerA,
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        const waiting = yield* transport.takeHost("host-a", 10_000).pipe(Effect.forkChild)
        const deliveries = yield* Fiber.join(waiting)
        yield* deliveries[0]!.acknowledge
        yield* transport.publishResult(result("own-host", "host-a"))
        return deliveries
      }),
    )
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.deliveryId).toMatch(/^WORKFLOWD_COMMANDS_V1:/)

    const results = await runAs(
      coordinator,
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        const collected = yield* transport.takeResults(10_000)
        yield* collected[0]!.acknowledge
        return collected
      }),
    )
    expect(results).toHaveLength(1)
  }, 30_000)

  test("a claude_resume command and result flow under the existing grants", async () => {
    await runAs(
      coordinator,
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        yield* transport.ensureInfrastructure()
        yield* transport.publishCommand(claudeCommand("claude-1", "host-a"))
      }),
    )
    const deliveries = await runAs(
      runnerA,
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        const waiting = yield* transport.takeHost("host-a", 10_000).pipe(Effect.forkChild)
        const deliveries = yield* Fiber.join(waiting)
        yield* deliveries[0]!.acknowledge
        yield* transport.publishResult(claudeResult("claude-1", "host-a"))
        return deliveries
      }),
    )
    expect(deliveries).toHaveLength(1)
    const results = await runAs(
      coordinator,
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        const collected = yield* transport.takeResults(10_000)
        yield* collected[0]!.acknowledge
        return collected
      }),
    )
    expect(results).toHaveLength(1)
  }, 30_000)

  test("the broker denies a runner credential publishing another host's command subject", async () => {
    const outcome = await runAs(
      runnerA,
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        return yield* transport.publishCommand(command("cross-host", "host-b")).pipe(Effect.result)
      }),
    )

    expect(outcome._tag).toBe("Failure")
    if (outcome._tag !== "Failure") throw new Error("expected a broker denial")
    expect(outcome.failure._tag).toBe("RemoteTransportError")
    expect(outcome.failure.operation).toBe("publish")
    expect(String(outcome.failure.cause).toLowerCase()).toContain("permissions violation")
  }, 30_000)

  test("the broker denies a runner credential pulling another host's durable consumer", async () => {
    const outcome = await runAs(
      runnerA,
      Effect.gen(function* () {
        const transport = yield* RemoteTransport
        return yield* transport.takeHost("host-b", 2_000).pipe(Effect.result)
      }),
    )

    expect(outcome._tag).toBe("Failure")
    if (outcome._tag !== "Failure") throw new Error("expected a broker denial")
    expect(outcome.failure._tag).toBe("RemoteTransportError")
    expect(outcome.failure.operation).toBe("consume")
    expect(String(outcome.failure.cause).toLowerCase()).toContain("permissions violation")
  }, 30_000)
})
