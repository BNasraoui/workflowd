import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { makeMessageStore } from "../../src/messaging/store"
import { runStoreMigrations } from "../../src/store/migrations"
import type { AgentRecipient } from "../../src/directory/contract"

const target: AgentRecipient = {
  recipientId: "external:test",
  hostId: "host-a",
  runnerId: "runner:host-a",
  origin: "external",
  runId: null,
  status: "active",
  endpoint: {
    harness: "claude",
    transport: "relay-http",
    address: "http://127.0.0.1:1234/",
    nativeSessionId: "native",
  },
  bindingVersion: 1,
  observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 90000).toISOString(),
  deliverable: true,
}
test("pending outbox pages advance past uncertain messages instead of starving later accepted work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runStoreMigrations
      const store = yield* makeMessageStore
      let last = ""
      for (let index = 0; index < 101; index++) {
        const message = {
          id: crypto.randomUUID(),
          sender: "host:host-a",
          recipient: target.recipientId,
          correlation: "c",
          replyTo: null,
          payload: { type: "note", version: 1, data: index },
        }
        yield* store.accept(message, target, "host-a")
        yield* store.update(message.id, "uncertain")
        last = message.id
      }
      const page = yield* store.pending()
      expect(page).toHaveLength(100)
      expect(
        (yield* store.pending(page.at(-1)!.message.id)).map((record) => record.message.id),
      ).toEqual([last])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ))
test("durable message identity rejects conflicting content and fences concurrent sends", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runStoreMigrations
      const store = yield* makeMessageStore
      const message = {
        id: crypto.randomUUID(),
        sender: "host:host-a",
        recipient: target.recipientId,
        correlation: "conversation",
        replyTo: null,
        payload: { type: "note", version: 1, data: "hello" },
      }
      expect(yield* store.accept(message, target, "host-a")).toMatchObject({
        status: "accepted",
        delivery: "pending",
      })
      expect(yield* store.accept(message, target, "host-a")).toMatchObject({ status: "duplicate" })
      expect(
        (yield* store
          .accept({ ...message, correlation: "other" }, target, "host-a")
          .pipe(Effect.result))._tag,
      ).toBe("Failure")
      expect(
        yield* Effect.all([store.begin(message.id), store.begin(message.id)], { concurrency: 2 }),
      ).toEqual([true, false])
      yield* store.update(message.id, "uncertain")
      yield* store.update(message.id, "queued")
      expect((yield* store.read(message.id))?.delivery).toBe("uncertain")
      expect(yield* store.begin(message.id)).toBe(false)
      expect((yield* store.read(message.id))?.delivery).toBe("uncertain")
      yield* store.update(message.id, "delivered")
      yield* store.update(message.id, "uncertain")
      expect((yield* store.read(message.id))?.delivery).toBe("delivered")
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ))
