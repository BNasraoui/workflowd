import { ExternalRegistration } from "../../src/directory/contract"
import { relay } from "./relay"
import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { DirectoryStore } from "../../src/directory/store"
import { makeMessageStore } from "../../src/messaging/store"
import { makeMessageDelivery } from "../../src/messaging/delivery"
import { makeResidentStore } from "../../src/resident/store"
import { managedStores, seedManaged } from "../directory/managed-fixture"
import { deliverResident } from "../../src/resident/delivery"
import { SqlClient } from "effect/unstable/sql"
import { AgentMessaging, AgentMessagingLive } from "../../src/messaging/service"
import { AgentDirectoryLive } from "../../src/directory/service"
import { Layer } from "effect"

test("managed sending requires the authenticated run authority as well as a current logical recipient", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const directory = yield* DirectoryStore
      const inbox = yield* makeResidentStore
      yield* seedManaged("sender", new Date(), "local://fixture", "codex")
      yield* inbox.attach("sender", "ses_sender", "/fixture/sender", null)
      yield* directory.observeManaged(
        "sender",
        { nativeSessionId: "ses_sender", directory: "/fixture/sender" },
        new Date(),
      )
      const messaging = yield* AgentMessaging
      const sender = "managed:host-a:sender"
      const message = {
        id: crypto.randomUUID(),
        sender,
        recipient: sender,
        correlation: "c",
        replyTo: null,
        payload: { type: "note", version: 1, data: "hello" },
      }
      expect((yield* messaging.send({ message }).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* messaging.send({ message }, { runId: "sender" })).toMatchObject({
        status: "accepted",
      })
      expect(
        (yield* messaging
          .send(
            { message: { ...message, id: crypto.randomUUID(), sender: "managed:host-a:other" } },
            { runId: "sender" },
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure")
    }).pipe(
      Effect.provide(
        AgentMessagingLive("host-a").pipe(
          Layer.provideMerge(
            AgentDirectoryLive("host-a").pipe(Layer.provideMerge(managedStores())),
          ),
        ),
      ),
    ),
  ))

test.each(["active", "idle"])(
  "messaging reads actual loaded Codex %s state before choosing queue or turn start",
  async (status) => {
    const calls: string[] = []
    expect(
      await Effect.runPromise(
        deliverResident(
          async (method) => {
            calls.push(method)
            return {
              thread: { id: "thread", status: { type: status }, canAcceptDirectInput: true },
            }
          },
          { id: "message:test", thread_id: "thread", prompt: "hello", state: "prepared" },
          "auto",
        ),
      ),
    ).toBe("delivered")
    expect(calls).toEqual(["thread/read", status === "active" ? "thread/queue/add" : "turn/start"])
  },
)

test.each(["codex", "opencode"] as const)(
  "%s queue admission is durable and a stale directory binding cannot begin a native prompt",
  (kind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* DirectoryStore
        const inbox = yield* makeResidentStore
        const store = yield* makeMessageStore
        const now = new Date()
        yield* directory.bindLocalHost("host-a")
        yield* seedManaged("recipient", now, "local://fixture", kind)
        yield* inbox.attach("recipient", "ses_recipient", "/fixture/recipient", null, kind)
        yield* directory.observeManaged(
          "recipient",
          { nativeSessionId: "ses_recipient", directory: "/fixture/recipient" },
          now,
        )
        const target = (yield* directory.managed(now, 90000))[0]!
        expect(target.deliverable).toBe(true)
        const message = {
          id: crypto.randomUUID(),
          sender: "host:host-a",
          recipient: target.recipientId,
          correlation: "c",
          replyTo: null,
          payload: { type: "note", version: 1, data: "hello" },
        }
        yield* store.accept(message, target, "host-a")
        const delivery = yield* makeMessageDelivery("host-a")
        yield* delivery.pass()
        expect((yield* store.read(message.id))?.delivery).toBe("queued")
        expect(yield* inbox.deliveryState(`message:${message.id}`)).toBe("prepared")
        yield* directory.unavailableManaged("recipient", "ses_recipient")
        expect(yield* inbox.sending(`message:${message.id}`)).toBe(false)
        expect(yield* inbox.deliveryState(`message:${message.id}`)).toBe("prepared")
        yield* directory.observeManaged(
          "recipient",
          { nativeSessionId: "ses_recipient", directory: "/fixture/recipient" },
          new Date(),
        )
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE kernel_agent_runs SET native_session_id='replacement' WHERE run_id='recipient'`
        expect(yield* inbox.sending(`message:${message.id}`)).toBe(false)
        expect(yield* inbox.deliveryState(`message:${message.id}`)).toBe("operator_required")
        expect((yield* store.read(message.id))?.delivery).toBe("stale_binding")
      }).pipe(Effect.provide(managedStores())),
    ),
)

test("a rebound external endpoint cannot receive a message accepted for its previous revision", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const directory = yield* DirectoryStore
      const store = yield* makeMessageStore
      const agent = yield* Effect.acquireRelease(
        Effect.sync(() => relay()),
        (agent) => Effect.promise(() => agent.server.stop(true)),
      )
      const first = Schema.decodeUnknownSync(ExternalRegistration)(agent.registration)
      yield* directory.registerExternal(first, new Date(), 90000)
      const target = (yield* directory.external(new Date()))[0]!
      const message = {
        id: crypto.randomUUID(),
        sender: "host:host-a",
        recipient: target.recipientId,
        correlation: "c",
        replyTo: null,
        payload: { type: "note", version: 1, data: "old binding" },
      }
      yield* store.accept(message, target, "host-a")
      const { signature: _signature, ...old } = first
      const document = {
        ...old,
        revision: 2,
        endpoint: { ...old.endpoint, nativeSessionId: "replacement" },
      }
      yield* directory.registerExternal(
        { ...document, signature: agent.signature(document) },
        new Date(),
        90000,
      )
      yield* (yield* makeMessageDelivery("host-a")).pass()
      expect((yield* store.read(message.id))?.delivery).toBe("stale_binding")
      expect(agent.received).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(managedStores())),
  ))
