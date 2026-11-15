import { expect, test } from "bun:test"
import { Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { openSession, takeJobIdentity } from "../../deploy/sandbox/bootstrap-helper.mjs"
import { join } from "node:path"

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

test("the runner is admitted over HTTPS by a gateway it trusts, and not by one it does not", async () => {
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
  try {
    const ca = await Bun.file(cert).text()
    const admit = (trusted: boolean) =>
      openSession({
        gateway: `https://127.0.0.1:${server.port}`,
        leaseId: "lease",
        issue: async (audience) => `proof-for-${audience}`,
        send: (url, init) => fetch(url, { ...init, tls: trusted ? { ca } : {} }),
        attempts: 1,
      })
    await expect(admit(false)).rejects.toThrow("gateway session unavailable")
    expect(proofs).toEqual([])
    expect(await admit(true)).toEqual(grant)
    expect(proofs).toEqual([`proof-for-workflowd:${channel}:${"d".repeat(64)}`])
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

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
