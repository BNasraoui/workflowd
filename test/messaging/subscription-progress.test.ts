import { expect, test } from "bun:test"
import { Effect } from "effect"
import { kernelLayer } from "../kernel/job-store-harness"
import { makeMessageSubscriptions } from "../../src/messaging/subscriptions"
import { makeMessageStore } from "../../src/messaging/store"
import { DirectoryError, type AgentRecipient } from "../../src/directory/contract"

const program = Effect.gen(function* () {
  const active: AgentRecipient = {
    recipientId: "external:active",
    hostId: "host-a",
    runnerId: "runner:host-a",
    origin: "external",
    runId: null,
    status: "active",
    endpoint: {
      harness: "claude",
      transport: "relay-http",
      address: "http://127.0.0.1:1234/",
      nativeSessionId: "external",
    },
    bindingVersion: 1,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90000).toISOString(),
    deliverable: true,
  }
  const unavailable: AgentRecipient = {
    ...active,
    recipientId: "external:parked",
    status: "unavailable",
    deliverable: false,
  }
  let parked = unavailable
  const subscriptions = yield* makeMessageSubscriptions("host-a", {
    inventory: () => Effect.succeed({ agents: [parked, active], runners: [] }),
    register: () => Effect.fail(new DirectoryError({ reason: "unavailable" })),
  })
  const condition = {
    type: "external.result",
    version: 1,
    key: "event",
    correlation: "conversation",
  }
  for (let index = 0; index < 100; index++)
    yield* subscriptions.register({
      id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      recipient: unavailable.recipientId,
      condition,
    })
  yield* subscriptions.register({
    id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    recipient: active.recipientId,
    condition,
  })
  yield* subscriptions.publish({
    id: crypto.randomUUID(),
    event: { ...condition, payload: { result: "success" } },
  })
  yield* subscriptions.reconcile()
  yield* subscriptions.reconcile()
  const pending = yield* (yield* makeMessageStore).pending()
  expect(pending.map((row) => row.message.recipient)).toEqual([active.recipientId])
  const parkedSubscription = "00000000-0000-0000-0000-000000000000"
  expect((yield* subscriptions.read(parkedSubscription)).state).toBe("matched")
  parked = { ...unavailable, status: "active", deliverable: true }
  yield* subscriptions.reconcile()
  yield* subscriptions.reconcile()
  expect((yield* subscriptions.read(parkedSubscription)).state).toBe("consumed")
})
test("unavailable subscriptions do not starve another recipient's correlated event", async () => {
  await Effect.runPromise(program.pipe(Effect.provide(kernelLayer(":memory:"))))
})
