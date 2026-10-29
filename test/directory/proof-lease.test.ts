import { expect, test } from "bun:test"
import { Effect, Layer, Redacted, Schema } from "effect"
import { DirectoryStore } from "../../src/directory/store"
import { DirectoryResponder, DirectoryResponderLive } from "../../src/directory/responder"
import {
  DirectoryPage,
  DirectoryAdvertisement,
  directoryBytes,
  directoryMac,
} from "../../src/directory/wire"
import { ExecutionDiscovery } from "../../src/execution-capabilities"
import { RemoteTransport } from "../../src/remote/transport"
import { managedStores, seedManaged } from "./managed-fixture"

test("signed challenge and runner freshness do not shorten or renew native source proof", async () => {
  const credential = Redacted.make("inert-enrolled-host-credential-for-tests")
  const replies: Uint8Array[] = []
  const responder = DirectoryResponderLive("host-a", {
    coordinatorHostId: "coordinator",
    credential,
    codexEnabled: false,
    codexBinary: "unused",
  }).pipe(
    Layer.provide(
      Layer.succeed(ExecutionDiscovery, {
        list: () => Effect.succeed({ capabilities: [], sources: [] }),
      }),
    ),
    Layer.provide(
      Layer.mock(RemoteTransport, {
        publishRaw: (_subject, bytes) =>
          Effect.sync(() => {
            replies.push(bytes)
          }),
      }),
    ),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* DirectoryStore
      const at = new Date(Date.now() - 45_000)
      yield* store.bindLocalHost("host-a")
      yield* seedManaged("remote-proof", at, "http://fixture.local")
      yield* store.observeManaged(
        "remote-proof",
        { nativeSessionId: "ses_remote-proof", directory: "/fixture/remote-proof" },
        at,
        90_000,
      )
      const local = (yield* store.managed(new Date(), 90_000))[0]
      const command = {
        version: 1,
        kind: "directory_observe",
        hostId: "host-a",
        coordinatorHostId: "coordinator",
        generation: 1,
        nonce: crypto.randomUUID(),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 34_000).toISOString(),
      } as const
      const bytes = directoryBytes({ ...command, signature: directoryMac(credential, command) })
      yield* Effect.gen(function* () {
        const service = yield* DirectoryResponder
        yield* service.handle(bytes)
        const first = replies.slice()
        yield* service.handle(bytes)
        expect(replies.slice(first.length)).toEqual(first)
      }).pipe(Effect.provide(responder))
      const pages = replies
        .slice(0, replies.length / 2)
        .map((bytes) =>
          Schema.decodeUnknownSync(Schema.fromJsonString(DirectoryPage))(
            new TextDecoder().decode(bytes),
          ),
        )
      const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(DirectoryAdvertisement))(
        pages.map((page) => page.content).join(""),
      ).snapshot
      expect(snapshot.agents[0]).toEqual(local)
      expect(snapshot.agents[0]?.status).toBe("active")
      const runner = snapshot.runners[0]
      if (runner?.expiresAt == null || runner.observedAt == null)
        throw new Error("Missing live runner proof")
      expect(Date.parse(runner.expiresAt) - Date.parse(runner.observedAt)).toBe(34_000)
      expect((yield* store.managed(new Date(at.getTime() + 90_000), 300_000))[0]?.status).toBe(
        "expired",
      )
      expect((yield* store.managed(new Date(), 90_000))[0]?.observedAt).toBe(at.toISOString())
    }).pipe(Effect.provide(managedStores())),
  )
})
