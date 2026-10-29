import { expect, test } from "bun:test"
import { Effect, Schedule } from "effect"
import { startDirectoryDaemon } from "./harness"
import { relay } from "./relay"
import { KernelEventStore } from "../../src/kernel/event-store"

test("public events cannot impersonate protected kernel completion events", async () => {
  const daemon = await startDirectoryDaemon("host-a", ":memory:")
  try {
    const condition = {
      type: "mailbox.result",
      version: 1,
      key: "protected",
      correlation: "protected",
    }
    await daemon.runtime.runPromise(
      Effect.gen(function* () {
        const events = yield* KernelEventStore
        yield* events.createInstance({
          instanceId: "protected",
          workflowType: "mailbox_subscription",
          workflowVersion: 1,
          workflowKey: "protected",
          payload: null,
          createdAt: new Date(),
        })
        yield* events.registerWait({
          instanceId: "protected",
          waitId: "protected",
          condition,
          registeredAt: new Date(),
        })
      }),
    )
    expect(
      (
        await daemon.request("/messaging/publish", {
          method: "POST",
          body: JSON.stringify({
            id: crypto.randomUUID(),
            event: { ...condition, payload: { pretend: "completed" } },
          }),
        })
      ).status,
    ).toBe(202)
    expect(
      await daemon.runtime.runPromise(
        Effect.gen(function* () {
          return yield* (yield* KernelEventStore).readReadyDeliveries("protected")
        }),
      ),
    ).toEqual([])
  } finally {
    await daemon.stop()
  }
})

test("one-shot correlated event subscriptions atomically route a stable message and support cancellation", async () => {
  const agent = relay()
  const daemon = await startDirectoryDaemon("host-a", ":memory:")
  const post = (path: string, body: unknown) =>
    daemon.request(`/messaging/${path}`, { method: "POST", body: JSON.stringify(body) })
  try {
    await daemon.request("/directory/registrations", {
      method: "POST",
      body: JSON.stringify(agent.registration),
    })
    const condition = {
      type: "external.finished",
      version: 1,
      key: "external-item",
      correlation: "conversation",
    }
    const subscription = { id: crypto.randomUUID(), recipient: agent.id, condition }
    expect((await post("subscribe", subscription)).status).toBe(202)
    expect((await post("subscribe", subscription)).status).toBe(202)
    const canceled = { ...subscription, id: crypto.randomUUID() }
    expect((await post("subscribe", canceled)).status).toBe(202)
    expect((await post("cancel", { id: canceled.id })).status).toBe(200)
    const event = {
      id: crypto.randomUUID(),
      event: { ...condition, payload: { result: "success" } },
    }
    expect(
      (await post("publish", { ...event, event: { ...event.event, correlation: "unrelated" } }))
        .status,
    ).toBe(202)
    expect(agent.received).toHaveLength(0)
    expect((await post("publish", { ...event, id: crypto.randomUUID() })).status).toBe(202)
    await Effect.runPromise(
      Effect.tryPromise(async () => {
        if (agent.received.length !== 1) throw new Error("event not delivered")
      }).pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 })),
    )
    expect(agent.received[0]).toMatchObject({
      message: {
        recipient: agent.id,
        correlation: "conversation",
        payload: { type: "external.finished", version: 1, data: { result: "success" } },
      },
    })
  } finally {
    await daemon.stop()
    await agent.server.stop(true)
  }
})
