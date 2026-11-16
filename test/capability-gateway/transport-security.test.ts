import { expect, test } from "bun:test"
import { capabilityApi, serveCapabilityListener } from "../../src/capability-gateway/http"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { Effect, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { connect } from "node:tls"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { bindRunSession, seedCapabilityRun, writeNoscopeProviders } from "./fixture"
import { loopbackCertificate, tlsFront } from "../helpers/loopback-tls"
import { client } from "./gateway-process"

test("bound streaming preserves native bytes, renews with noscope, and denies cross-run or proxy authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "wfd-gateway-"))
  await writeNoscopeProviders(root, 120000)
  const sent: { url: string; body: string; headers: Headers }[] = []
  const native = '{ "model" : "fixture-model", "stream": true, "messages": [], "max_tokens": 1000 }'
  const responseBytes = "event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n"
  let reflect: string | undefined
  let upstreamFault: string | undefined
  let stalled = false
  const blocked = Promise.withResolvers<void>()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCapabilityRun(Date.now(), true)
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
        // The run token is in its last five minutes, so it may be renewed.
        const issued = yield* bindRunSession(Date.now(), { expiresAt: Date.now() + 300000 })
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
        const valid = yield* gateway.handle(request())
        expect(valid.status).toBe(200)
        expect(yield* Effect.promise(() => valid.text())).toBe(responseBytes)
        expect(valid.headers.has("authorization")).toBe(false)
        expect(JSON.parse(sent[0]?.body ?? "")).toEqual(JSON.parse(native))
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
        const pendingRenewal = Effect.runPromise(gateway.handle(oversizedRenewal))
        const bounded = yield* Effect.promise(() =>
          Promise.race([
            pendingRenewal.then((response) => response.status),
            Bun.sleep(5000).then(() => "unbounded"),
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
          expect((yield* gateway.handle(denied)).status).toBe(403)
        expect(sent.length).toBe(1)
        expect(yield* Effect.promise(() => readFile(join(root, "access-mints"), "utf8"))).toBe("x")
        // A renewal asked again replaces the successor that has not renewed: the last one holds.
        const renewals: Array<{ readonly token: string }> = []
        for (let asked = 0; asked < 3; asked++) {
          const renew = yield* gateway.handle(request("/capabilities/v1/renew", issued.token, "{}"))
          expect(renew.status).toBe(200)
          renewals.push(
            yield* Effect.promise(() => renew.json()).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String }))),
            ),
          )
        }
        const successor = renewals[2]!
        for (const replaced of renewals.slice(0, 2))
          expect((yield* gateway.handle(request(undefined, replaced.token))).status).toBe(403)
        const next = yield* gateway.handle(request(undefined, successor.token))
        expect(next.status).toBe(200)
        yield* Effect.promise(() => next.text())
        for (const form of [
          "fixture-access",
          Buffer.from("fixture-access").toString("base64"),
          Buffer.from("fixture-access").toString("hex"),
        ]) {
          reflect = form
          const reflected = yield* gateway.handle(request(undefined, successor.token))
          yield* Effect.promise(async () => {
            await expect(reflected.text()).rejects.toThrow("capability stream interrupted")
          })
        }
        reflect = undefined
        for (const fault of ["redirect", "encoding", "header"]) {
          upstreamFault = fault
          expect((yield* gateway.handle(request())).status).toBe(503)
          upstreamFault = undefined
          const control = yield* gateway.handle(request())
          expect(yield* Effect.promise(() => control.text())).toBe(responseBytes)
        }
        const beforeRevocation = sent.length
        stalled = true
        const socket = join(root, "front", "gateway.sock")
        const front = yield* Effect.promise(async () =>
          tlsFront(await loopbackCertificate(root), socket),
        )
        const close = yield* Effect.promise(() =>
          serveCapabilityListener(
            {
              socket,
              front: { uid: process.getuid!(), gid: process.getgid!() },
              service: front.service,
            },
            capabilityApi(gateway),
          ),
        )
        try {
          const sentRequest = request()
          const response = yield* Effect.promise(() =>
            client(front).request(new URL(sentRequest.url).pathname, {
              method: "POST",
              headers: sentRequest.headers,
              body: native,
            }),
          )
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
          yield* Effect.promise(close)
          front.close()
        }
        expect((yield* gateway.handle(request(undefined, successor.token))).status).toBe(403)
        expect(
          (yield* gateway.handle(request("/capabilities/v1/renew", issued.token, "{}"))).status,
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

for (const attack of ["resets", "preface", "h2-preface", "truncated"] as const)
  test(`the gateway listener contains ${attack} and serves the next valid request`, async () => {
    let served = 0
    let partial = 0
    let entered = Promise.withResolvers<void>()
    const root = await mkdtemp(join(tmpdir(), "wfd-listener-"))
    const listenSocket = join(root, "front", "gateway.sock")
    const front = await tlsFront(await loopbackCertificate(root), listenSocket)
    let close: (() => Promise<void>) | undefined = await serveCapabilityListener(
      {
        socket: listenSocket,
        front: { uid: process.getuid!(), gid: process.getgid!() },
        service: front.service,
      },
      async (request) => {
        if (new URL(request.url).pathname !== "/valid") {
          partial++
          entered.resolve()
          await request.arrayBuffer()
        }
        served++
        return new Response("fixture-valid")
      },
    )
    const open = () => connect({ host: "127.0.0.1", port: front.port, ca: front.ca })
    const raw = (bytes: string, cut: boolean) =>
      new Promise<string>((resolve) => {
        const socket = open()
        let answer = ""
        socket.on("data", (chunk) => (answer += chunk.toString()))
        socket.on("error", () => {})
        socket.on("close", () => resolve(answer))
        // A reset peer leaves once the handler reads its body; a truncated one after its bytes.
        socket.write(bytes, () => {
          if (cut)
            void (attack === "resets" ? entered.promise : Bun.sleep(20)).then(() =>
              socket.destroy(),
            )
        })
      })
    const valid = () =>
      client(front)
        .request("/valid", { method: "POST", body: "{}" })
        .then((response) => response.text())
    const input = {
      resets: `POST /capabilities/v1/renew HTTP/1.1\r\nhost: ${front.service}\r\ncontent-length: 100\r\n\r\n{}`,
      preface: "invalid-http2-preface\r\n\r\n",
      "h2-preface": `PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n${String.fromCharCode(0, 0, 6, 4, 0)}`,
      truncated: `POST /valid HTTP/1.1\r\nhost: ${front.service}\r\ncontent-le`,
    }[attack]
    let hanging: ReturnType<typeof connect> | undefined
    try {
      for (let round = 0; round < 8; round++) {
        entered = Promise.withResolvers<void>()
        const answer = await raw(input, attack === "resets" || attack === "truncated")
        expect(answer).not.toContain("fixture-valid")
        expect(await valid()).toBe("fixture-valid")
      }
      // A peer error in the body never reaches an answer; framing errors never reach the handler.
      expect({ served, partial }).toEqual({ served: 8, partial: attack === "resets" ? 8 : 0 })
      // Shutdown is bounded with a client still holding a half-sent request.
      hanging = open()
      hanging.on("error", () => {})
      hanging.write(`POST /valid HTTP/1.1\r\nhost: ${front.service}\r\ncontent-length: 10\r\n\r\n{`)
      await Bun.sleep(50)
      const closing = close
      close = undefined
      expect(
        await Promise.race([closing().then(() => "closed"), Bun.sleep(10000).then(() => "held")]),
      ).toBe("closed")
    } finally {
      hanging?.destroy()
      await close?.()
      front.close()
      await rm(root, { recursive: true, force: true })
    }
  })
