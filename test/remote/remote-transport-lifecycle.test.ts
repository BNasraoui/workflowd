import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { RemoteTransport, RemoteTransportLive } from "../../src/remote/transport"

describe("remote transport lifecycle", () => {
  test("acquires without waiting for an unreachable broker", async () => {
    const acquired = await Effect.runPromise(
      Effect.race(
        Effect.scoped(
          RemoteTransport.pipe(
            Effect.provide(RemoteTransportLive({ servers: ["nats://127.0.0.1:1"] })),
            Effect.as(true),
          ),
        ),
        Effect.sleep(250).pipe(Effect.as(false)),
      ),
    )

    expect(acquired).toBe(true)
  })
})
