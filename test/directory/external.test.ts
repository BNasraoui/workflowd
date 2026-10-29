import { expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { loadConfig } from "../../src/config"
import { makeLiveLayer } from "../../src/layers"
import { startHookService } from "../../src/runtime"
import { canonicalJson } from "../../src/kernel/session-store-support"
import { JsonValueSchema, type JsonValue } from "../../src/json"

test("verified external owner can reconnect and rebind without acquiring native process or worktree custody", async () => {
  const owner = generateKeyPairSync("ed25519")
  const publicKey = owner.publicKey.export({ type: "spki", format: "der" }).toString("base64")
  const recipientId = `external:${createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex")}`
  const signature = (value: JsonValue) =>
    sign(null, Buffer.from(canonicalJson(value)), owner.privateKey).toString("base64")
  const endpoint = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) =>
      Response.json({
        signature: signature(Schema.decodeUnknownSync(JsonValueSchema)(await request.json())),
      }),
  })
  const config = await loadConfig({
    WORKFLOWD_MODE: "execution",
    WORKFLOWD_HOST_ID: "host-a",
    WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN: "directory-secret",
    WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "false",
  })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const server = yield* startHookService({ ...config, http: { ...config.http, port: 0 } })
        const binding = (revision: number, session: string) => {
          const value = {
            protocol: "workflowd-directory-register-v1",
            hostId: "host-a",
            publicKey,
            revision,
            endpoint: {
              harness: "codex",
              transport: "relay-http",
              address: endpoint.url.toString(),
              nativeSessionId: session,
            },
          }
          return { ...value, signature: signature(value) }
        }
        const post = (body: unknown) =>
          Effect.tryPromise(() =>
            fetch(new URL("/directory/registrations", server.url), {
              method: "POST",
              headers: {
                authorization: "Bearer directory-secret",
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            }),
          )
        const first = yield* post(binding(1, "native-one"))
        expect(first.status).toBe(202)
        expect(yield* Effect.tryPromise(() => first.json())).toMatchObject({
          recipientId,
          status: "registered",
        })
        const replay = yield* post(binding(1, "native-one"))
        expect(replay.status).toBe(202)
        expect(yield* Effect.tryPromise(() => replay.json())).toMatchObject({
          recipientId,
          status: "duplicate",
        })
        const conflict = yield* post(binding(1, "native-two"))
        expect(conflict.status).toBe(409)
        const rebound = yield* post(binding(2, "native-two"))
        expect(rebound.status).toBe(202)
        expect(yield* Effect.tryPromise(() => rebound.json())).toMatchObject({ recipientId })
        expect((yield* post(binding(1, "native-one"))).status).toBe(409)
        expect((yield* post({ ...binding(3, "stolen"), signature: "forged" })).status).toBe(409)
        expect(
          (yield* post({
            ...binding(3, "stolen"),
            recipientId: "managed:host-a:agent-run-foreign",
          })).status,
        ).toBe(400)
        expect((yield* post({ ...binding(3, "stolen"), cleanup: true })).status).toBe(400)
        const lookup = yield* Effect.tryPromise(() =>
          fetch(new URL(`/directory/agents/${encodeURIComponent(recipientId)}`, server.url), {
            headers: { authorization: "Bearer directory-secret" },
          }),
        )
        expect(lookup.status).toBe(200)
        expect(yield* Effect.tryPromise(() => lookup.json())).toMatchObject({
          origin: "external",
          runId: null,
          status: "active",
          deliverable: true,
          endpoint: { nativeSessionId: "native-two" },
          bindingVersion: 2,
        })
        const counts =
          yield* sql`SELECT (SELECT COUNT(*) FROM kernel_sessions) AS sessions, (SELECT COUNT(*) FROM kernel_working_resources) AS resources, (SELECT COUNT(*) FROM kernel_agent_runs) AS runs`
        expect(counts[0]).toEqual({ sessions: 0, resources: 0, runs: 0 })
        yield* Effect.tryPromise(() => endpoint.stop(true))
        expect((yield* post(binding(2, "native-two"))).status).toBe(409)
        const unavailable = yield* Effect.tryPromise(() =>
          fetch(new URL(`/directory/agents/${encodeURIComponent(recipientId)}`, server.url), {
            headers: { authorization: "Bearer directory-secret" },
          }).then((r) => r.json()),
        )
        expect(unavailable).toMatchObject({ status: "unavailable", deliverable: false })
        // A forged attempt cannot erase the legitimate binding after failed verification.
        const value = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ endpoint: Schema.Struct({ nativeSessionId: Schema.String }) }),
        )(unavailable)
        expect(value.endpoint.nativeSessionId).toBe("native-two")
      }).pipe(
        Effect.provide(
          makeLiveLayer(config).pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))),
        ),
        Effect.scoped,
      ),
    )
  } finally {
    await endpoint.stop(true)
  }
})
