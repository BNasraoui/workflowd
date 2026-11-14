import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { request as httpRequest } from "node:http"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { makeTokenBroker } from "../../src/worker-identity/broker"
import { seedCapabilityRun, transport } from "./fixture"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { makeCapabilityTransport } from "../../src/sandbox/capability-transport"
import { disposableSsh } from "../sandbox/fixtures/ssh.mjs"

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

for (const authenticated of [false, true])
  test(`real Git clone/fetch, repository and write fences (authenticated=${authenticated})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-git-"))
    await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
    await writeFile(
      join(root, "noscope/providers/run-capability.toml"),
      `contract_version = 1\n[commands]\nmint = "${process.execPath} ${resolve("src/capability-gateway/noscope-provider.ts")} run {ttl}"\n`,
      { mode: 0o600 },
    )
    await git(root, "init", "--initial-branch=main", "source")
    const source = join(root, "source")
    await writeFile(join(source, "public.txt"), "first\n")
    await git(source, "add", ".")
    await git(source, "commit", "-m", "synthetic public source")
    await git(root, "clone", "--bare", source, "repo.git")
    let calls = 0
    let attempts = 0
    let minted = 0
    let fault: "redirect" | "reflection" | "slow" | undefined
    let upstreamCancelled = false
    const secret = "synthetic-git-read-credential"
    // Real git-http-backend: clone/fetch negotiate and decode an actual pack, not canned HTTP.
    const backend = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        calls++
        expect(request.headers.get("authorization")).toBe(
          authenticated
            ? `Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`
            : null,
        )
        const url = new URL(request.url)
        const child = Bun.spawn(["git", "http-backend"], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: request.method,
            CONTENT_TYPE: request.headers.get("content-type") ?? "",
            GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
          },
          stdin: request.method === "POST" ? new Blob([await request.arrayBuffer()]) : "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        const [bytes, errors, exit] = await Promise.all([
          new Response(child.stdout).arrayBuffer(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(exit).toBe(0)
        expect(errors).toBe("")
        const output = Buffer.from(bytes),
          split = output.indexOf("\r\n\r\n")
        expect(split).toBeGreaterThan(0)
        const headers = new Headers()
        for (const line of output.subarray(0, split).toString().split("\r\n")) {
          const colon = line.indexOf(":")
          headers.set(line.slice(0, colon), line.slice(colon + 1).trim())
        }
        return new Response(output.subarray(split + 4), { headers })
      },
    })
    const ssh = await disposableSsh(
      () =>
        `${fixtureExecutable("node")} ${resolve("test/sandbox/fixtures/capability-job.mjs")} connect ${root}`,
    )
    let relay: ReturnType<typeof Bun.spawn> | undefined
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { leases, runs, sql } = yield* seedCapabilityRun(Date.now())
          const broker = yield* makeTokenBroker(async (input) => {
            minted++
            expect(input).toEqual({
              installation_id: 1,
              repositories: ["repo"],
              permissions: { contents: "read" },
            })
            return { token: secret, expires_at: new Date(Date.now() + 3600000).toISOString() }
          })
          const config = {
            noscope: { binary: fixtureExecutable("noscope"), configHome: root },
            providerId: "anthropic",
            credentialRole: "unused",
            maxStreams: 2,
            maxStreamsPerRun: 1,
            gitRead: true,
          }
          const gateway = yield* makeCapabilityGateway(config, undefined, {
            ...(authenticated ? { broker } : {}),
            upstream: async (url, input) => {
              attempts++
              expect(url).toMatch(
                /^https:\/\/github.com\/fixture\/repo.git\/(info\/refs\?service=git-upload-pack|git-upload-pack)$/,
              )
              expect(input.redirect).toBe("error")
              if (fault === "redirect")
                return new Response(secret, {
                  status: 302,
                  headers: { location: "https://foreign.invalid/repo", authorization: secret },
                })
              if (fault)
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(output) {
                      output.enqueue(Buffer.from(fault === "reflection" ? secret : "x".repeat(512)))
                      if (fault === "reflection") output.close()
                    },
                    cancel() {
                      upstreamCancelled = true
                    },
                  }),
                  { headers: { "content-type": "application/x-git-upload-pack-advertisement" } },
                )
              return fetch(`${backend.url.href}repo.git/${url.split("repo.git/")[1]}`, input)
            },
          })
          const grant = yield* gateway.bind(yield* gateway.challenge("run", transport), "git-jti")
          yield* leases.bind("run", 78, 1, transport)
          relay = Bun.spawn(
            [
              fixtureExecutable("node"),
              resolve("test/sandbox/fixtures/capability-job.mjs"),
              "runner",
              root,
            ],
            {
              env: { PATH: "/usr/bin:/bin", HOME: root },
              stdin: new Blob([
                JSON.stringify({
                  token: grant.token,
                  expiresAt: grant.expiresAt,
                  renewAt: grant.renewAt,
                  deadline: Date.now() + 3600000,
                }),
              ]),
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          const output = relay.stdout
          if (typeof output === "number" || !output)
            throw new Error("fixture relay output unavailable")
          expect(
            Buffer.from(
              (yield* Effect.promise(() => output.getReader().read())).value ?? [],
            ).toString(),
          ).toBe("ready\n")
          const channel = yield* makeCapabilityTransport(
            gateway,
            fixtureExecutable("node"),
            root,
            () => [...ssh.args, "placeholder"],
          )
          yield* channel.connect(grant.binding, transport)
          const shim = Bun.spawn(
            [
              "python3",
              "-c",
              `import importlib.util,sys
spec=importlib.util.spec_from_file_location('interactive',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
with module.gateway({'socket':sys.argv[2]},'workflowd-local') as url:
 print(url,flush=True)
 sys.stdin.read()
`,
              resolve("deploy/sandbox/claude-interactive.py"),
              join(root, "gateway.sock"),
            ],
            { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
          )
          const url = Buffer.from(
            (yield* Effect.promise(() => shim.stdout.getReader().read())).value ?? [],
          )
            .toString()
            .trim()
          const request = (target: string, headers: Record<string, string> = {}) =>
            fetch(target, { headers: { authorization: "Bearer workflowd-local", ...headers } })
          try {
            const base = `${url}/capabilities/v1/git/12.git`
            yield* Effect.promise(() => git(root, "clone", base, "clone"))
            expect(
              yield* Effect.promise(() => readFile(join(root, "clone/public.txt"), "utf8")),
            ).toBe("first\n")
            yield* Effect.promise(async () => {
              await writeFile(join(source, "public.txt"), "second\n")
              await git(source, "commit", "-am", "second synthetic revision")
              await git(source, "push", join(root, "repo.git"), "main")
              await git(join(root, "clone"), "fetch", "origin")
            })
            expect(
              yield* Effect.promise(() =>
                git(join(root, "clone"), "show", "origin/main:public.txt"),
              ),
            ).toBe("second")
            const before = calls
            const admitted = attempts
            expect(
              (yield* Effect.tryPromise(() =>
                git(join(root, "clone"), "push", "origin", "HEAD:refs/heads/forbidden-write"),
              ).pipe(Effect.result))._tag,
            ).toBe("Failure")
            expect(
              (yield* Effect.tryPromise(() =>
                git(root, "ls-remote", `${url}/capabilities/v1/git/13.git`),
              ).pipe(Effect.result))._tag,
            ).toBe("Failure")
            for (const suffix of [
              "13.git/info/refs?service=git-upload-pack",
              "12.git/info/refs?service=git-receive-pack",
              "12.git/git-receive-pack",
              "12.git/info/refs?service=git-upload-pack&x=1",
              "12.git/%69nfo/refs?service=git-upload-pack",
              "12.git/HEAD",
            ]) {
              const response = yield* Effect.promise(() =>
                request(`${url}/capabilities/v1/git/${suffix}`),
              )
              expect(response.status).toBe(403)
            }
            for (const headers of [
              { "git-protocol": "version=2:host=evil" },
              { "x-forwarded-host": "evil" },
              { "content-encoding": "gzip" },
            ]) {
              const response = yield* Effect.promise(() =>
                request(`${base}/info/refs?service=git-upload-pack`, headers),
              )
              expect(response.status).toBe(403)
            }
            for (const headers of [
              ["Host", new URL(url).host, "Content-Length", "0", "Content-Length", "0"],
              ["Host", new URL(url).host, "Content-Length", "invalid"],
              ["Host", new URL(url).host, "Content-Length", "-1"],
              ["Host", "foreign.invalid"],
            ]) {
              const status = yield* Effect.promise(
                () =>
                  new Promise<number | undefined>((resolve, reject) => {
                    const request = httpRequest(
                      `${base}/info/refs?service=git-upload-pack`,
                      { headers: ["Authorization", "Bearer workflowd-local", ...headers] },
                      (response) => {
                        response.resume()
                        response.on("end", () => resolve(response.statusCode))
                      },
                    )
                    request.on("error", reject)
                    request.end()
                  }),
              )
              expect(status).toBe(403)
            }
            expect(
              (yield* sql`UPDATE sandbox_leases SET policy=json_set(policy,'$.repository','foreign/repo') WHERE run_id='run'`.pipe(
                Effect.result,
              ))._tag,
            ).toBe("Failure")
            yield* sql`UPDATE kernel_agent_runs SET repository='foreign' WHERE run_id='run'`
            expect(
              (yield* Effect.promise(() => request(`${base}/info/refs?service=git-upload-pack`)))
                .status,
            ).toBe(403)
            yield* sql`UPDATE kernel_agent_runs SET repository='fixture' WHERE run_id='run'`
            expect(attempts).toBe(admitted)
            const direct = () =>
              new Request(
                "http://capability.invalid/capabilities/v1/git/12.git/info/refs?service=git-upload-pack",
                { headers: { authorization: `Bearer ${grant.token}` } },
              )
            const spoofed = direct()
            spoofed.headers.set("host", "foreign.invalid")
            expect((yield* gateway.handle(grant.binding, spoofed)).status).toBe(403)
            expect(
              (yield* gateway.handle(
                grant.binding,
                new Request(
                  "http://capability.invalid/capabilities/v1/git/12.git/git-upload-pack",
                  {
                    method: "POST",
                    headers: {
                      authorization: `Bearer ${grant.token}`,
                      "content-type": "application/x-git-upload-pack-request",
                    },
                    body: Buffer.alloc(1048577),
                  },
                ),
              )).status,
            ).toBe(403)
            expect(attempts).toBe(admitted)
            fault = "redirect"
            const redirected = yield* gateway.handle(grant.binding, direct())
            expect(redirected.status).toBe(503)
            expect(yield* Effect.promise(() => redirected.text())).toBe("")
            if (authenticated) {
              fault = "reflection"
              const reflected = yield* gateway.handle(grant.binding, direct())
              expect(yield* Effect.promise(() => reflected.text().catch(() => "interrupted"))).toBe(
                "interrupted",
              )
            }
            fault = "slow"
            const streaming = yield* gateway.handle(grant.binding, direct())
            const reader = streaming.body!.getReader()
            expect((yield* Effect.promise(() => reader.read())).value?.length).toBeGreaterThan(0)
            expect((yield* gateway.handle(grant.binding, direct())).status).toBe(429)
            yield* runs.cancel({ runId: "run", now: new Date() })
            expect(
              yield* Effect.promise(() =>
                reader.read().then(
                  () => "completed",
                  () => "interrupted",
                ),
              ),
            ).toBe("interrupted")
            expect(upstreamCancelled).toBe(true)
            expect(
              (yield* Effect.promise(() => request(`${base}/info/refs?service=git-upload-pack`)))
                .status,
            ).toBe(403)
            expect(calls).toBe(before)
            expect(minted).toBe(authenticated ? 1 : 0)
          } finally {
            yield* Effect.promise(async () => {
              await shim.stdin.end()
            })
            expect(yield* Effect.promise(() => shim.exited)).toBe(0)
          }
        }).pipe(
          Effect.provide(AgentRunStoreLive),
          Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
          Effect.scoped,
        ),
      )
    } finally {
      relay?.kill("SIGKILL")
      await relay?.exited
      await ssh.close()
      await backend.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }, 20000)
