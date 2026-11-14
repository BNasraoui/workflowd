import { expect, spyOn, test } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { createServer } from "node:http"
import { discoverJobPeer, githubJobKeys, verifyJobProof } from "../../src/sandbox/bootstrap"
import { parseSandboxRepositories } from "../../src/sandbox/config"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwks = {
  keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" }],
}
const expected = {
  audience: "workflowd:fixture-challenge",
  repository: "fixture/repo",
  repositoryId: 12,
  ownerId: 34,
  actorId: 56,
  ref: "refs/heads/workflowd/leases/fixture",
  workflowSha: "a".repeat(40),
  toolingSha: "b".repeat(40),
  runId: 78,
  attempt: 1,
  workflowRef:
    "fixture/repo/.github/workflows/agent-sandbox-caller.yml@refs/heads/workflowd/leases/fixture",
  jobWorkflowRef: `BNasraoui/workflowd/.github/workflows/agent-sandbox.yml@${"b".repeat(40)}`,
}
const now = 1800000000000
const claims = {
  iss: "https://token.actions.githubusercontent.com",
  aud: expected.audience,
  repository: expected.repository,
  repository_id: "12",
  repository_owner_id: "34",
  repository_owner: "fixture",
  actor_id: "56",
  ref: expected.ref,
  sha: expected.workflowSha,
  workflow_ref: expected.workflowRef,
  workflow_sha: expected.workflowSha,
  job_workflow_ref: expected.jobWorkflowRef,
  job_workflow_sha: expected.toolingSha,
  run_id: "78",
  run_attempt: "1",
  event_name: "push",
  runner_environment: "github-hosted",
  sub: `repo:fixture@34/repo@12:ref:${expected.ref}`,
  jti: "fixture-jti",
  iat: now / 1000 - 1,
  nbf: now / 1000 - 1,
  exp: now / 1000 + 120,
}
function token(change = {}, header = {}) {
  const input = [
    { alg: "RS256", typ: "JWT", kid: "fixture", ...header },
    { ...claims, ...change },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".")
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`
}

test("a signed exact GitHub job proves the private challenge", () => {
  expect(verifyJobProof(token(), expected, jwks, now)).toEqual({
    jti: "fixture-jti",
    expiresAt: now + 120000,
  })
})

test("signature, immutable job context and fresh challenge are all required", () => {
  expect(verifyJobProof(token(), expected, jwks, now).jti).toBe("fixture-jti")
  for (const change of [
    { repository: "fork/repo" },
    { repository_id: "99" },
    { repository_owner_id: "99" },
    { repository_owner: "fork" },
    { actor_id: "99" },
    { ref: "refs/heads/main" },
    { sha: "c".repeat(40) },
    { workflow_sha: "c".repeat(40) },
    { workflow_ref: "other" },
    { job_workflow_ref: "other" },
    { job_workflow_sha: "c".repeat(40) },
    { run_id: "99" },
    { run_attempt: "2" },
    { event_name: "pull_request" },
    { runner_environment: "self-hosted" },
    { sub: "repo:fixture/repo:ref:main" },
    { aud: "another-connection" },
    { iss: "https://attacker.invalid" },
    { exp: now / 1000 },
    { nbf: now / 1000 + 1 },
    { jti: "" },
  ])
    expect(() => verifyJobProof(token(change), expected, jwks, now)).toThrow("job proof refused")
  for (const header of [
    { alg: "none" },
    { alg: "HS256" },
    { jku: "https://attacker.invalid/keys" },
    { jwk: jwks.keys[0] },
    { x5u: "https://attacker.invalid/key" },
    { crit: ["other"] },
  ])
    expect(() => verifyJobProof(token({}, header), expected, jwks, now)).toThrow(
      "job proof refused",
    )
  expect(() => verifyJobProof(token().slice(0, -10), expected, jwks, now)).toThrow(
    "job proof refused",
  )
})

test("job key retrieval authenticates the signed job and refuses redirected or oversized trust data", async () => {
  let response = () => Response.json(jwks)
  let redirectedRequests = 0
  const untrusted = Bun.serve({
    port: 0,
    fetch: () => {
      redirectedRequests++
      return Response.json(jwks)
    },
  })
  const issuer = Bun.serve({ port: 0, fetch: () => response() })
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = input instanceof Request ? input.url : String(input)
        requests.push(url)
        expect(url).toBe("https://token.actions.githubusercontent.com/.well-known/jwks")
        // Only DNS/origin routing is substituted; native fetch still enforces
        // redirects, streams the actual response and observes cancellation.
        return originalFetch(`http://127.0.0.1:${issuer.port}/.well-known/jwks`, init)
      },
      { preconnect: originalFetch.preconnect },
    ),
  )
  try {
    const signal = new AbortController().signal
    const keys = await githubJobKeys(signal)
    expect(verifyJobProof(token(), expected, keys, now).jti).toBe("fixture-jti")
    expect(() => verifyJobProof(token({ aud: "another-job" }), expected, keys, now)).toThrow(
      "job proof refused",
    )
    response = () => Response.redirect(`http://127.0.0.1:${untrusted.port}/keys`)
    await expect(githubJobKeys(signal)).rejects.toThrow()
    expect(redirectedRequests).toBe(0)
    response = () => new Response("unavailable", { status: 503 })
    await expect(githubJobKeys(signal)).rejects.toThrow("job keys unavailable")
    response = () => new Response("not-json")
    await expect(githubJobKeys(signal)).rejects.toThrow()
    response = () => new Response(JSON.stringify(jwks).padEnd(65536, " "))
    expect(verifyJobProof(token(), expected, await githubJobKeys(signal), now).jti).toBe(
      "fixture-jti",
    )
    response = () => new Response(JSON.stringify(jwks).padEnd(65537, " "))
    await expect(githubJobKeys(signal)).rejects.toThrow("job keys unavailable")
    expect(requests).toHaveLength(6)
  } finally {
    fetchMock.mockRestore()
    await issuer.stop(true)
    await untrusted.stop(true)
  }
})

test("cancelling job key retrieval aborts the real upstream response", async () => {
  const started = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  const issuer = createServer((request, response) => {
    request.socket.once("close", () => stopped.resolve())
    response.write(JSON.stringify(jwks))
  })
  await new Promise<void>((resolve) => issuer.listen(0, "127.0.0.1", resolve))
  const address = issuer.address()
  if (!address || typeof address === "string") throw new Error("job key fixture did not listen")
  const originalFetch = globalThis.fetch
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = input instanceof Request ? input.url : String(input)
        expect(url).toBe("https://token.actions.githubusercontent.com/.well-known/jwks")
        const response = await originalFetch(
          `http://127.0.0.1:${address.port}/.well-known/jwks`,
          init,
        )
        started.resolve()
        return response
      },
      { preconnect: originalFetch.preconnect },
    ),
  )
  const controller = new AbortController()
  try {
    const failure = githubJobKeys(controller.signal).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    await started.promise
    controller.abort()
    expect(await failure).toBeInstanceOf(Error)
    await stopped.promise
  } finally {
    controller.abort()
    fetchMock.mockRestore()
    issuer.closeAllConnections()
    await new Promise<void>((resolve) => issuer.close(() => resolve()))
  }
})

const peer = {
  ID: "fixture-peer",
  HostName: "lease-78-1",
  Online: true,
  TailscaleIPs: ["100.64.0.1"],
  Tags: ["tag:agent-runner"],
  sshHostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture"],
}
test("discovery uses an unambiguous authenticated peer hint, never a supplied address", () => {
  expect(discoverJobPeer({ Peer: { a: peer } }, 78, 1)).toEqual({
    peerId: peer.ID,
    address: "100.64.0.1",
    keys: peer.sshHostKeys,
  })
  expect(discoverJobPeer({ Peer: {} }, 78, 1)).toBeNull()
  for (const value of [
    { Peer: { a: peer, b: { ...peer, ID: "duplicate" } } },
    { Peer: { a: { ...peer, Online: false } } },
    { Peer: { a: { ...peer, Tags: [] } } },
    { Peer: { a: { ...peer, sshHostKeys: [] } } },
    { Peer: { a: { ...peer, TailscaleIPs: ["127.0.0.1"] } } },
  ])
    expect(() => discoverJobPeer(value, 78, 1)).toThrow("job peer refused")
})

test("private bootstrap selection is explicit and preserves its immutable owner and execution mode", () => {
  const policy = {
    alias: "fixture",
    repository: "fixture/repo",
    repositoryId: 12,
    installationId: 1,
    workflowSha: "a".repeat(40),
    appActorId: 56,
    agentImage: `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"b".repeat(64)}`,
    tailscaleClientId: "fixture",
    tailscaleAudience: "fixture",
    privateBootstrap: { repositoryOwnerId: 34, mode: "actions-native" as const },
  }
  expect(parseSandboxRepositories(JSON.stringify([policy]))[0]).toEqual(policy)
  expect(() =>
    parseSandboxRepositories(
      JSON.stringify([
        { ...policy, privateBootstrap: { repositoryOwnerId: 0, mode: "actions-native" } },
      ]),
    ),
  ).toThrow()
})
