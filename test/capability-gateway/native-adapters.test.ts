import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { makeNativeExecutionStore } from "../../src/sandbox/native-execution"
import { seedCapabilityRun, transport } from "./fixture"

for (const protocol of ["codex-chatgpt", "openai-chat"] as const) {
  test(`${protocol}: selected native stream, renewal, denials and revocation use existing authority`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-adapter-"))
    const access = "synthetic-server-access"
    const account = "synthetic-server-account"
    const secret =
      protocol === "codex-chatgpt"
        ? JSON.stringify({ accessToken: access, accountId: account })
        : access
    await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
    await writeFile(
      join(root, "noscope/providers/run-capability.toml"),
      `contract_version = 1\n[commands]\nmint = "${process.execPath} ${resolve("src/capability-gateway/noscope-provider.ts")} run {ttl}"\n`,
      { mode: 0o600 },
    )
    await writeFile(
      join(root, "access.mjs"),
      `process.stdout.write(JSON.stringify({token:${JSON.stringify(secret)},token_id:"fixture",expires_at:new Date(Date.now()+120000).toISOString()}))`,
    )
    await writeFile(
      join(root, "noscope/providers/provider-access.toml"),
      `contract_version = 1\n[commands]\nmint = "${process.execPath} ${join(root, "access.mjs")}"\n`,
      { mode: 0o600 },
    )
    const sent: { url: string; headers: Headers; body: string; signal: AbortSignal }[] = []
    let mode: "valid" | "redirect" | "reflect" | "stall" | "capture-fault" = "valid"
    let cancelled = false
    let captureCancelled = 0
    const quota =
      protocol === "codex-chatgpt"
        ? {
            "x-codex-primary-used-percent": "12.5",
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-at": "1893456000",
          }
        : {
            "x-ratelimit-limit-requests": "1000",
            "x-ratelimit-remaining-requests": "42",
            "x-ratelimit-remaining-tokens": "12345",
          }
    let responseHeaders: Record<string, string> = { "x-request-id": "req_fixture-123", ...quota }
    let responseStatus = 200
    const bytes =
      protocol === "codex-chatgpt"
        ? 'event: response.completed\ndata: {"type":"response.completed","response":{"model":"fixture-model","usage":{"output_tokens":2}}}\n\n'
        : 'data: {"model":"fixture-model","choices":[],"usage":{"completion_tokens":2}}\n\ndata: [DONE]\n\n'
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { sql, leases } = yield* seedCapabilityRun(Date.now(), true)
          yield* sql`UPDATE kernel_agent_runs SET directory=${root} WHERE run_id='run'`
          yield* sql`UPDATE kernel_agent_runs SET provider_id='selected',executor_kind=${protocol === "codex-chatgpt" ? "codex" : "opencode"} WHERE run_id='run'`
          const gateway = yield* makeCapabilityGateway(
            {
              noscope: { binary: fixtureExecutable("noscope"), configHome: root },
              providerId: "selected",
              credentialRole: "fixture",
              maxStreams: 4,
              maxStreamsPerRun: 2,
              native: { protocol, models: [{ id: "fixture-model", efforts: ["high"] }] },
            },
            async (url, request) => {
              sent.push({
                url,
                headers: request.headers,
                body: Buffer.from(request.body).toString(),
                signal: request.signal,
              })
              if (mode === "redirect")
                return new Response(null, {
                  status: 302,
                  headers: { location: "http://127.0.0.1/escape" },
                })
              if (mode === "reflect")
                return new Response(
                  new ReadableStream({
                    start(output) {
                      output.enqueue(Buffer.from(access.slice(0, 9)))
                      output.enqueue(Buffer.from(access.slice(9)))
                      output.close()
                    },
                  }),
                )
              if (mode === "stall")
                return new Response(
                  new ReadableStream({
                    start(output) {
                      output.enqueue(Buffer.from("x".repeat(500)))
                    },
                    cancel() {
                      cancelled = true
                    },
                  }),
                )
              return new Response(
                mode === "capture-fault"
                  ? new ReadableStream({
                      start(output) {
                        output.enqueue(Buffer.from(bytes))
                      },
                      cancel() {
                        captureCancelled++
                      },
                    })
                  : bytes,
                {
                  status: responseStatus,
                  headers: {
                    "content-type": "text/event-stream",
                    authorization: access,
                    "chatgpt-account-id": account,
                    ...responseHeaders,
                  },
                },
              )
            },
          )
          const proof = yield* gateway.challenge("run", transport)
          const issued = yield* gateway.bind(proof, "jti")
          yield* leases.bind("run", 78, 1, transport)
          const native = yield* makeNativeExecutionStore
          const invocation = yield* native.reserve("run")
          yield* native.acknowledge("run", invocation.nonce)
          const path = `/capabilities/v1/providers/selected/${protocol === "codex-chatgpt" ? "responses" : "chat/completions"}`
          const body = {
            model: "fixture-model",
            stream: true,
            ...(protocol === "codex-chatgpt"
              ? { store: false, reasoning: { effort: "high" }, input: [] }
              : { reasoning_effort: "high", messages: [] }),
          }
          const request = (
            target = path,
            data: unknown = body,
            extra: Record<string, string> = {},
            token = issued.token,
          ) =>
            new Request(`http://capability.invalid${target}`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                ...extra,
              },
              body: JSON.stringify(data),
            })
          // A real rename-to-directory error occurs after the temporary was written.
          // Even a queued terminal provider event must not count as progress.
          yield* Effect.promise(() => mkdir(join(root, "provider-response.json")))
          mode = "capture-fault"
          const beforeCapture = yield* native.read("run")
          for (let attempt = 1; attempt <= 3; attempt++) {
            const failed = yield* gateway.handle(issued.binding, request())
            expect(failed.status).toBe(503)
            expect(yield* Effect.promise(() => failed.text())).toBe("")
            expect(captureCancelled).toBe(attempt)
            expect(yield* native.read("run")).toEqual(beforeCapture)
            expect((yield* native.read("run"))?.finalize_revision).toBeNull()
            expect(yield* native.claimFinalization("run")).toBeNull()
            expect(
              (yield* Effect.promise(() => readdir(root))).filter((name) =>
                name.startsWith("provider-response.json"),
              ),
            ).toEqual(["provider-response.json"])
          }
          yield* Effect.promise(() => rm(join(root, "provider-response.json"), { recursive: true }))
          mode = "valid"
          const valid = yield* gateway.handle(issued.binding, request())
          expect(valid.status).toBe(200)
          expect(yield* Effect.promise(() => valid.text())).toBe(bytes)
          expect(sent[0]?.url).toBe(
            protocol === "codex-chatgpt"
              ? "https://chatgpt.com/backend-api/codex/responses"
              : "https://api.openai.com/v1/chat/completions",
          )
          expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${access}`)
          expect(sent[0]?.headers.get("chatgpt-account-id")).toBe(
            protocol === "codex-chatgpt" ? account : null,
          )
          expect(valid.headers.has("authorization")).toBe(false)
          expect(valid.headers.has("chatgpt-account-id")).toBe(false)
          expect((yield* native.read("run"))?.output_tokens).toBe(2)
          const diagnostics = async (name = "provider-response.json"): Promise<unknown> =>
            JSON.parse(await readFile(join(root, name), "utf8"))
          const expectedQuota = Object.fromEntries(
            Object.entries(quota).map(([name, value]) => [name, Number(value)]),
          )
          expect(yield* Effect.promise(() => diagnostics())).toMatchObject({
            protocol,
            status: 200,
            requestId: "req_fixture-123",
            quota: expectedQuota,
          })
          expect(
            (yield* Effect.promise(() => stat(join(root, "provider-response.json")))).mode & 0o777,
          ).toBe(0o600)
          expect(valid.headers.has("x-request-id")).toBe(false)
          expect([...valid.headers.keys()].sort()).toEqual(["cache-control", "content-type"])
          for (const denied of [
            request(path + "?url=http://127.0.0.1"),
            request(path.replace("selected", "other")),
            request(path + "/../models"),
            request(path, { ...body, model: "other" }),
            request(path, { ...body, reasoning_effort: "low", reasoning: { effort: "low" } }),
            request(path, body, { "x-api-key": "client-key" }),
            request(path, body, { host: "attacker.invalid" }),
            request(path, body, { "content-encoding": "gzip" }),
            request(path, body, {
              authorization: `Bearer ${issued.token}, Bearer ${issued.token}`,
            }),
            request(path, body, { "x-workflowd-run": "other" }),
            request(path, body, { connection: "upgrade" }),
          ])
            expect((yield* gateway.handle(issued.binding, denied)).status).toBe(403)
          expect(sent.length).toBe(4)
          for (const binding of [
            { ...issued.binding, runId: "other" },
            { ...issued.binding, channel: "f".repeat(64) },
          ])
            expect((yield* gateway.handle(binding, request())).status).toBe(403)
          for (const swap of [
            sql`UPDATE kernel_agent_runs SET repository='other' WHERE run_id='run'`,
            sql`UPDATE kernel_agent_runs SET attempt=attempt+1 WHERE run_id='run'`,
            sql`UPDATE kernel_agent_runs SET model_id='other' WHERE run_id='run'`,
            sql`UPDATE directory_managed SET recipient_id='other' WHERE run_id='run'`,
            sql`UPDATE sandbox_leases SET deadline=1 WHERE run_id='run'`,
          ]) {
            const before = sent.length
            yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* swap
                  expect((yield* gateway.handle(issued.binding, request())).status).toBe(403)
                  expect(sent.length).toBe(before)
                  return yield* Effect.fail("fixture rollback")
                }),
              )
              .pipe(Effect.result)
            const adjacent = yield* gateway.handle(issued.binding, request())
            expect(adjacent.status).toBe(200)
            expect(yield* Effect.promise(() => adjacent.text())).toBe(bytes)
          }
          const renewed = yield* gateway.handle(
            issued.binding,
            request("/capabilities/v1/renew", {}),
          )
          expect(renewed.status).toBe(200)
          const next = yield* Effect.promise(async () =>
            Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(await renewed.json()),
          )
          const control = yield* gateway.handle(issued.binding, request(path, body, {}, next.token))
          expect(yield* Effect.promise(() => control.text())).toBe(bytes)
          expect((yield* native.read("run"))?.nonce).toBe(invocation.nonce)
          for (const invalid of [
            "::error::untrusted",
            "x".repeat(129),
            access,
            account,
            Buffer.from(access).toString("base64url"),
          ]) {
            responseHeaders = {
              ...quota,
              "x-request-id": invalid,
              authorization: access,
              "chatgpt-account-id": account,
              "x-unknown-quota": "20",
            }
            const response = yield* gateway.handle(issued.binding, request())
            expect(response.status).toBe(200)
            expect(yield* Effect.promise(() => response.text())).toBe(bytes)
            expect(yield* Effect.promise(() => diagnostics())).toEqual({
              version: 1,
              protocol,
              status: 200,
              quota: expectedQuota,
            })
            expect([...response.headers.keys()].sort()).toEqual(["cache-control", "content-type"])
          }
          for (const invalid of ["NaN", "Infinity", "-1", "9".repeat(40), access, "1e3"]) {
            responseHeaders = Object.fromEntries(Object.keys(quota).map((name) => [name, invalid]))
            responseHeaders["x-request-id"] = "req_numeric-control"
            const response = yield* gateway.handle(issued.binding, request())
            expect(yield* Effect.promise(() => response.text())).toBe(bytes)
            expect(yield* Effect.promise(() => diagnostics())).toEqual({
              version: 1,
              protocol,
              status: 200,
              requestId: "req_numeric-control",
              quota: {},
            })
          }
          responseStatus = 429
          responseHeaders = { ...quota, "x-request-id": "req_quota-error" }
          const quotaError = yield* gateway.handle(issued.binding, request())
          expect(quotaError.status).toBe(429)
          expect(yield* Effect.promise(() => quotaError.text())).toBe(bytes)
          expect(yield* Effect.promise(() => diagnostics("provider-error.json"))).toEqual({
            version: 1,
            protocol,
            status: 429,
            requestId: "req_quota-error",
            quota: expectedQuota,
          })
          responseStatus = 200
          const [quotaName, quotaValue] = Object.entries(quota)[0]!
          responseHeaders = {
            "x-request-id": "req_private-account-reflection",
            "chatgpt-account-id": quotaValue,
            [quotaName]: quotaValue,
          }
          const reflection = yield* gateway.handle(issued.binding, request())
          expect(yield* Effect.promise(() => reflection.text())).toBe(bytes)
          expect(yield* Effect.promise(() => diagnostics())).toEqual({
            version: 1,
            protocol,
            status: 200,
            requestId: "req_private-account-reflection",
            quota: {},
          })
          responseHeaders = { "x-request-id": "req_bound-control", [quotaName]: "1000000000001" }
          const overflow = yield* gateway.handle(issued.binding, request())
          expect(yield* Effect.promise(() => overflow.text())).toBe(bytes)
          expect(yield* Effect.promise(() => diagnostics())).toEqual({
            version: 1,
            protocol,
            status: 200,
            requestId: "req_bound-control",
            quota: {},
          })
          mode = "redirect"
          expect((yield* gateway.handle(issued.binding, request())).status).toBe(503)
          mode = "reflect"
          const reflected = yield* gateway.handle(issued.binding, request())
          yield* Effect.promise(async () => {
            await expect(reflected.text()).rejects.toThrow()
          })
          mode = "stall"
          const pending = yield* gateway.handle(issued.binding, request())
          const reader = pending.body!.getReader()
          yield* Effect.promise(() => reader.read())
          yield* gateway.revoke("run")
          expect(sent.at(-1)?.signal.aborted).toBe(true)
          expect(cancelled).toBe(true)
          expect((yield* gateway.handle(issued.binding, request())).status).toBe(403)
        }).pipe(
          Effect.scoped,
          Effect.provide(AgentRunStoreLive),
          Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        ),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
