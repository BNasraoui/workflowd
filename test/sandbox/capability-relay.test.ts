import { expect, test } from "bun:test"
import { createServer, type ServerHttp2Stream, type IncomingHttpHeaders } from "node:http2"
import { connect } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"

for (const scenario of [
  "headers",
  "renewal",
  "result",
  "responses",
  "chat/completions",
  "git-refs",
  "git-upload",
] as const) {
  test(`R6/R7: relay survives ${scenario} failure and serves the next valid request`, async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-regression-"))
    const now = Date.now()
    const first = "a".repeat(43)
    const next = "b".repeat(43)
    const nativePath =
      scenario === "responses" || scenario === "chat/completions"
        ? `/capabilities/v1/providers/selected/${scenario}`
        : scenario === "git-refs"
          ? "/capabilities/v1/git/12.git/info/refs?service=git-upload-pack"
          : scenario === "git-upload"
            ? "/capabilities/v1/git/12.git/git-upload-pack"
            : undefined
    const expiry = now + 15000
    const server = createServer()
    const renewed = Promise.withResolvers<void>()
    let attempts = 0
    let requests = 0
    server.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
      stream.on("error", () => {})
      stream.resume()
      stream.on("end", () => {
        if (headers[":path"] === "/capabilities/v1/renew") {
          attempts++
          expect(headers.authorization).toBe(`Bearer ${first}`)
          if (attempts === 1) {
            stream.respond({ ":status": 503 })
            stream.end()
            return
          }
          stream.respond({ ":status": 200 })
          stream.end(JSON.stringify({ token: next, expiresAt: expiry, renewAt: expiry - 1000 }))
          renewed.resolve()
          return
        }
        expect(headers.authorization).toBe(`Bearer ${scenario === "renewal" ? next : first}`)
        expect(headers[":method"]).toBe(scenario === "git-refs" ? "GET" : "POST")
        expect(headers[":path"]).toBe(
          nativePath ??
            (scenario === "result"
              ? "/capabilities/v1/result"
              : "/capabilities/v1/providers/anthropic/v1/messages"),
        )
        requests++
        stream.respond({ ":status": 200 })
        stream.end("fixture-stream")
      })
    })
    const child = Bun.spawn(
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
            token: first,
            expiresAt: expiry,
            renewAt: scenario === "renewal" ? now + 100 : expiry - 1000,
            deadline: expiry,
          }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    let socket: ReturnType<typeof connect> | undefined
    try {
      expect(Buffer.from((await child.stdout.getReader().read()).value ?? []).toString()).toBe(
        "ready\n",
      )
      const ready = Promise.withResolvers<void>()
      server.on("session", (session) => {
        session.on("error", () => {})
        session.once("remoteSettings", () => ready.resolve())
      })
      socket = connect(join(root, "capability.sock"))
      server.emit("connection", socket)
      await ready.promise
      const request = (headers: Record<string, string> = {}) =>
        fetch(
          "http://capability.invalid" +
            (nativePath ?? (scenario === "result" ? "/capabilities/v1/result" : "/v1/messages")),
          {
            unix: join(root, "gateway.sock"),
            method: scenario === "git-refs" ? "GET" : "POST",
            headers: { authorization: "Bearer workflowd-local", ...headers },
            body: scenario === "git-refs" ? undefined : "{}",
          },
        )
      if (scenario === "headers") {
        const response = await request({ "keep-alive": "timeout=5" }).catch(() => null)
        expect(response?.status).toBe(403)
      } else if (scenario === "renewal")
        await Promise.race([
          renewed.promise,
          child.exited.then(() => {
            throw new Error("relay died during transient renewal")
          }),
        ])
      expect(child.exitCode).toBeNull()
      const response = await request()
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("fixture-stream")
      expect(requests).toBe(1)
      expect(attempts).toBe(scenario === "renewal" ? 2 : 0)
    } finally {
      socket?.destroy()
      server.close()
      child.kill("SIGKILL")
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  }, 10000)
}

test("R7: accelerated clock expiry refuses renewal resurrection", async () => {
  const child = Bun.spawn(
    [fixtureExecutable("node"), "--test", resolve("test/sandbox/fixtures/relay-clock.mjs")],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 })
}, 5000)
