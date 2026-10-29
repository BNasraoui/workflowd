import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Deferred, Effect, Fiber, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DirectoryResponder, DirectoryResponderLive } from "../../src/directory/responder"
import { DirectoryStoreLive } from "../../src/directory/store"
import { ExecutionDiscovery } from "../../src/execution-capabilities"
import { RemoteTransport } from "../../src/remote/transport"
import {
  DirectoryPage,
  DirectoryObserve,
  directoryBytes,
  directoryMac,
} from "../../src/directory/wire"
import { WorkflowStoreLive } from "../../src/store"

const credential = Redacted.make("isolated-runner-credential-".repeat(3))
const command = (generation: number): DirectoryObserve => {
  const document = {
    version: 1 as const,
    kind: "directory_observe" as const,
    hostId: "host-b",
    coordinatorHostId: "host-a",
    generation,
    nonce: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
  }
  return { ...document, signature: directoryMac(credential, document) }
}
const setup = (
  filename: string,
  list: typeof ExecutionDiscovery.Service.list,
  published: Uint8Array[],
) => {
  const database = SqliteClient.layer({ filename })
  const store = DirectoryStoreLive.pipe(
    Layer.provide(WorkflowStoreLive.pipe(Layer.provideMerge(database))),
  )
  return DirectoryResponderLive("host-b", {
    coordinatorHostId: "host-a",
    credential,
    codexEnabled: false,
    codexBinary: "unused",
  }).pipe(
    Layer.provideMerge(database),
    Layer.provide(store),
    Layer.provide(Layer.succeed(ExecutionDiscovery, { list })),
    Layer.provide(
      Layer.mock(RemoteTransport, {
        publishRaw: (_subject, data) =>
          Effect.sync(() => {
            published.push(data)
          }),
      }),
    ),
  )
}

test("late concurrent discovery cannot overwrite a newer durable runner response", async () => {
  const published: Uint8Array[] = []
  const firstStarted = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<void>())
  let calls = 0
  const list = () =>
    Effect.gen(function* () {
      calls++
      if (calls === 1) {
        yield* Deferred.succeed(firstStarted, undefined)
        yield* Deferred.await(release)
      }
      return { capabilities: [], sources: [] }
    })
  await Effect.runPromise(
    Effect.gen(function* () {
      const responder = yield* DirectoryResponder
      const sql = yield* SqlClient.SqlClient
      const older = command(1)
      const newer = command(2)
      const pending = yield* responder.handle(directoryBytes(older)).pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      yield* responder.handle(directoryBytes(newer))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(pending)
      const rows = yield* sql`SELECT generation FROM directory_runner_responses`
      expect(rows[0]?.generation).toBe(2)
      yield* responder.handle(directoryBytes(newer))
      expect(calls).toBe(2)
      expect(
        published.map(
          (bytes) =>
            Schema.decodeUnknownSync(Schema.fromJsonString(DirectoryPage))(
              new TextDecoder().decode(bytes),
            ).generation,
        ),
      ).toEqual([2, 2])
    }).pipe(Effect.provide(setup(":memory:", list, published))),
  )
})

test("runner rejects forged host/credential challenges and replays the original response after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccw3-responder-"))
  const database = join(root, "runner.db")
  const published: Uint8Array[] = []
  const valid = command(1)
  let calls = 0
  const list = () =>
    Effect.sync(() => {
      calls++
      return { capabilities: [], sources: [] }
    })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const responder = yield* DirectoryResponder
        yield* responder.handle(directoryBytes({ ...valid, hostId: "host-c" }))
        yield* responder.handle(directoryBytes({ ...valid, signature: "0".repeat(64) }))
        expect(calls).toBe(0)
        expect(published).toHaveLength(0)
        yield* responder.handle(directoryBytes(valid))
        yield* responder.handle(directoryBytes(valid))
        expect(calls).toBe(1)
        expect(published[1]).toEqual(published[0])
      }).pipe(Effect.provide(setup(database, list, published))),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const responder = yield* DirectoryResponder
        yield* responder.handle(directoryBytes(valid))
        expect(calls).toBe(1)
        expect(published[2]).toEqual(published[0])
        const divergent = command(1)
        const result = yield* responder.handle(directoryBytes(divergent)).pipe(Effect.result)
        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "stale_binding" } })
      }).pipe(Effect.provide(setup(database, list, published))),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
