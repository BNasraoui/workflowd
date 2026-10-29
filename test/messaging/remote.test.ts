import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schedule, Schema } from "effect"
import { connect } from "@nats-io/transport-node"
import { startDirectoryDaemon } from "./harness"
import { DirectorySnapshot } from "../../src/directory/contract"
import { MessageRecord, type AgentMessage } from "../../src/messaging/contract"
import { relay } from "./relay"

const docker = async (...args: string[]) => {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`docker failed: ${error}`)
  return out.trim()
}
const eventually = <A>(f: () => Promise<A>) =>
  Effect.runPromise(
    Effect.tryPromise(f).pipe(Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 160 })),
  )

test("two registered hosts deliver signed agent messages and replies over authenticated NATS, retaining custody across runner restart and partition", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-message-hosts-"))
  const container = `workflowd-messaging-${crypto.randomUUID()}`
  const a = relay("host-a")
  const b = relay("host-b", true)
  let hostA: Awaited<ReturnType<typeof startDirectoryDaemon>> | undefined
  let hostB: Awaited<ReturnType<typeof startDirectoryDaemon>> | undefined
  let runner: ReturnType<typeof Bun.spawn> | undefined
  let runnerLogs: Promise<string> | undefined
  try {
    await docker(
      "run",
      "-d",
      "--name",
      container,
      "-p",
      "127.0.0.1::4222",
      "nats:2.11.8-alpine",
      "-js",
      "--auth",
      "message-fixture-token",
    )
    const port = (await docker("port", container, "4222/tcp")).split(":").at(-1)!
    const server = `nats://127.0.0.1:${port}`
    await eventually(async () => {
      const nc = await connect({ servers: server, token: "message-fixture-token", timeout: 100 })
      await nc.drain()
    })
    const key = join(root, "peer.key")
    await writeFile(key, "isolated-message-peer-key-".repeat(3), { mode: 0o600 })
    hostA = await startDirectoryDaemon("host-a", join(root, "a.db"), {
      WORKFLOWD_DIRECTORY_PEERS: JSON.stringify({ "host-b": key }),
      WORKFLOWD_NATS_SERVERS: server,
      WORKFLOWD_NATS_TOKEN: "message-fixture-token",
      WORKFLOWD_DIRECTORY_REFRESH_MS: "200",
      WORKFLOWD_DIRECTORY_LEASE_MS: "4000",
    })
    hostB = await startDirectoryDaemon("host-b", join(root, "b.db"))
    const launch = () => {
      const child = Bun.spawn([process.execPath, "src/remote-runner.ts"], {
        cwd: join(import.meta.dir, "../.."),
        env: {
          PATH: process.env.PATH,
          WORKFLOWD_NATS_SERVERS: server,
          WORKFLOWD_NATS_TOKEN: "message-fixture-token",
          WORKFLOWD_REMOTE_HOST_ID: "host-b",
          WORKFLOWD_MESSAGING_ENABLED: "true",
          WORKFLOWD_REMOTE_DATABASE_PATH: join(root, "b.db"),
          WORKFLOWD_DIRECTORY_COORDINATOR_HOST: "host-a",
          WORKFLOWD_DIRECTORY_CREDENTIAL_FILE: key,
          WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "false",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      runnerLogs = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).then((x) => x.join("\n"))
      runner = child
    }
    launch()
    for (const [host, agent] of [
      [hostA, a],
      [hostB, b],
    ] as const)
      expect(
        (
          await host.request("/directory/registrations", {
            method: "POST",
            body: JSON.stringify(agent.registration),
          })
        ).status,
      ).toBe(202)
    await eventually(async () => {
      const snap = Schema.decodeUnknownSync(DirectorySnapshot)(
        await (await hostA!.request("/directory")).json(),
      )
      if (!snap.agents.some((x) => x.recipientId === b.id && x.deliverable))
        throw new Error("remote not observed")
    })
    runner!.kill()
    await runner!.exited
    await runnerLogs
    runner = undefined
    const first = {
      id: crypto.randomUUID(),
      sender: a.id,
      recipient: b.id,
      correlation: "conversation",
      replyTo: null,
      payload: { type: "question", version: 1, data: "hello" },
    }
    const send = async (message: AgentMessage, agent: typeof a) =>
      hostA!.request("/messaging/send", {
        method: "POST",
        body: JSON.stringify({
          message,
          proof: { publicKey: agent.publicKey, signature: agent.signature(message) },
        }),
      })
    expect((await send(first, a)).status).toBe(202)
    expect(b.received).toHaveLength(0)
    launch()
    await eventually(async () => {
      const row = Schema.decodeUnknownSync(MessageRecord)(
        await (await hostA!.request(`/messaging/messages/${first.id}`)).json(),
      )
      if (row.delivery !== "delivered") throw new Error(`remote ${row.delivery}`)
    })
    expect(b.received).toHaveLength(1)
    // External owners renew their own bounded lease; observing the runner does
    // not renew the source registration on host A.
    expect(
      (
        await hostA.request("/directory/registrations", {
          method: "POST",
          body: JSON.stringify(a.registration),
        })
      ).status,
    ).toBe(202)
    const reply = {
      ...first,
      id: crypto.randomUUID(),
      sender: b.id,
      recipient: a.id,
      replyTo: first.id,
    }
    const replyReceipt = await send(reply, b)
    if (replyReceipt.status !== 202)
      throw new Error(
        JSON.stringify({
          status: replyReceipt.status,
          body: await replyReceipt.json(),
          directory: await (await hostA.request("/directory")).json(),
        }),
      )
    expect(replyReceipt.status).toBe(202)
    await eventually(async () => {
      if (a.received.length !== 1) throw new Error("reply missing")
    })
    expect(a.received[0]).toMatchObject({
      message: { replyTo: first.id, correlation: "conversation", sender: b.id },
    })
    expect((await send(first, a)).status).toBe(202)
    expect(b.received).toHaveLength(1)
  } finally {
    if (runner !== undefined) {
      runner.kill()
      await runner.exited
      await runnerLogs
    }
    await hostA?.stop()
    await hostB?.stop()
    await a.server.stop(true)
    await b.server.stop(true)
    await docker("rm", "-f", container)
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
