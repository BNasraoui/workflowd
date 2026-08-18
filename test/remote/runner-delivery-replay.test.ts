import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { RemoteRunnerStore, RemoteRunnerStoreLive } from "../../src/remote/runner-store"
import { now } from "../kernel/job-store-harness"

test("runner classifies changed bytes under a durable delivery identity as conflict", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* RemoteRunnerStore
      const first = yield* store.recordBatch(
        "host-a",
        [{ deliveryId: "commands:1", data: new TextEncoder().encode("{"), rejection: "malformed" }],
        now,
      )
      const exact = yield* store.recordBatch(
        "host-a",
        [{ deliveryId: "commands:1", data: new TextEncoder().encode("{"), rejection: "malformed" }],
        now,
      )
      const changed = yield* store.recordBatch(
        "host-a",
        [
          {
            deliveryId: "commands:1",
            data: new TextEncoder().encode("[]"),
            rejection: "malformed",
          },
        ],
        now,
      )
      return { first, exact, changed, dispositions: yield* store.readDeliveryDispositions() }
    }).pipe(
      Effect.provide(RemoteRunnerStoreLive),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  )

  expect(result.first[0]?.disposition).toBe("malformed")
  expect(result.exact[0]?.disposition).toBe("malformed")
  expect(result.changed[0]?.disposition).toBe("conflict")
  expect(result.dispositions).toEqual(["conflict"])
})
