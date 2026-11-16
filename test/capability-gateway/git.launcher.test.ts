import { expect, test } from "bun:test"
import { gitHttpBackend } from "./git-backend"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import {
  bindRunSession,
  fixtureSessionKey,
  runCapabilityMint,
  seedCapabilityRun,
  writeNoscopeProvider,
} from "./fixture"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { loopbackCertificate, portOf, tlsFront } from "../helpers/loopback-tls"
import { capabilityApi, serveCapabilityListener } from "../../src/capability-gateway/http"
import { connect, createServer } from "node:net"
import { once } from "node:events"

/** The bound port of a listening TCP server. */
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

test("real Git clone/fetch, repository and write fences", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-git-"))
  await writeNoscopeProvider(root, "run-capability", runCapabilityMint)
  await git(root, "init", "--initial-branch=main", "source")
  const source = join(root, "source")
  await writeFile(join(source, "public.txt"), "first\n")
  await git(source, "add", ".")
  await git(source, "commit", "-m", "synthetic public source")
  await git(root, "clone", "--bare", source, "repo.git")
  let calls = 0
  let attempts = 0
  // Real git-http-backend: clone/fetch negotiate and decode an actual pack, not canned HTTP.
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls++
      const response = await gitHttpBackend(root, request)
      expect(response.status).toBe(200)
      return response
    },
  })
  const tls = await loopbackCertificate(root)
  let relay: ReturnType<typeof Bun.spawn> | undefined
  const listenSocket = join(root, "front", "gateway.sock")
  const front = await tlsFront(tls, listenSocket)
  let stopListener: (() => Promise<void>) | undefined
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedCapabilityRun(Date.now(), true)
        const config = {
          noscope: { binary: fixtureExecutable("noscope"), configHome: root },
          providerId: "anthropic",
          credentialRole: "unused",
          maxStreams: 2,
          maxStreamsPerRun: 1,
          gitRead: true,
        }
        const gateway = yield* makeCapabilityGateway(config, undefined, async (url, input) => {
          attempts++
          expect(url).toMatch(
            /^https:\/\/github.com\/fixture\/repo.git\/(info\/refs\?service=git-upload-pack|git-upload-pack)$/,
          )
          expect(input.redirect).toBe("error")
          expect(input.headers.has("authorization")).toBe(false)
          return fetch(`${backend.url.href}repo.git/${url.split("repo.git/")[1]}`, input)
        })
        const grant = yield* bindRunSession(Date.now(), { jti: "git-jti" })
        // The gateway's listener, behind its front.
        stopListener = yield* Effect.promise(() =>
          serveCapabilityListener(
            {
              socket: listenSocket,
              front: { uid: process.getuid!(), gid: process.getgid!() },
              service: front.service,
            },
            capabilityApi(gateway),
          ),
        )
        relay = Bun.spawn(
          [
            fixtureExecutable("node"),
            resolve("test/sandbox/fixtures/capability-job.mjs"),
            "runner",
            root,
          ],
          {
            env: { PATH: "/usr/bin:/bin", HOME: root, NODE_EXTRA_CA_CERTS: tls.cert },
            stdin: new Blob([
              JSON.stringify({
                token: grant.token,
                channel: grant.binding.channel,
                sessionKey: fixtureSessionKey.privateKey,
                expiresAt: grant.expiresAt,
                renewAt: grant.renewAt,
                deadline: Date.now() + 3600000,
                providerId: "anthropic",
                gateway: front.origin,
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
        // Git speaks TCP; the relay listens on a socket. A plain forwarder joins them.
        const forwarder = createServer((socket) => {
          const upstream = connect(join(root, "gateway.sock"))
          socket.pipe(upstream).pipe(socket)
          socket.on("error", () => upstream.destroy())
          upstream.on("error", () => socket.destroy())
        })
        forwarder.listen(0, "127.0.0.1")
        yield* Effect.promise(() => once(forwarder, "listening"))
        const url = `http://127.0.0.1:${portOf(forwarder)}`
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
            yield* Effect.promise(() => git(join(root, "clone"), "show", "origin/main:public.txt")),
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
          expect(attempts).toBe(admitted)
          expect(calls).toBe(before)
        } finally {
          yield* Effect.promise(
            () => new Promise<void>((resolve) => forwarder.close(() => resolve())),
          )
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
    front.close()
    await stopListener?.()
    await backend.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
