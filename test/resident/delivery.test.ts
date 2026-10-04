import { expect, test } from "bun:test"
import { Effect } from "effect"
import { deliverResident } from "../../src/resident/delivery"
const message = { id: "event1", thread_id: "thread1", prompt: "CI done", state: "prepared" }
test("idle and busy wakes use queue/add with a durable client ID", async () => {
  const calls: unknown[] = []
  await Effect.runPromise(
    deliverResident(async (method, params) => {
      calls.push([method, params])
      return {}
    }, message),
  )
  expect(calls).toEqual([
    [
      "thread/queue/add",
      {
        threadId: "thread1",
        clientUserMessageId: "event1",
        input: [{ type: "text", text: "CI done", text_elements: [] }],
      },
    ],
  ])
})
test("restart of an idle thread starts a turn with the same durable client ID", async () => {
  const calls: unknown[] = []
  const outcome = await Effect.runPromise(
    deliverResident(
      async (method, params) => {
        calls.push([method, params])
        return {}
      },
      { ...message, id: "restart:thread1:old-turn" },
      "start",
    ),
  )
  expect(outcome).toBe("delivered")
  expect(calls).toEqual([
    [
      "turn/start",
      {
        threadId: "thread1",
        clientUserMessageId: "restart:thread1:old-turn",
        input: [{ type: "text", text: "CI done", text_elements: [] }],
      },
    ],
  ])
})
test("restart reconciles a lost ack from queue/history; uncertain delivery never duplicates", async () => {
  for (const found of [true, false]) {
    const methods: string[] = []
    const result = await Effect.runPromise(
      deliverResident(
        async (method) => {
          methods.push(method)
          return method === "thread/queue/list"
            ? { data: [], nextCursor: null }
            : {
                thread: {
                  turns: [{ items: found ? [{ type: "userMessage", clientId: "event1" }] : [] }],
                },
              }
        },
        { ...message, state: "sending" },
      ),
    )
    expect(result).toBe(found ? "delivered" : "uncertain")
    expect(methods).not.toContain("thread/queue/add")
  }
})

for (const method of ["thread/queue/add", "thread/queue/list", "thread/read"]) {
  test(`rejected ${method} requires operator reconciliation`, async () => {
    const calls: string[] = []
    const outcome = await Effect.runPromise(
      deliverResident(
        async (called) => {
          calls.push(called)
          if (called === method) throw new Error("method not found")
          return { data: [], nextCursor: null }
        },
        { ...message, state: method === "thread/queue/add" ? "prepared" : "sending" },
      ),
    )
    expect(outcome).toBe("uncertain")
    expect(calls.filter((c) => c === method)).toHaveLength(1)
  })
}
