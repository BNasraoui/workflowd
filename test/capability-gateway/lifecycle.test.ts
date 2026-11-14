import { expect, test } from "bun:test"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { Effect, Fiber } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer, type Socket } from "node:net"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { seedCapabilityRun, transport } from "./fixture"
import { makeNativeExecutionStore } from "../../src/sandbox/native-execution"
import { createServer as createHttpServer } from "node:http"

for (const [ending, phase] of [
  ["interrupt", "setup"],
  ["cancel", "setup"],
  ["release", "setup"],
  ["cancel", "body"],
  ["release", "body"],
  ["interrupt", "upload"],
  ["cancel", "result-upload"],
  ["interrupt", "mint"],
  ["cancel", "mint"],
  ["release", "mint"],
  ["sql-fault", "network-body"],
] as const) {
  test(`S1/R1: ${ending} aborts owned ${phase} and releases admission`, async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-lifetime-"))
    await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
    await writeFile(
      join(root, "noscope/providers/run-capability.toml"),
      `contract_version = 1\n[commands]\nmint = "${process.execPath} ${resolve("src/capability-gateway/noscope-provider.ts")} run {ttl}"\n`,
      { mode: 0o600 },
    )
    await writeFile(
      join(root, "access.mjs"),
      'console.log(JSON.stringify({token:"fixture-access",token_id:"fixture",expires_at:new Date(Date.now()+120000).toISOString()}))',
    )
    await writeFile(
      join(root, "noscope/providers/provider-access.toml"),
      `contract_version = 1\n[commands]\nmint = "${process.execPath} ${join(root, "access.mjs")}"\n`,
      { mode: 0o600 },
    )
    const started = Promise.withResolvers<AbortSignal | undefined>()
    let upload: ReadableStreamDefaultController<Uint8Array> | undefined
    let firstRequest = true
    let calls = 0
    let aborted = false
    const closed = Promise.withResolvers<void>()
    const upstream = createHttpServer((request, response) => {
      request.socket.once("close", () => {
        aborted = true
        closed.resolve()
      })
      response.writeHead(200, { "content-type": "text/plain" })
      response.write("owned upstream still streaming\n")
    })
    if (phase === "network-body")
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const sockets = new Set<Socket>()
    let snapshots = 0
    const host = createServer((socket) => {
      sockets.add(socket)
      socket.on("error", () => {})
      socket.once("close", () => {
        sockets.delete(socket)
        aborted = true
        closed.resolve()
      })
      socket.once("data", () => {
        if (++snapshots === 1) started.resolve(undefined)
        else
          socket.end(
            JSON.stringify({
              admitted: true,
              token: "fixture-access",
              expiresAt: Date.now() + 120000,
            }) + "\n",
          )
      })
    })
    if (phase === "mint") {
      await new Promise<void>((resolve) => host.listen(join(root, "host.sock"), resolve))
      await writeFile(
        join(root, "noscope/providers/provider-access.toml"),
        `contract_version = 1\n[commands]\nmint = "${process.execPath} ${resolve("src/capability-gateway/noscope-provider.ts")} access ${join(root, "host.sock")} claude {ttl}"\n`,
        { mode: 0o600 },
      )
    }
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { runs, leases, sql } = yield* seedCapabilityRun(Date.now(), ending === "sql-fault")
          const gateway = yield* makeCapabilityGateway(
            {
              noscope: { binary: fixtureExecutable("noscope"), configHome: root },
              providerId: "anthropic",
              credentialRole: "fixture",
              maxStreams: 1,
              maxStreamsPerRun: 1,
            },
            async (_, request) => {
              calls++
              if (calls !== 1 || phase === "upload" || phase === "mint")
                return new Response("valid")
              started.resolve(request.signal)
              if (phase === "network-body") {
                const address = upstream.address()
                if (!address || typeof address === "string")
                  throw new Error("Fixture listener unavailable")
                return fetch(`http://127.0.0.1:${address.port}/messages`, request)
              }
              if (phase === "body")
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(output) {
                      output.enqueue(
                        new TextEncoder().encode(
                          "event: message_start\ndata: " + "x".repeat(256) + "\n\n",
                        ),
                      )
                    },
                    cancel() {
                      aborted = true
                    },
                  }),
                )
              return await new Promise<Response>((_, reject) =>
                request.signal.addEventListener(
                  "abort",
                  () => {
                    aborted = true
                    reject(new Error("fixture cancelled"))
                  },
                  { once: true },
                ),
              )
            },
          )
          const grant = yield* gateway.bind(
            yield* gateway.challenge("run", transport),
            "fixture-jti",
          )
          yield* leases.bind("run", 78, 1, transport)
          const native = yield* makeNativeExecutionStore
          if (ending === "sql-fault") {
            const invocation = yield* native.reserve("run")
            yield* native.acknowledge("run", invocation.nonce)
          }
          const request = () => {
            const resultUpload = firstRequest && phase === "result-upload"
            const body =
              firstRequest && (phase === "upload" || phase === "result-upload")
                ? new ReadableStream<Uint8Array>(
                    {
                      start(controller) {
                        upload = controller
                      },
                      pull() {
                        started.resolve(undefined)
                      },
                      cancel() {
                        aborted = true
                      },
                    },
                    { highWaterMark: 0 },
                  )
                : JSON.stringify({ model: "fixture-model" })
            firstRequest = false
            return new Request(
              resultUpload
                ? "http://capability.invalid/capabilities/v1/result"
                : "http://capability.invalid/capabilities/v1/providers/anthropic/v1/messages",
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${grant.token}`,
                  "content-type": "application/json",
                  "anthropic-version": "2023-06-01",
                  "anthropic-beta": "oauth-2025-04-20",
                },
                body,
              },
            )
          }
          const pending = yield* gateway.handle(grant.binding, request()).pipe(Effect.forkScoped)
          const signal = yield* Effect.promise(() => started.promise)
          let body: Promise<string> | undefined
          if (phase === "body" || phase === "network-body") {
            const response = yield* Fiber.join(pending)
            body = response.text().then(
              () => "complete",
              () => "interrupted",
            )
          }
          if (phase === "upload") {
            const interruption = Effect.runPromise(Fiber.interrupt(pending)).then(() => true)
            const joined = yield* Effect.promise(() =>
              Promise.race([
                interruption,
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
              ]),
            )
            upload?.error(new Error("fixture teardown"))
            yield* Effect.promise(() => interruption)
            expect(joined).toBe(true)
          } else if (ending === "interrupt") yield* Fiber.interrupt(pending)
          else if (ending === "cancel") yield* runs.cancel({ runId: "run", now: new Date() })
          else if (ending === "sql-fault") {
            yield* sql`CREATE TRIGGER fail_revocation BEFORE UPDATE OF revoked ON capability_bindings
              BEGIN SELECT RAISE(FAIL,'injected durable revocation failure'); END`
            expect((yield* native.uncertain("run").pipe(Effect.result))._tag).toBe("Failure")
            yield* Effect.promise(() => closed.promise).pipe(Effect.timeout("2 seconds"))
            expect(yield* sql`SELECT revoked FROM capability_bindings`).toEqual([{ revoked: 0 }])
            yield* sql`DROP TRIGGER fail_revocation`
            yield* native.uncertain("run")
          } else yield* leases.beginRelease("run")
          if (phase === "result-upload") {
            yield* Fiber.join(pending).pipe(Effect.timeout("1 second"))
          }
          if (phase === "mint") {
            yield* Effect.promise(() => closed.promise)
            if (ending !== "interrupt") yield* Fiber.join(pending)
            expect(calls).toBe(0)
          }
          if (signal) expect(signal.aborted).toBe(true)
          if (body) {
            const reading = body
            expect(yield* Effect.promise(() => reading)).toBe("interrupted")
          }
          expect(aborted).toBe(true)
          const next = yield* gateway.handle(grant.binding, request())
          expect(next.status).toBe(ending === "interrupt" ? 200 : 403)
          if (ending === "interrupt") expect(yield* Effect.promise(() => next.text())).toBe("valid")
          expect(calls).toBe(
            phase === "result-upload"
              ? 0
              : phase === "mint"
                ? ending === "interrupt"
                  ? 1
                  : 0
                : ending === "interrupt" && phase !== "upload"
                  ? 2
                  : 1,
          )
        }).pipe(
          Effect.provide(AgentRunStoreLive),
          Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
          Effect.scoped,
        ),
      )
    } finally {
      for (const socket of sockets) socket.destroy()
      host.close()
      upstream.closeAllConnections()
      upstream.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 15000)
}
