import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schedule, Schema } from "effect"
import { MessageRecord } from "../../src/messaging/contract"
import { startDirectoryDaemon } from "./harness"
import { relay } from "./relay"

const delivered = (daemon: Awaited<ReturnType<typeof startDirectoryDaemon>>, id: string) =>
  Effect.runPromise(
    Effect.tryPromise(async () => {
      const result = Schema.decodeUnknownSync(MessageRecord)(
        await (await daemon.request(`/messaging/messages/${id}`)).json(),
      )
      if (result.delivery !== "delivered") throw new Error(`delivery=${result.delivery}`)
      return result
    }).pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 150 })),
  )

test("lost relay acknowledgement is queried across daemon restart without repeating the accepted native operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflowd-messages-"))
  const agent = relay("host-a", true)
  let daemon = await startDirectoryDaemon("host-a", join(root, "host.db"))
  const message = {
    id: crypto.randomUUID(),
    sender: "host:host-a",
    recipient: agent.id,
    correlation: "conversation",
    replyTo: null,
    payload: { type: "note", version: 1, data: "hello" },
  }
  try {
    expect(
      (
        await daemon.request("/directory/registrations", {
          method: "POST",
          body: JSON.stringify(agent.registration),
        })
      ).status,
    ).toBe(202)
    expect(
      (
        await daemon.request("/messaging/send", {
          method: "POST",
          body: JSON.stringify({ message }),
        })
      ).status,
    ).toBe(202)
    await Effect.runPromise(
      Effect.tryPromise(async () => {
        if (agent.received.length !== 1) throw new Error("not attempted")
      }).pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 })),
    )
    await daemon.stop()
    daemon = await startDirectoryDaemon("host-a", join(root, "host.db"))
    expect(await delivered(daemon, message.id)).toMatchObject({
      message,
      delivery: "delivered",
      started: true,
    })
    expect(agent.received).toHaveLength(1)
  } finally {
    await daemon.stop()
    await agent.server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test("an external relay's registration proof is not a delivery receipt", async () => {
  const agent = relay()
  const daemon = await startDirectoryDaemon("host-a", ":memory:")
  try {
    await daemon.request("/directory/registrations", {
      method: "POST",
      body: JSON.stringify(agent.registration),
    })
    const message = {
      id: crypto.randomUUID(),
      sender: "host:host-a",
      recipient: agent.id,
      correlation: "c",
      replyTo: null,
      payload: { type: "note", version: 1, data: "hello" },
    }
    await daemon.request("/messaging/send", { method: "POST", body: JSON.stringify({ message }) })
    expect(await delivered(daemon, message.id)).toMatchObject({ delivery: "delivered" })
    expect(agent.received).toHaveLength(1)
    const reply = {
      ...message,
      id: crypto.randomUUID(),
      sender: agent.id,
      recipient: "host:host-a",
      replyTo: message.id,
    }
    // Hosts are authenticated senders, not invented agent delivery endpoints.
    expect(
      (
        await daemon.request("/messaging/send", {
          method: "POST",
          body: JSON.stringify({
            message: reply,
            proof: { publicKey: agent.publicKey, signature: agent.signature(reply) },
          }),
        })
      ).status,
    ).toBe(503)
  } finally {
    await daemon.stop()
    await agent.server.stop(true)
  }
})
