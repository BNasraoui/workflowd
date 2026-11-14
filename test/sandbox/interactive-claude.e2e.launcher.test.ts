import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { makeNativeResultStore } from "../../src/sandbox/native-result"
import { makeNativeExecutionStore } from "../../src/sandbox/native-execution"
import { seedCapabilityRun, transport } from "../capability-gateway/fixture"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"

test("pinned interactive Claude submits and corrects a candidate through the bound gateway", async () => {
  const root = await mkdtemp(join(tmpdir(), "interactive-gateway-"))
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
  // This fixture invokes only the checked-in normal interactive adapter. All native
  // request bytes cross real loopback HTTP/Unix sockets; the upstream is synthetic.
  fixtureExecutable("claude")
  const child = spawn(
    "/usr/bin/python3",
    [
      resolve("test/sandbox/fixtures/interactive-claude.py"),
      "--supervised",
      "--gateway",
      "--external",
      "--result",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  )
  const exit = once(child, "close")
  let errors = ""
  child.stderr.on("data", (chunk) => {
    errors += chunk
    if (errors.length > 65536) child.kill("SIGKILL")
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  try {
    const first = await lines.next()
    expect(first.done).toBe(false)
    const upstream: { upstream: string } = JSON.parse(first.value!)
    expect(upstream.upstream).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    await Effect.runPromise(
      Effect.gen(function* () {
        const { leases, sql } = yield* seedCapabilityRun(Date.now())
        yield* sql`UPDATE kernel_agent_runs SET model_id='claude-opus-4-6' WHERE run_id='run'`
        const gateway = yield* makeCapabilityGateway(
          {
            noscope: { binary: fixtureExecutable("noscope"), configHome: root },
            providerId: "anthropic",
            credentialRole: "fixture",
            maxStreams: 4,
            maxStreamsPerRun: 4,
          },
          async (url, input) =>
            fetch(upstream.upstream + new URL(url).pathname + new URL(url).search, input),
        )
        const grant = yield* gateway.bind(
          yield* gateway.challenge("run", transport),
          "interactive-jti",
        )
        yield* leases.bind("run", 78, 1, transport)
        const native = yield* makeNativeExecutionStore
        const invocation = yield* native.reserve("run")
        yield* native.acknowledge("run", invocation.nonce)
        const progress: number[] = []
        const unlisten = native.listen("run", (tokens) => progress.push(tokens))
        const foreign = yield* gateway.handle(
          grant.binding,
          new Request("http://capability.invalid/capabilities/v1/providers/anthropic/v1/messages", {
            method: "POST",
            headers: {
              authorization: "Bearer " + grant.token,
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "oauth-2025-04-20",
              "x-claude-code-session-id": "foreign",
            },
            body: JSON.stringify({ model: "claude-opus-4-6" }),
          }),
        )
        expect(foreign.status).toBe(403)
        const socket = join(root, "gateway.sock")
        const server = Bun.serve({
          unix: socket,
          async fetch(request) {
            if (request.headers.get("authorization") !== "Bearer synthetic-oauth-sentinel")
              return new Response(null, { status: 403 })
            const url = new URL(request.url)
            const path =
              url.pathname === "/capabilities/v1/result"
                ? url.pathname
                : "/capabilities/v1/providers/anthropic" + url.pathname + url.search
            const headers = new Headers(request.headers)
            headers.set("authorization", "Bearer " + grant.token)
            return Effect.runPromise(
              gateway.handle(
                grant.binding,
                new Request("http://capability.invalid" + path, {
                  method: request.method,
                  headers,
                  body: await request.arrayBuffer(),
                }),
              ),
            )
          },
        })
        try {
          child.stdin.end(
            JSON.stringify({ socket, bearer: "fixture-access", session: invocation.session_id }) +
              "\n",
          )
          const [code] = yield* Effect.promise(() => exit)
          expect({ code, errors }).toEqual({ code: 0, errors: "" })
          const results = yield* makeNativeResultStore
          expect(yield* results.read("run")).toMatchObject({
            channel: grant.binding.channel,
            revision: 2,
            frozen: 0,
            completion: { title: "Corrected native result", branch: "native/agent-choice" },
          })
          expect(progress.length).toBeGreaterThanOrEqual(6)
          expect(progress.every((tokens, index) => tokens > (progress[index - 1] ?? 0))).toBe(true)
          expect(yield* native.read("run")).toMatchObject({
            state: "running",
            response_sequence: progress.length,
            output_tokens: progress.at(-1),
          })
        } finally {
          unlisten()
          yield* Effect.promise(() => server.stop(true))
        }
      }).pipe(
        Effect.provide(AgentRunStoreLive),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.scoped,
      ),
    )
  } finally {
    child.kill("SIGKILL")
    await exit
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
