import { expect, test } from "bun:test"
import { gitHttpBackend } from "./git-backend"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { makeTokenBroker } from "../../src/worker-identity/broker"
import { bindRunSession, seedCapabilityRun } from "./fixture"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"

const secret = "synthetic-git-read-credential"
const basic = `Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(
    ["git", "-c", "http.extraHeader=Authorization: Bearer workflowd-local", ...args],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    },
  )
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`fixture git failed: ${stderr}`)
  return stdout.trim()
}

type Fault = "redirect" | "reflection" | "slow" | undefined

/** Real git-http-backend behind loopback: clone/fetch negotiate and decode an actual pack. */
function gitBackend(root: string, seen: (string | null)[]) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seen.push(request.headers.get("authorization"))
      return gitHttpBackend(root, request)
    },
  })
}

/**
 * Drives the real gateway (`gateway.handle`) with `gitRead`, a real Git upstream and a fault
 * switch. A loopback server around `gateway.handle` stands in for the runner shim and relay:
 * it forwards the shim's header set and swaps the sentinel for the run token.
 */
const withGitGateway = (
  authenticated: boolean,
  body: (context: Effect.Success<ReturnType<typeof setup>>) => Effect.Effect<void, unknown, never>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* setup(authenticated)
      yield* body(context)
    }).pipe(
      Effect.provide(AgentRunStoreLive),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      Effect.scoped,
    ),
  )

const setup = (authenticated: boolean) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "gateway-git-read-"))),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    )
    const source = join(root, "source")
    yield* Effect.promise(async () => {
      await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
      await writeFile(
        join(root, "noscope/providers/run-capability.toml"),
        `contract_version = 1\n[commands]\nmint = "${process.execPath} ${resolve("src/capability-gateway/noscope-provider.ts")} run {ttl}"\n`,
        { mode: 0o600 },
      )
      await git(root, "init", "--initial-branch=main", "source")
      await writeFile(join(source, "public.txt"), "first\n")
      await git(source, "add", ".")
      await git(source, "commit", "-m", "synthetic public source")
      await git(root, "clone", "--bare", source, "repo.git")
    })
    const state = {
      seen: [] as (string | null)[],
      urls: [] as string[],
      attempts: 0,
      minted: 0,
      fault: undefined as Fault,
      upstreamCancelled: false,
    }
    const backend = yield* Effect.acquireRelease(
      Effect.sync(() => gitBackend(root, state.seen)),
      (backend) => Effect.promise(() => backend.stop(true)),
    )
    const { runs, sql } = yield* seedCapabilityRun(Date.now(), true)
    const broker = yield* makeTokenBroker(async (input) => {
      state.minted++
      expect(input).toEqual({
        installation_id: 1,
        repositories: ["repo"],
        permissions: { contents: "read" },
      })
      return { token: secret, expires_at: new Date(Date.now() + 3600000).toISOString() }
    })
    const gateway = yield* makeCapabilityGateway(
      {
        noscope: { binary: fixtureExecutable("noscope"), configHome: root },
        providerId: "anthropic",
        credentialRole: "unused",
        maxStreams: 2,
        maxStreamsPerRun: 1,
        gitRead: true,
      },
      undefined,
      {
        ...(authenticated ? { broker } : {}),
        upstream: async (url, input) => {
          state.attempts++
          state.urls.push(url)
          expect(input.redirect).toBe("error")
          if (state.fault === "redirect")
            return new Response(secret, {
              status: 302,
              headers: { location: "https://foreign.invalid/repo", authorization: secret },
            })
          if (state.fault)
            return new Response(
              new ReadableStream<Uint8Array>({
                start(output) {
                  output.enqueue(
                    Buffer.from(state.fault === "reflection" ? secret : "x".repeat(512)),
                  )
                  if (state.fault === "reflection") output.close()
                },
                cancel() {
                  state.upstreamCancelled = true
                },
              }),
              { headers: { "content-type": "application/x-git-upload-pack-advertisement" } },
            )
          return fetch(`${backend.url.href}repo.git/${url.split("repo.git/")[1]}`, input)
        },
      },
    )
    const grant = yield* bindRunSession(Date.now(), { jti: "git-jti" })
    const shim = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const url = new URL(request.url)
            const headers = new Headers()
            for (const name of ["content-type", "git-protocol"]) {
              const value = request.headers.get(name)
              if (value !== null) headers.set(name, value)
            }
            if (request.headers.get("authorization") === "Bearer workflowd-local")
              headers.set("authorization", `Bearer ${grant.token}`)
            const forwarded = new Request(`http://capability.invalid${url.pathname}${url.search}`, {
              method: request.method,
              headers,
              ...(request.method === "POST" ? { body: await request.arrayBuffer() } : {}),
            })
            return Effect.runPromise(gateway.handle(forwarded))
          },
        }),
      ),
      (shim) => Effect.promise(() => shim.stop(true)),
    )
    const direct = (
      suffix = "12.git/info/refs?service=git-upload-pack",
      init: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {},
    ) =>
      new Request(`http://capability.invalid/capabilities/v1/git/${suffix}`, {
        ...init,
        headers: { authorization: `Bearer ${grant.token}`, ...init.headers },
      })
    const call = (request: Request) => gateway.handle(request)
    return {
      root,
      source,
      state,
      runs,
      sql,
      grant,
      direct,
      call,
      base: `${shim.url.origin}/capabilities/v1/git/12.git`,
    }
  })

for (const authenticated of [false, true]) {
  test(
    `G1: git clone and fetch read the saved repository through the gateway (authenticated=${authenticated})`,
    () =>
      withGitGateway(authenticated, ({ root, source, state, base }) =>
        Effect.promise(async () => {
          await git(root, "clone", base, "clone")
          expect(await readFile(join(root, "clone/public.txt"), "utf8")).toBe("first\n")
          await writeFile(join(source, "public.txt"), "second\n")
          await git(source, "commit", "-am", "second synthetic revision")
          await git(source, "push", join(root, "repo.git"), "main")
          await git(join(root, "clone"), "fetch", "origin")
          expect(await git(join(root, "clone"), "show", "origin/main:public.txt")).toBe("second")
          expect(state.seen.length).toBeGreaterThanOrEqual(4)
          expect(new Set(state.seen)).toEqual(new Set([authenticated ? basic : null]))
          for (const url of state.urls)
            expect(url).toMatch(
              /^https:\/\/github.com\/fixture\/repo.git\/(info\/refs\?service=git-upload-pack|git-upload-pack)$/,
            )
          expect(state.minted).toBe(authenticated ? 1 : 0)
        }),
      ),
    20000,
  )

  test(`G2: foreign repositories, receive-pack and non-canonical paths are refused before the upstream (authenticated=${authenticated})`, () =>
    withGitGateway(authenticated, ({ state, direct, call }) =>
      Effect.gen(function* () {
        for (const [suffix, method] of [
          ["13.git/info/refs?service=git-upload-pack", "GET"],
          ["12.git/info/refs?service=git-receive-pack", "GET"],
          ["12.git/git-receive-pack", "POST"],
          ["12.git/info/refs?service=git-upload-pack&x=1", "GET"],
          ["12.git/%69nfo/refs?service=git-upload-pack", "GET"],
          ["12.git/HEAD", "GET"],
        ] as const)
          expect((yield* call(direct(suffix, { method }))).status).toBe(403)
        expect(state.attempts).toBe(0)
        expect(state.minted).toBe(0)
      }),
    ))

  test(`G3: unsafe Git headers and a spoofed host are refused before the upstream (authenticated=${authenticated})`, () =>
    withGitGateway(authenticated, ({ state, direct, call }) =>
      Effect.gen(function* () {
        for (const headers of [
          { "git-protocol": "version=2:host=evil" },
          { "x-forwarded-host": "evil" },
          { "content-encoding": "gzip" },
        ])
          expect((yield* call(direct(undefined, { headers }))).status).toBe(403)
        const spoofed = direct()
        spoofed.headers.set("host", "foreign.invalid")
        expect((yield* call(spoofed)).status).toBe(403)
        expect(state.attempts).toBe(0)
      }),
    ))

  test(`G4: an upload larger than 1 MiB is refused before the upstream (authenticated=${authenticated})`, () =>
    withGitGateway(authenticated, ({ state, direct, call }) =>
      Effect.gen(function* () {
        const response = yield* call(
          direct("12.git/git-upload-pack", {
            method: "POST",
            headers: { "content-type": "application/x-git-upload-pack-request" },
            body: Buffer.alloc(1048577),
          }),
        )
        expect(response.status).toBe(403)
        expect(state.attempts).toBe(0)
      }),
    ))

  test(`G5: a changed saved repository is refused and the policy row is immutable (authenticated=${authenticated})`, () =>
    withGitGateway(authenticated, ({ state, sql, direct, call }) =>
      Effect.gen(function* () {
        expect(
          (yield* sql`UPDATE sandbox_leases SET policy=json_set(policy,'$.repository','foreign/repo') WHERE run_id='run'`.pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure")
        yield* sql`UPDATE kernel_agent_runs SET repository='foreign' WHERE run_id='run'`
        expect((yield* call(direct())).status).toBe(403)
        expect(state.attempts).toBe(0)
      }),
    ))

  test(`G6: redirects, reflection and slow streams stay inside run authority (authenticated=${authenticated})`, () =>
    withGitGateway(authenticated, ({ state, runs, direct, call }) =>
      Effect.gen(function* () {
        state.fault = "redirect"
        const redirected = yield* call(direct())
        expect(redirected.status).toBe(503)
        expect(yield* Effect.promise(() => redirected.text())).toBe("")
        if (authenticated) {
          state.fault = "reflection"
          const reflected = yield* call(direct())
          expect(yield* Effect.promise(() => reflected.text().catch(() => "interrupted"))).toBe(
            "interrupted",
          )
        }
        state.fault = "slow"
        const streaming = yield* call(direct())
        const reader = streaming.body!.getReader()
        expect((yield* Effect.promise(() => reader.read())).value?.length).toBeGreaterThan(0)
        expect((yield* call(direct())).status).toBe(429)
        yield* runs.cancel({ runId: "run", now: new Date() })
        expect(
          yield* Effect.promise(() =>
            reader.read().then(
              () => "completed",
              () => "interrupted",
            ),
          ),
        ).toBe("interrupted")
        expect(state.upstreamCancelled).toBe(true)
        const attempts = state.attempts
        expect((yield* call(direct())).status).toBe(403)
        expect(state.attempts).toBe(attempts)
        expect(state.minted).toBe(authenticated ? 1 : 0)
      }),
    ))
}
