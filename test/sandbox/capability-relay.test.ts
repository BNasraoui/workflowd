import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"

/** A self-signed certificate for 127.0.0.1: the gateway's TLS on loopback. */
async function loopbackCertificate(root: string) {
  const key = join(root, "tls.key")
  const cert = join(root, "tls.pem")
  const child = Bun.spawn(
    [
      "/usr/bin/openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  )
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text())
  return { key, cert }
}

for (const scenario of ["headers", "renewal", "git-refs", "git-upload"] as const) {
  test(`R6/R7: relay survives ${scenario} failure and serves the next valid request`, async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-regression-"))
    const now = Date.now()
    const first = "a".repeat(43)
    const next = "b".repeat(43)
    const gitPath =
      scenario === "git-refs"
        ? "/capabilities/v1/git/12.git/info/refs?service=git-upload-pack"
        : scenario === "git-upload"
          ? "/capabilities/v1/git/12.git/git-upload-pack"
          : undefined
    const expiry = now + 15000
    const tls = await loopbackCertificate(root)
    let attempts = 0
    let requests = 0
    const renewed = Promise.withResolvers<void>()
    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(tls.key), cert: Bun.file(tls.cert) },
      async fetch(request) {
        const url = new URL(request.url)
        const target = url.pathname + url.search
        await request.arrayBuffer()
        if (target === "/capabilities/v1/renew") {
          attempts++
          expect(request.headers.get("authorization")).toBe(`Bearer ${first}`)
          if (attempts === 1) return new Response(null, { status: 503 })
          renewed.resolve()
          return Response.json({ token: next, expiresAt: expiry, renewAt: expiry - 1000 })
        }
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${scenario === "renewal" ? next : first}`,
        )
        expect(request.method).toBe(scenario === "git-refs" ? "GET" : "POST")
        expect(target).toBe(gitPath ?? "/capabilities/v1/providers/anthropic/v1/messages")
        requests++
        return new Response("fixture-stream")
      },
    })
    const child = Bun.spawn(
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
            token: first,
            expiresAt: expiry,
            renewAt: scenario === "renewal" ? now + 100 : expiry - 1000,
            deadline: expiry,
            gateway: `https://127.0.0.1:${gateway.port}`,
          }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    try {
      expect(Buffer.from((await child.stdout.getReader().read()).value ?? []).toString()).toBe(
        "ready\n",
      )
      const request = (headers: Record<string, string> = {}) =>
        fetch("http://capability.invalid" + (gitPath ?? "/v1/messages"), {
          unix: join(root, "gateway.sock"),
          method: scenario === "git-refs" ? "GET" : "POST",
          headers: { authorization: "Bearer workflowd-local", ...headers },
          body: scenario === "git-refs" ? undefined : "{}",
        })
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
      await gateway.stop(true)
      child.kill("SIGKILL")
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  }, 10000)
}

test("R7: accelerated clock expiry refuses renewal resurrection", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-clock-tls-"))
  try {
    const tls = await loopbackCertificate(root)
    const child = Bun.spawn(
      [fixtureExecutable("node"), "--test", resolve("test/sandbox/fixtures/relay-clock.mjs")],
      {
        env: { PATH: "/usr/bin:/bin", NODE_EXTRA_CA_CERTS: tls.cert, RELAY_CLOCK_KEY: tls.key },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 10000)

test("the relay refuses a gateway that is not an HTTPS origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-origin-"))
  try {
    for (const gateway of [
      "http://127.0.0.1:1",
      "https://user@127.0.0.1:1",
      "https://127.0.0.1:1/path",
      "https://127.0.0.1:1/?q=1",
    ]) {
      const child = Bun.spawn(
        [fixtureExecutable("node"), resolve("deploy/sandbox/capability-relay.mjs"), "runner", root],
        {
          env: { PATH: "/usr/bin:/bin" },
          stdin: new Blob([
            JSON.stringify({
              token: "a".repeat(43),
              expiresAt: Date.now() + 1000,
              renewAt: Date.now() + 500,
              deadline: Date.now() + 2000,
              gateway,
            }),
          ]),
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, stdout, stderr }).toEqual({
        code: 1,
        stdout: "",
        stderr: "capability relay unavailable\n",
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
