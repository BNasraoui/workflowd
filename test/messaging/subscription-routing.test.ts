import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { managedStores, seedManaged } from "../directory/managed-fixture"
import { DirectoryStore } from "../../src/directory/store"
import { AgentDirectory } from "../../src/directory/service"
import { AgentMessaging, AgentMessagingLive } from "../../src/messaging/service"
import { makeMessageStore } from "../../src/messaging/store"
import { makeMessageSubscriptions } from "../../src/messaging/subscriptions"

test("subscriptions hold unsupported remote routes until compatibility returns, preserving cancellation and correlation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seedManaged("route", new Date(), "local://fixture")
      const local = yield* DirectoryStore
      yield* local.bindLocalHost("host-a")
      yield* local.observeManaged(
        "route",
        { nativeSessionId: "ses_route", directory: "/fixture/route" },
        new Date(),
      )
      const base = (yield* local.managed(new Date(), 90000))[0]!
      const remote = {
        ...base,
        recipientId: "managed:host-b:remote",
        runId: "remote",
        hostId: "host-b",
        runnerId: "runner:host-b",
        deliverable: true,
      }
      let compatible = false
      const directory = {
        inventory: () =>
          Effect.succeed({
            agents: [remote],
            runners: [
              {
                runnerId: "runner:host-b",
                hostId: "host-b",
                status: "active" as const,
                observedAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 90000).toISOString(),
                catalog: { capabilities: [], sources: [] },
                ...(compatible ? { messageProtocol: 1 as const } : {}),
              },
            ],
          }),
        register: () => Effect.die("unused"),
      }
      const messaging = yield* AgentMessaging.pipe(
        Effect.provide(
          AgentMessagingLive("host-a").pipe(
            Layer.provide(Layer.succeed(AgentDirectory, directory)),
          ),
        ),
      )
      const directInput = {
        message: {
          id: crypto.randomUUID(),
          sender: "host:host-a",
          recipient: remote.recipientId,
          correlation: "conversation",
          replyTo: null,
          payload: { type: "note", version: 1, data: null },
        },
      }
      const direct = yield* messaging.send(directInput).pipe(Effect.result)
      expect(direct._tag).toBe("Failure")
      if (direct._tag === "Failure") expect(direct.failure.reason).toBe("unsupported")
      const subscriptions = yield* makeMessageSubscriptions("host-a", directory)
      const condition = {
        type: "external.ready",
        version: 1,
        key: "build",
        correlation: "conversation",
      }
      const id = crypto.randomUUID()
      const cancelled = crypto.randomUUID()
      for (const subscription of [id, cancelled])
        yield* subscriptions.register({
          id: subscription,
          recipient: remote.recipientId,
          condition,
        })
      yield* subscriptions.publish({
        id: crypto.randomUUID(),
        event: { ...condition, correlation: "unrelated", payload: null },
      })
      expect((yield* subscriptions.read(id)).state).toBe("pending")
      yield* subscriptions.publish({
        id: crypto.randomUUID(),
        event: { ...condition, payload: { result: "ready" } },
      })
      yield* subscriptions.cancel(cancelled)
      for (let tick = 0; tick < 3; tick++) yield* subscriptions.reconcile()
      const messages = yield* makeMessageStore
      expect(yield* messages.pending()).toEqual([])
      expect((yield* subscriptions.read(id)).state).toBe("matched")
      compatible = true
      const resumed = yield* makeMessageSubscriptions("host-a", directory)
      yield* resumed.reconcile()
      expect((yield* resumed.read(id)).state).toBe("consumed")
      expect((yield* resumed.read(cancelled)).state).toBe("cancelled")
      const routed = yield* messages.pending()
      expect(routed).toHaveLength(1)
      expect(routed[0]?.message).toMatchObject({
        recipient: remote.recipientId,
        correlation: condition.correlation,
        payload: { type: condition.type, version: 1, data: { result: "ready" } },
      })
      const stableId = routed[0]!.message.id
      yield* resumed.reconcile()
      expect((yield* messages.pending()).map((row) => row.message.id)).toEqual([stableId])
      expect((yield* messaging.send(directInput)).status).toBe("accepted")
    }).pipe(Effect.scoped, Effect.provide(managedStores())),
  ))
