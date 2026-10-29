import { expect, test } from "bun:test"
import { startDirectoryDaemon } from "./harness"
import { relay } from "./relay"

test("directory enrollment alone does not enable native message delivery authority", async () => {
  const daemon = await startDirectoryDaemon("host-a", ":memory:", {
    WORKFLOWD_MESSAGING_ENABLED: "false",
  })
  try {
    expect((await daemon.request("/messaging/messages/missing")).status).toBe(404)
    expect(
      (
        await daemon.request("/messaging/publish", {
          method: "POST",
          body: JSON.stringify({
            id: crypto.randomUUID(),
            event: {
              type: "external.event",
              version: 1,
              key: "item",
              correlation: "c",
              payload: null,
            },
          }),
        })
      ).status,
    ).toBe(404)
  } finally {
    await daemon.stop()
  }
})

test("HTTP accepts a durable signed agent message, distinguishes delivery, and rejects sender impersonation", async () => {
  const agent = relay()
  const daemon = await startDirectoryDaemon("host-a", ":memory:")
  const post = (path: string, body: unknown) =>
    daemon.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  try {
    expect((await post("/directory/registrations", agent.registration)).status).toBe(202)
    const message = {
      id: crypto.randomUUID(),
      sender: agent.id,
      recipient: agent.id,
      correlation: "conversation",
      replyTo: null,
      payload: { type: "question", version: 1, data: { text: "hello" } },
    }
    expect((await post("/messaging/send", { message })).status).toBe(403)
    const body = {
      message,
      proof: { publicKey: agent.publicKey, signature: agent.signature(message) },
    }
    const accepted = await post("/messaging/send", body)
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toMatchObject({ id: message.id, status: "accepted" })
    expect((await post("/messaging/send", body)).status).toBe(202)
    const conflict = { ...message, correlation: "different" }
    expect(
      (
        await post("/messaging/send", {
          message: conflict,
          proof: { publicKey: agent.publicKey, signature: agent.signature(conflict) },
        })
      ).status,
    ).toBe(409)
    const status = await daemon.request(`/messaging/messages/${message.id}`)
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ message, delivery: expect.any(String) })
    expect(
      (
        await fetch(new URL("/messaging/send", daemon.url), {
          method: "POST",
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(401)
  } finally {
    await daemon.stop()
    await agent.server.stop(true)
  }
})
