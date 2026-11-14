import { expect, test } from "bun:test"
import { capabilityHttpServer } from "../../src/capability-gateway/http"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { Effect, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { seedCapabilityRun, transport } from "./fixture"

test("bound streaming preserves native bytes, renews with noscope, and denies cross-run or proxy authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "wfd-gateway-"))
  await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
  await writeFile(
    join(root, "noscope/providers/run-capability.toml"),
    `contract_version = 1\n[commands]\nmint = "${process.execPath} ${resolve("src/capability-gateway/noscope-provider.ts")} run {ttl}"\n`,
    { mode: 0o600 },
  )
  await writeFile(
    join(root, "access.mjs"),
    `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(join(root, "mint-count"))},'x');process.stdout.write(JSON.stringify({token:"fixture-access",token_id:"fixture",expires_at:new Date(Date.now()+120000).toISOString()}))`,
  )
  await writeFile(
    join(root, "noscope/providers/provider-access.toml"),
    `contract_version = 1\n[commands]\nmint = "${process.execPath} ${join(root, "access.mjs")}"\n`,
    { mode: 0o600 },
  )
  const sent: { url: string; body: string; headers: Headers }[] = []
  const native = '{ "model" : "fixture-model", "stream": true, "messages": [] }'
  const responseBytes = "event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n"
  let reflect: string | undefined
  let upstreamFault: string | undefined
  let stalled = false
  const blocked = Promise.withResolvers<void>()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { leases } = yield* seedCapabilityRun(Date.now())
        const gateway = yield* makeCapabilityGateway(
          {
            noscope: { binary: fixtureExecutable("noscope"), configHome: root },
            providerId: "anthropic",
            credentialRole: "fixture",
            maxStreams: 8,
            maxStreamsPerRun: 2,
          },
          async (url, init) => {
            sent.push({
              url,
              body: Buffer.from(init.body).toString(),
              headers: new Headers(init.headers),
            })
            if (upstreamFault)
              return new Response("fixture-upstream-error", {
                status: upstreamFault === "redirect" ? 302 : 200,
                headers:
                  upstreamFault === "redirect"
                    ? { location: "http://127.0.0.1/forbidden" }
                    : upstreamFault === "encoding"
                      ? { "content-encoding": "gzip" }
                      : { "request-id": "fixture-access" },
              })
            if (stalled)
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(
                      new TextEncoder().encode(
                        "event: message_start\ndata: " + "x".repeat(256) + "\n\n",
                      ),
                    )
                  },
                  pull() {
                    blocked.resolve()
                  },
                }),
              )
            return new Response(
              reflect
                ? new ReadableStream({
                    start(controller) {
                      controller.enqueue(
                        new TextEncoder().encode(
                          "event: message_start\ndata: " + reflect?.slice(0, 7),
                        ),
                      )
                      controller.enqueue(new TextEncoder().encode(reflect?.slice(7) + "\n\n"))
                      controller.close()
                    },
                  })
                : responseBytes,
              {
                headers: {
                  "content-type": "text/event-stream",
                  "request-id": "fixture-request",
                  authorization: "fixture-access",
                },
              },
            )
          },
        )
        const challenge = yield* gateway.challenge("run", transport)
        const issued = yield* gateway.bind(challenge, "fixture-jti")
        yield* leases.bind("run", 78, 1, transport)
        const request = (
          path = "/capabilities/v1/providers/anthropic/v1/messages",
          token = issued.token,
          body = native,
          extra: Record<string, string> = {},
        ) =>
          new Request(`http://capability.invalid${path}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "oauth-2025-04-20",
              ...extra,
            },
            body,
          })
        const valid = yield* gateway.handle(issued.binding, request())
        expect(valid.status).toBe(200)
        expect(yield* Effect.promise(() => valid.text())).toBe(responseBytes)
        expect(valid.headers.has("authorization")).toBe(false)
        expect(sent[0]?.body).toBe(native)
        expect(sent[0]?.url).toBe("https://api.anthropic.com/v1/messages")
        expect(sent[0]?.headers.get("authorization")).toBe("Bearer fixture-access")
        expect(sent[0]?.headers.has("x-api-key")).toBe(false)
        let upload: ReadableStreamDefaultController<Uint8Array> | undefined
        let cancelledUpload = false
        const oversizedRenewal = new Request("http://capability.invalid/capabilities/v1/renew", {
          method: "POST",
          headers: { authorization: `Bearer ${issued.token}` },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              upload = controller
              controller.enqueue(new TextEncoder().encode("{}x"))
            },
            cancel() {
              cancelledUpload = true
            },
          }),
        })
        const pendingRenewal = Effect.runPromise(gateway.handle(issued.binding, oversizedRenewal))
        const bounded = yield* Effect.promise(() =>
          Promise.race([
            pendingRenewal.then((response) => response.status),
            Bun.sleep(500).then(() => "unbounded"),
          ]),
        )
        if (!cancelledUpload) upload?.close()
        yield* Effect.promise(() => pendingRenewal)
        expect(bounded).toBe(403)
        expect(cancelledUpload).toBe(true)
        for (const denied of [
          request(undefined, "foreign"),
          request(undefined, undefined, native.replace("fixture-model", "other-model")),
          request("/capabilities/v1/providers/anthropic/https://attacker.invalid"),
          request("/capabilities/v1/providers/anthropic/v1/messages?url=http://127.0.0.1"),
          request(undefined, undefined, native, { "x-api-key": "client-key" }),
          request(undefined, undefined, native, { "x-workflowd-run": "other" }),
          request(undefined, undefined, native, { host: "127.0.0.1" }),
          request(undefined, undefined, native, { "user-agent": "x".repeat(2049) }),
          request(undefined, undefined, native, { "content-encoding": "gzip" }),
          request(undefined, undefined, "x".repeat(1048577)),
          request(undefined, undefined, native, {
            authorization: `Bearer ${issued.token}, Bearer ${issued.token}`,
          }),
        ])
          expect((yield* gateway.handle(issued.binding, denied)).status).toBe(403)
        expect(
          (yield* gateway.handle({ ...issued.binding, channel: "0".repeat(64) }, request())).status,
        ).toBe(403)
        expect(sent.length).toBe(1)
        expect(yield* Effect.promise(() => readFile(join(root, "mint-count"), "utf8"))).toBe("x")
        const renew = yield* gateway.handle(
          issued.binding,
          request("/capabilities/v1/renew", issued.token, "{}"),
        )
        expect(renew.status).toBe(200)
        const successor = yield* Effect.promise(() => renew.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String }))),
        )
        const retries = yield* Effect.all(
          Array.from({ length: 12 }, () =>
            gateway.handle(issued.binding, request("/capabilities/v1/renew", issued.token, "{}")),
          ),
          { concurrency: "unbounded" },
        )
        for (const retry of retries) {
          expect(retry.status).toBe(200)
          const repeated = yield* Effect.promise(() => retry.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String }))),
          )
          expect(repeated.token).toBe(successor.token)
        }
        const next = yield* gateway.handle(issued.binding, request(undefined, successor.token))
        expect(next.status).toBe(200)
        yield* Effect.promise(() => next.text())
        for (const form of [
          "fixture-access",
          Buffer.from("fixture-access").toString("base64"),
          Buffer.from("fixture-access").toString("hex"),
        ]) {
          reflect = form
          const reflected = yield* gateway.handle(
            issued.binding,
            request(undefined, successor.token),
          )
          yield* Effect.promise(async () => {
            await expect(reflected.text()).rejects.toThrow("capability stream interrupted")
          })
        }
        reflect = undefined
        for (const fault of ["redirect", "encoding", "header"]) {
          upstreamFault = fault
          expect((yield* gateway.handle(issued.binding, request())).status).toBe(503)
          upstreamFault = undefined
          const control = yield* gateway.handle(issued.binding, request())
          expect(yield* Effect.promise(() => control.text())).toBe(responseBytes)
        }
        const beforeRevocation = sent.length
        stalled = true
        const http = capabilityHttpServer(() =>
          Effect.runPromise(gateway.handle(issued.binding, request())),
        )
        yield* Effect.promise(
          () => new Promise<void>((resolve) => http.server.listen(0, "127.0.0.1", resolve)),
        )
        try {
          const address = http.server.address()
          if (!address || typeof address === "string")
            throw new Error("Fixture listener unavailable")
          const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${address.port}`))
          expect(response.status).toBe(200)
          if (!response.body) throw new Error("missing streaming body")
          const reader = response.body.getReader()
          expect((yield* Effect.promise(() => reader.read())).done).toBe(false)
          yield* Effect.promise(() => blocked.promise)
          const ending = reader.read().then(
            (item) => (item.done ? "clean-eof" : "chunk"),
            () => "reset",
          )
          yield* gateway.revoke("run")
          expect(yield* Effect.promise(() => ending)).toBe("reset")
        } finally {
          yield* Effect.promise(http.close)
        }
        expect(
          (yield* gateway.handle(issued.binding, request(undefined, successor.token))).status,
        ).toBe(403)
        expect(
          (yield* gateway.handle(
            issued.binding,
            request("/capabilities/v1/renew", issued.token, "{}"),
          )).status,
        ).toBe(403)
        expect(sent.length).toBe(beforeRevocation + 1)
      }).pipe(
        Effect.provide(AgentRunStoreLive),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.scoped,
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
