import { expect, test } from "bun:test"
import { Effect, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { startDirectoryDaemon } from "./harness"
import { relay } from "./relay"
import { makeMessageStore } from "../../src/messaging/store"
import { MessageRecord, MessagingError } from "../../src/messaging/contract"

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

test("an invalid persisted message refuses status and replay without losing custody or sending again", async () => {
  const agent = relay()
  const daemon = await startDirectoryDaemon("host-a", ":memory:")
  const message = {
    id: crypto.randomUUID(),
    sender: agent.id,
    recipient: agent.id,
    correlation: "persisted-schema",
    replyTo: null,
    payload: { type: "note", version: 1, data: "accepted before corruption" },
  }
  const send = () =>
    daemon.request("/messaging/send", {
      method: "POST",
      body: JSON.stringify({
        message,
        proof: { publicKey: agent.publicKey, signature: agent.signature(message) },
      }),
    })
  try {
    expect(
      (
        await daemon.request("/directory/registrations", {
          method: "POST",
          body: JSON.stringify(agent.registration),
        })
      ).status,
    ).toBe(202)
    expect((await send()).status).toBe(202)
    await Effect.runPromise(
      Effect.tryPromise(async () => {
        const response = await daemon.request(`/messaging/messages/${message.id}`)
        expect(response.status).toBe(200)
        const receipt = Schema.decodeUnknownSync(MessageRecord)(await response.json())
        if (receipt.delivery !== "delivered") throw new Error("delivery pending")
      }).pipe(Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 160 })),
    )
    expect(agent.received).toHaveLength(1)
    await daemon.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE agent_messages SET message_json='{}' WHERE id=${message.id}`
      }),
    )
    for (const response of [
      await daemon.request(`/messaging/messages/${message.id}`),
      await send(),
      await daemon.request(`/messaging/messages/${message.id}`),
    ]) {
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ reason: "unavailable" })
    }
    const refusal = await daemon.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* makeMessageStore
        return yield* store.read(message.id).pipe(Effect.result)
      }),
    )
    expect(refusal._tag).toBe("Failure")
    if (refusal._tag === "Failure") {
      const encoded = Schema.encodeSync(MessagingError)(refusal.failure)
      expect(encoded).toEqual({ _tag: "MessagingError", reason: "unavailable" })
      expect(Schema.decodeUnknownSync(MessagingError)(encoded)).toBeInstanceOf(MessagingError)
    }
    expect(
      await daemon.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql`SELECT delivery,message_json FROM agent_messages WHERE id=${message.id}`
        }),
      ),
    ).toEqual([{ delivery: "delivered", message_json: "{}" }])
    expect(agent.received).toHaveLength(1)
  } finally {
    await daemon.stop()
    await agent.server.stop(true)
  }
})
