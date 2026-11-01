import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { managedStores, seedManaged } from "../directory/managed-fixture"
import { DirectoryStore } from "../../src/directory/store"
import { makeMessageStore } from "../../src/messaging/store"
import { makeMessageDelivery } from "../../src/messaging/delivery"
import { makeResidentStore } from "../../src/resident/store"
import { deliverResident } from "../../src/resident/delivery"

const message = (recipient: string) => ({
  id: crypto.randomUUID(),
  sender: "host:host-a",
  recipient,
  correlation: "review-conversation",
  replyTo: null,
  payload: { type: "review.note", version: 1, data: { text: "review inert input" } },
})
const seed = (id: string, kind: "codex" | "opencode" = "codex") =>
  Effect.gen(function* () {
    const directory = yield* DirectoryStore
    const inbox = yield* makeResidentStore
    yield* directory.bindLocalHost("host-a")
    yield* seedManaged(id, new Date(), "local://review", kind)
    yield* inbox.attach(id, `ses_${id}`, `/fixture/${id}`, null, kind)
    yield* directory.observeManaged(
      id,
      { nativeSessionId: `ses_${id}`, directory: `/fixture/${id}` },
      new Date(),
    )
    return (yield* directory.managed(new Date(), 90000)).find((x) => x.runId === id)!
  })

test.each(["sending", "delivered"] as const)(
  "native %s concurrent with rebind remains visible in the message receipt",
  (nativeState) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* DirectoryStore
        const inbox = yield* makeResidentStore
        const messages = yield* makeMessageStore
        const sql = yield* SqlClient.SqlClient
        const target = yield* seed("race")
        const input = message(target.recipientId)
        yield* messages.accept(input, target, "host-a")
        const delivery = yield* makeMessageDelivery("host-a")
        yield* delivery.pass()
        const queued = (yield* messages.read(input.id))!
        expect(queued.delivery).toBe("queued")
        let inject = false
        let nativeCalls = 0
        // This observation seam deterministically schedules the real native sender
        // after delivery has read its inbox snapshot, before the directory read.
        const observed = {
          ...directory,
          managed: (...args: Parameters<typeof directory.managed>) =>
            Effect.gen(function* () {
              if (!inject) {
                inject = true
                expect(yield* inbox.sending(`message:${input.id}`)).toBe(true)
                const outcome = yield* deliverResident(
                  async (method) => {
                    if (method === "thread/read")
                      return {
                        thread: {
                          id: "ses_race",
                          status: { type: "active" },
                          canAcceptDirectInput: true,
                        },
                      }
                    nativeCalls++
                    if (nativeState === "sending") throw new Error("lost native acknowledgement")
                    return {}
                  },
                  {
                    id: `message:${input.id}`,
                    thread_id: "ses_race",
                    prompt: "inert",
                    state: "prepared",
                  },
                  "auto",
                )
                expect(outcome).toBe(nativeState === "delivered" ? "delivered" : "uncertain")
                if (nativeState === "delivered") yield* inbox.delivered(`message:${input.id}`)
                yield* sql`UPDATE kernel_agent_runs SET native_session_id='replacement' WHERE run_id='race'`
              }
              return yield* directory.managed(...args)
            }),
        }
        const racing = yield* makeMessageDelivery("host-a").pipe(
          Effect.provideService(DirectoryStore, observed),
        )
        yield* racing.deliver(queued)
        yield* delivery.pass()
        expect(nativeCalls).toBe(1)
        expect(yield* inbox.deliveryState(`message:${input.id}`)).toBe(nativeState)
        expect((yield* messages.read(input.id))!.delivery).toBe(
          nativeState === "delivered" ? "delivered" : "uncertain",
        )
        if (nativeState === "sending") {
          yield* inbox.delivered(`message:${input.id}`)
          yield* delivery.pass()
          expect((yield* messages.read(input.id))!.delivery).toBe("delivered")
          expect(nativeCalls).toBe(1)
        }
      }).pipe(Effect.scoped, Effect.provide(managedStores())),
    ),
)
