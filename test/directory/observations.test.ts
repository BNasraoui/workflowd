import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { generateKeyPairSync, sign } from "node:crypto"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Redacted } from "effect"
import { DirectoryRemoteStore, DirectoryRemoteStoreLive } from "../../src/directory/remote-store"
import { DirectoryStore, DirectoryStoreLive } from "../../src/directory/store"
import { WorkflowStoreLive } from "../../src/store"
import {
  type DirectoryAdvertisement,
  type DirectoryObserve,
  directoryMac,
} from "../../src/directory/wire"
import { externalRecipientId, registrationDocument } from "../../src/directory/proof"
import { type ExternalRegistration, type AgentRecipient } from "../../src/directory/contract"
import { canonicalJson } from "../../src/kernel/session-store-support"

const at = new Date("2026-10-01T12:00:00.000Z")
const credential = Redacted.make("isolated-host-credential-for-directory-tests")
const layer = (filename: string) =>
  Layer.merge(DirectoryRemoteStoreLive, DirectoryStoreLive).pipe(
    Layer.provideMerge(
      WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename }))),
    ),
  )
const advertisement = (
  hostId: string,
  nativeSessionId = "session-one",
): DirectoryAdvertisement => ({
  registrations: [],
  snapshot: {
    agents: [
      {
        recipientId: `managed:${hostId}:agent-run-fixture`,
        hostId,
        runnerId: `runner:${hostId}`,
        origin: "managed",
        runId: "agent-run-fixture",
        status: "active",
        endpoint: {
          harness: "opencode",
          transport: "opencode-http",
          address: "http://127.0.0.1:4096",
          nativeSessionId,
        },
        bindingVersion: nativeSessionId === "session-one" ? 1 : 2,
        observedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + 10_000).toISOString(),
        deliverable: true,
      },
    ],
    runners: [
      {
        runnerId: `runner:${hostId}`,
        hostId,
        status: "active",
        observedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + 10_000).toISOString(),
        catalog: {
          sources: [
            {
              executor: "codex:local",
              kind: "codex",
              protocol: "codex-app-server-v2",
              status: "available",
              checkedAt: at.toISOString(),
              observedAt: at.toISOString(),
              freshUntil: new Date(at.getTime() + 1000).toISOString(),
              stale: false,
            },
          ],
          capabilities: [
            {
              identity: {
                host: hostId,
                executor: "codex:local",
                provider: "provider",
                model: "same-model",
              },
              selectionModel: "picker-same-model",
              availability: "unknown",
              observedAt: at.toISOString(),
              thinking: {
                status: "advertised",
                efforts: [{ id: "xhigh" }],
                defaultEffort: "xhigh",
              },
            },
          ],
        },
      },
    ],
  },
})
const pages = (command: DirectoryObserve, value: DirectoryAdvertisement) => {
  const content = JSON.stringify(value)
  const pieces = [content.slice(0, 150), content.slice(150)]
  return pieces.map((content, page) => {
    const document = {
      version: 1 as const,
      kind: "directory_page" as const,
      hostId: command.hostId,
      coordinatorHostId: command.coordinatorHostId,
      generation: command.generation,
      nonce: command.nonce,
      page,
      total: pieces.length,
      content,
    }
    return { ...document, signature: directoryMac(credential, document) }
  })
}

test("complete observations survive restart; duplicates, partial pages and old challenges cannot renew or replace current bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccw3-observations-"))
  const database = join(root, "directory.db")
  try {
    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DirectoryRemoteStore
        const command = yield* store.prepare(
          { hostId: "host-b", credential },
          "host-a",
          at,
          100,
          2000,
        )
        expect(command).not.toBeNull()
        const response = pages(command!, advertisement("host-b"))
        expect(yield* store.accept(response[1]!, at, 2000)).toBe("partial")
        expect((yield* store.inventory(["host-b"], at)).runners[0]?.status).toBe("unavailable")
        expect(yield* store.accept(response[1]!, at, 2000)).toBe("partial")
        expect(yield* store.accept(response[0]!, at, 2000)).toBe("accepted")
        expect(yield* store.accept(response[0]!, new Date(at.getTime() + 500), 2000)).toBe(
          "duplicate",
        )
        const snapshot = yield* store.inventory(["host-b"], new Date(at.getTime() + 1500))
        expect(snapshot.runners[0]).toMatchObject({
          status: "active",
          expiresAt: new Date(at.getTime() + 2000).toISOString(),
          catalog: { sources: [{ stale: true }], capabilities: [{ availability: "unavailable" }] },
        })
        expect(snapshot.agents[0]).toMatchObject({
          deliverable: true,
          endpoint: { nativeSessionId: "session-one" },
        })
        return { command: command!, response }
      }).pipe(Effect.provide(layer(database))),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DirectoryRemoteStore
        const expiredAt = new Date(at.getTime() + 2000)
        const expired = yield* store.inventory(["host-b"], expiredAt)
        expect(expired.runners[0]?.status).toBe("expired")
        expect(expired.agents[0]).toMatchObject({ status: "expired", deliverable: false })
        const command = yield* store.prepare(
          { hostId: "host-b", credential },
          "host-a",
          expiredAt,
          100,
          2000,
        )
        expect(command?.generation).toBe(first.command.generation + 1)
        expect(yield* store.accept(first.response[1]!, expiredAt, 2000)).toBe("stale")
        const second = advertisement("host-b", "session-two")
        const response = pages(command!, second)
        yield* store.accept(response[0]!, expiredAt, 2000)
        yield* store.accept(response[1]!, expiredAt, 2000)
        expect((yield* store.inventory(["host-b"], expiredAt)).agents[0]).toMatchObject({
          recipientId: "managed:host-b:agent-run-fixture",
          endpoint: { nativeSessionId: "session-two" },
          deliverable: true,
        })
        expect(yield* store.accept(first.response[0]!, expiredAt, 2000)).toBe("stale")
        expect(
          (yield* store.inventory(["host-b"], expiredAt)).agents[0]?.endpoint?.nativeSessionId,
        ).toBe("session-two")
        const renewedAt = new Date(at.getTime() + 2200)
        const newer = yield* store.prepare(
          { hostId: "host-b", credential },
          "host-a",
          renewedAt,
          100,
          2000,
        )
        const regressed = pages(newer!, advertisement("host-b"))
        yield* store.accept(regressed[0]!, renewedAt, 2000)
        expect(
          yield* store.accept(regressed[1]!, renewedAt, 2000).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "stale_binding" } })
        expect(
          (yield* store.inventory(["host-b"], renewedAt)).agents[0]?.endpoint?.nativeSessionId,
        ).toBe("session-two")
        const malformedAt = new Date(at.getTime() + 4500)
        const fresh = yield* store.prepare(
          { hostId: "host-b", credential },
          "host-a",
          malformedAt,
          100,
          2000,
        )
        const malformed = advertisement("host-b", "session-two")
        const invalid = pages(fresh!, {
          ...malformed,
          snapshot: {
            ...malformed.snapshot,
            runners: malformed.snapshot.runners.map((runner) => ({
              ...runner,
              catalog: {
                ...runner.catalog,
                sources: runner.catalog.sources.map((source) => ({
                  ...source,
                  freshUntil: "not-a-time",
                })),
              },
            })),
          },
        })
        yield* store.accept(invalid[0]!, malformedAt, 2000)
        expect(
          yield* store.accept(invalid[1]!, malformedAt, 2000).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid_observation" } })
      }).pipe(Effect.provide(layer(database))),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("remote external binding cannot displace a locally registered owner at the same revision", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const local = yield* DirectoryStore
      const remote = yield* DirectoryRemoteStore
      yield* local.bindLocalHost("host-a")
      const owner = generateKeyPairSync("ed25519")
      const publicKey = owner.publicKey.export({ type: "spki", format: "der" }).toString("base64")
      const registration = (hostId: string, revision = 1): ExternalRegistration => {
        const document = {
          protocol: "workflowd-directory-register-v1" as const,
          hostId,
          publicKey,
          revision,
          endpoint: {
            harness: "codex" as const,
            transport: "relay-http" as const,
            address: "http://127.0.0.1:9876/",
            nativeSessionId: "external",
          },
        }
        return {
          ...document,
          signature: sign(null, Buffer.from(canonicalJson(document)), owner.privateKey).toString(
            "base64",
          ),
        }
      }
      yield* local.registerExternal(registration("host-a"), at, 2000)
      const foreign = registration("host-b")
      const value = advertisement("host-b")
      const external: AgentRecipient = {
        recipientId: externalRecipientId(publicKey),
        hostId: "host-b",
        runnerId: "runner:host-b",
        origin: "external",
        runId: null,
        status: "active",
        endpoint: foreign.endpoint,
        bindingVersion: 1,
        observedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + 2000).toISOString(),
        deliverable: true,
      }
      const command = yield* remote.prepare(
        { hostId: "host-b", credential },
        "host-a",
        at,
        100,
        2000,
      )
      const response = pages(command!, {
        snapshot: { ...value.snapshot, agents: [external] },
        registrations: [foreign],
      })
      yield* remote.accept(response[0]!, at, 2000)
      const result = yield* remote.accept(response[1]!, at, 2000).pipe(Effect.result)
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "stale_binding" } })
      expect((yield* local.external(at))[0]?.hostId).toBe("host-a")
      expect(registrationDocument(foreign).hostId).toBe("host-b")
      const transferred = registration("host-b", 2)
      // The failed assembly rolled back its second page; replace the first under a new challenge.
      const later = new Date(at.getTime() + 2000)
      const next = yield* remote.prepare(
        { hostId: "host-b", credential },
        "host-a",
        later,
        100,
        2000,
      )
      const accepted = pages(next!, {
        snapshot: {
          ...value.snapshot,
          agents: [
            {
              ...external,
              bindingVersion: 2,
              expiresAt: new Date(later.getTime() + 2000).toISOString(),
            },
          ],
        },
        registrations: [transferred],
      })
      yield* remote.accept(accepted[0]!, later, 2000)
      expect(yield* remote.accept(accepted[1]!, later, 2000)).toBe("accepted")
      expect(yield* local.external(later)).toHaveLength(0)
      expect((yield* remote.inventory(["host-b"], later)).agents[0]).toMatchObject({
        recipientId: external.recipientId,
        hostId: "host-b",
        bindingVersion: 2,
      })
      expect(
        yield* local.registerExternal(registration("host-a"), later, 2000).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "stale_binding" } })
      yield* local.registerExternal(registration("host-a", 3), later, 2000)
      expect((yield* local.external(later))[0]?.recipientId).toBe(external.recipientId)
      expect((yield* remote.inventory(["host-b"], later)).agents).toHaveLength(0)
    }).pipe(Effect.provide(layer(":memory:"))),
  )
})
