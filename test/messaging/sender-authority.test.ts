import { expect, test } from "bun:test"
import { Effect, Layer, Redacted, Schema } from "effect"
import { managedStores } from "../directory/managed-fixture"
import { relay } from "./relay"
import { DirectoryStore } from "../../src/directory/store"
import { ExternalRegistration } from "../../src/directory/contract"
import { directoryMac } from "../../src/directory/wire"
import { makeMessageRemote } from "../../src/messaging/remote"
import { makeMessageStore } from "../../src/messaging/store"
import { RemoteTransport } from "../../src/remote/transport"

test("an enrolled runner cannot impersonate another host's sender", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const directory = yield* DirectoryStore
      const store = yield* makeMessageStore
      const agent = yield* Effect.acquireRelease(
        Effect.sync(() => relay()),
        (agent) => Effect.promise(() => agent.server.stop(true)),
      )
      yield* directory.bindLocalHost("host-a")
      yield* directory.registerExternal(
        Schema.decodeUnknownSync(ExternalRegistration)(agent.registration),
        new Date(),
        90000,
      )
      const target = (yield* directory.external(new Date()))[0]!
      const credential = Redacted.make("isolated-host-b-message-authority-".repeat(2))
      const remote = yield* makeMessageRemote("host-a", [{ hostId: "host-b", credential }])
      const message = {
        id: crypto.randomUUID(),
        sender: "host:host-c",
        recipient: target.recipientId,
        correlation: "c",
        replyTo: null,
        payload: { type: "note", version: 1, data: "forged sender" },
      }
      const document = {
        version: 1 as const,
        kind: "agent_message" as const,
        fromHost: "host-b",
        toHost: "host-a",
        message,
        target,
      }
      yield* remote.handle(
        new TextEncoder().encode(
          JSON.stringify({ ...document, signature: directoryMac(credential, document) }),
        ),
      )
      expect(yield* store.read(message.id)).toBeNull()
      expect(agent.received).toEqual([])
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mock(RemoteTransport, {
          takeAgentMessages: () => Effect.succeed([]),
          publishRaw: () => Effect.void,
        }),
      ),
      Effect.provide(managedStores()),
    ),
  ))
