import { expect, test } from "bun:test"
import { Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { openSession, takeJobIdentity } from "../../deploy/sandbox/bootstrap-helper.mjs"
import { join, resolve } from "node:path"
import { once } from "node:events"
import { createServer } from "node:net"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"

const channel = "c".repeat(64)
const grant = {
  token: "a".repeat(43),
  expiresAt: Date.now() + 10000,
  renewAt: Date.now() + 5000,
  deadline: Date.now() + 20000,
}
/** A gateway whose answers follow `plan`, one entry per request, and that records each request. */
function scriptedGateway(plan: Array<"challenge" | "grant" | number | "lost">) {
  const seen: string[] = []
  let nonce = 0
  const send = async (url: URL, init: RequestInit) => {
    seen.push(`${init.method ?? "GET"} ${url.pathname}`)
    const step = plan.shift()
    if (step === undefined) throw new Error("unexpected request")
    if (step === "lost") throw new TypeError("fetch failed")
    if (typeof step === "number") return new Response(null, { status: step })
    if (step === "grant") return Response.json(grant)
    nonce++
    return Response.json({ channel, nonce: String(nonce).repeat(64).slice(0, 64) })
  }
  return { send, seen }
}

test("the runner proves itself for each challenge and keeps only the granted session", async () => {
  const audiences: string[] = []
  const issue = async (audience: string) => {
    audiences.push(audience)
    return `proof-${audiences.length}`
  }
  // The first session answer is lost after the gateway sent it; the runner proves itself again.
  const gateway = scriptedGateway([
    "challenge",
    "lost",
    503,
    "challenge",
    503,
    "challenge",
    "grant",
  ])
  expect(
    await openSession({
      gateway: "https://gateway.fixture.invalid",
      leaseId: "lease",
      issue,
      send: gateway.send,
      backoff: () => 0,
      waitBackoff: () => 0,
    }),
  ).toEqual(grant)
  expect(gateway.seen).toEqual([
    "GET /capabilities/v1/challenge",
    "POST /capabilities/v1/session",
    "GET /capabilities/v1/challenge",
    "GET /capabilities/v1/challenge",
    "POST /capabilities/v1/session",
    "GET /capabilities/v1/challenge",
    "POST /capabilities/v1/session",
  ])
  expect(audiences).toEqual([
    `workflowd:${channel}:${"1".repeat(64)}`,
    `workflowd:${channel}:${"2".repeat(64)}`,
    `workflowd:${channel}:${"3".repeat(64)}`,
  ])
})

test("a refused challenge ends the exchange, and refused sessions end it after five proofs", async () => {
  let proofs = 0
  const issue = async () => `proof-${++proofs}`
  const refused = scriptedGateway([403])
  await expect(
    openSession({
      gateway: "https://gateway.fixture.invalid",
      leaseId: "lease",
      issue,
      send: refused.send,
      backoff: () => 0,
    }),
  ).rejects.toThrow("lease refused")
  expect(refused.seen).toEqual(["GET /capabilities/v1/challenge"])
  expect(proofs).toBe(0)
  const sessions = scriptedGateway(
    Array.from({ length: 5 }, () => ["challenge", 403] as const).flat(),
  )
  await expect(
    openSession({
      gateway: "https://gateway.fixture.invalid",
      leaseId: "lease",
      issue,
      send: sessions.send,
      backoff: () => 0,
    }),
  ).rejects.toThrow("gateway session unavailable")
  expect(proofs).toBe(5)
  for (const gateway of ["http://gateway.fixture.invalid", "https://u@gateway.fixture.invalid"])
    await expect(
      openSession({ gateway, leaseId: "lease", issue, send: refused.send }),
    ).rejects.toThrow("gateway refused")
  await expect(
    openSession({ gateway: "https://gateway.fixture.invalid", leaseId: "../x", issue }),
  ).rejects.toThrow("lease refused")
})

/** A gateway over HTTPS with a self-signed certificate for 127.0.0.1; it records each proof. */
async function tlsGateway() {
  const root = await mkdtemp(join(tmpdir(), "wfd-bootstrap-tls-"))
  const key = join(root, "tls.key")
  const cert = join(root, "tls.pem")
  const openssl = Bun.spawn(
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
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  )
  expect(await openssl.exited).toBe(0)
  const proofs: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/capabilities/v1/challenge") {
        expect(url.searchParams.get("lease")).toBe("lease")
        return Response.json({ channel, nonce: "d".repeat(64) })
      }
      expect(request.headers.get("content-type")).toBe("application/json")
      proofs.push(
        Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(await request.json())
          .token,
      )
      return Response.json(grant)
    },
  })
  return {
    url: `https://127.0.0.1:${server.port}`,
    ca: await Bun.file(cert).text(),
    proofs,
    close: async () => {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("the runner is admitted over HTTPS by a gateway it trusts; a certificate it does not trust ends the exchange at once", async () => {
  const gateway = await tlsGateway()
  try {
    const waits: number[] = []
    const admit = (trusted: boolean) =>
      openSession({
        gateway: gateway.url,
        leaseId: "lease",
        issue: async (audience) => `proof-for-${audience}`,
        send: (url, init) => fetch(url, { ...init, tls: trusted ? { ca: gateway.ca } : {} }),
        clock: () => waits.reduce((sum, wait) => sum + wait, 0),
        sleep: async (milliseconds) => {
          waits.push(milliseconds)
        },
      })
    await expect(admit(false)).rejects.toThrow(
      "gateway certificate not trusted (DEPTH_ZERO_SELF_SIGNED_CERT)",
    )
    expect(waits).toEqual([])
    expect(gateway.proofs).toEqual([])
    expect(await admit(true)).toEqual(grant)
    expect(gateway.proofs).toEqual([`proof-for-workflowd:${channel}:${"d".repeat(64)}`])
  } finally {
    await gateway.close()
  }
})

test("the runner's bootstrap names an untrusted gateway certificate and stops at once", async () => {
  const gateway = await tlsGateway()
  const directory = await mkdtemp(join(tmpdir(), "wfd-bootstrap-untrusted-"))
  try {
    const started = Date.now()
    const child = Bun.spawn(
      [
        fixtureExecutable("node"),
        "--input-type=module",
        "-e",
        `import { prepare } from ${JSON.stringify(resolve("deploy/sandbox/bootstrap.mjs"))}
await prepare({
  directory: ${JSON.stringify(directory)},
  identity: async () => Response.json({ value: "fixture-proof" }),
}).catch((error) => { process.stderr.write(error.message + "\\n"); process.exitCode = 1 })`,
      ],
      {
        env: {
          PATH: "/usr/bin:/bin",
          SANDBOX_AGENT_IMAGE: `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"b".repeat(64)}`,
          GITHUB_SHA: "a".repeat(40),
          GITHUB_REF: "refs/heads/workflowd/leases/lease",
          GITHUB_REPOSITORY: "fixture/repo",
          SANDBOX_GATEWAY_URL: gateway.url,
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.actions.githubusercontent.com/token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    )
    const [code, text] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ code, text }).toEqual({
      code: 1,
      text: "gateway certificate not trusted (DEPTH_ZERO_SELF_SIGNED_CERT)\n",
    })
    expect(Date.now() - started).toBeLessThan(10000)
    expect(gateway.proofs).toEqual([])
  } finally {
    await gateway.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test("a challenge is waited for after a 503, a refused connection, a reset, a timeout and a name that does not resolve yet, and after nothing else", async () => {
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const refusedUrl = `http://127.0.0.1:${closed.port}/`
  await closed.stop(true)
  const reset = createServer((socket) => socket.destroy())
  reset.listen(0, "127.0.0.1")
  await once(reset, "listening")
  const address = reset.address()
  if (address === null || typeof address === "string") throw new Error("listener unavailable")
  const resetUrl = `http://127.0.0.1:${address.port}/`
  try {
    const gateway = scriptedGateway(["challenge", "grant"])
    const faults: Array<() => Promise<Response>> = [
      () => fetch(refusedUrl),
      () => fetch(resetUrl),
      // The gateway's name before the runner has joined the tailnet, as Node's fetch and Bun's
      // fetch report it.
      () =>
        Promise.reject(
          Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
        ),
      () => Promise.reject(Object.assign(new TypeError("fetch failed"), { code: "ENOTFOUND" })),
      () =>
        Promise.reject(
          Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } }),
        ),
      () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
      async () => new Response(null, { status: 503 }),
    ]
    const waits: number[] = []
    let proofs = 0
    const open = (send: (url: URL, init: RequestInit) => Promise<Response>) =>
      openSession({
        gateway: "https://gateway.fixture.invalid",
        leaseId: "lease",
        issue: async () => `proof-${++proofs}`,
        send,
        clock: () => waits.reduce((sum, wait) => sum + wait, 0),
        sleep: async (milliseconds) => {
          waits.push(milliseconds)
        },
      })
    expect(await open((url, init) => faults.shift()?.() ?? gateway.send(url, init))).toEqual(grant)
    expect(waits).toHaveLength(7)
    expect(proofs).toBe(1)
    waits.length = 0
    // A name that never resolves is waited for only inside the same total limit.
    const unresolved = () =>
      Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }))
    await expect(open(unresolved)).rejects.toThrow("gateway session unavailable")
    expect(waits.reduce((sum, wait) => sum + wait, 0)).toBe(180000)
    expect(proofs).toBe(1)
    waits.length = 0
    for (const answer of [
      async () => new Response(null, { status: 500 }),
      async () => new Response(null, { status: 429 }),
      () => Promise.reject(new TypeError("fetch failed")),
    ])
      await expect(open(answer)).rejects.toThrow("gateway unavailable")
    expect(waits).toEqual([])
    expect(proofs).toBe(1)
  } finally {
    reset.close()
  }
}, 30000)

test("OIDC authority is removed before launch, consumed once, and refuses hostile origins", async () => {
  for (const origin of [
    "https://fixture.actions.githubusercontent.com/id",
    "http://fixture.actions.githubusercontent.com/id",
    "https://attacker.invalid/id",
    "https://user@fixture.actions.githubusercontent.com/id",
  ]) {
    const environment: Record<string, string | undefined> = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-oidc",
      ACTIONS_ID_TOKEN_REQUEST_URL: origin,
    }
    let requests = 0
    const issue = takeJobIdentity(environment, async (url, init) => {
      requests++
      expect(url.searchParams.get("audience")).toBe("workflowd:fixture")
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-oidc")
      expect(init.redirect).toBe("error")
      return Response.json({ value: "fixture-signed" })
    })
    expect(environment).toEqual({})
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k=>k.startsWith("ACTIONS_ID_TOKEN_REQUEST_"))))',
      ],
      { env: environment, stdout: "pipe", stderr: "pipe" },
    )
    expect(await new Response(child.stdout).text()).toBe("[]")
    expect(await child.exited).toBe(0)
    const result = await issue("workflowd:fixture", new AbortController().signal).catch(
      () => "refused",
    )
    expect(result).toBe(
      origin === "https://fixture.actions.githubusercontent.com/id" ? "fixture-signed" : "refused",
    )
    if (origin !== "https://fixture.actions.githubusercontent.com/id") {
      await expect(issue("workflowd:fixture", new AbortController().signal)).rejects.toThrow()
      expect(requests).toBe(0)
    }
  }
})

test("OIDC authority issues at most its limit of proofs, and none after clear", async () => {
  const environment: Record<string, string | undefined> = {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-oidc",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.actions.githubusercontent.com/id",
  }
  let requests = 0
  const send = async () => {
    requests++
    return Response.json({ value: `fixture-signed-${requests}` })
  }
  const signal = new AbortController().signal
  const limited = takeJobIdentity({ ...environment }, send)
  for (let issued = 1; issued <= 5; issued++)
    expect(await limited("workflowd:fixture", signal)).toBe(`fixture-signed-${issued}`)
  await expect(limited("workflowd:fixture", signal)).rejects.toThrow("job identity unavailable")
  expect(requests).toBe(5)
  const cleared = takeJobIdentity({ ...environment }, send, 2)
  expect(await cleared("workflowd:fixture", signal)).toBe("fixture-signed-6")
  cleared.clear()
  await expect(cleared("workflowd:fixture", signal)).rejects.toThrow("job identity unavailable")
  expect(requests).toBe(6)
})
