import { expect, test } from "bun:test"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { generateKeyPairSync, sign } from "node:crypto"
import { once } from "node:events"
import { createServer as httpsServer } from "node:https"
import { request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import { pipeline } from "node:stream"
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Octokit } from "@octokit/rest"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeSandboxStore } from "../../src/sandbox/store"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { runStoreMigrations } from "../../src/store/migrations"

/** The bound port of a listening TCP server. */
function portOf(server: { address(): string | AddressInfo | null }) {
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("listener unavailable")
  return address.port
}

const hostileClaims: Record<string, Record<string, unknown>> = {
  fork: { repository: "fork/repo", repository_id: "99" },
  owner: { repository_owner_id: "99" },
  actor: { actor_id: "99" },
  ref: { ref: "refs/heads/main" },
  issuer: { iss: "https://fixture.invalid" },
  replay: { aud: "workflowd:previous-connection" },
  sha: { sha: "f".repeat(40) },
  workflow: { job_workflow_ref: "fixture/repo/.github/workflows/untrusted.yml@main" },
  "workflow-pin": { job_workflow_sha: "f".repeat(40) },
  event: { event_name: "pull_request" },
  runner: { runner_environment: "self-hosted" },
  expired: { exp: 1 },
  attempt: { run_attempt: "2" },
}

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

/**
 * TLS in front of the gateway process, as Tailscale Serve is in production. It drops the first
 * session answer that the gateway grants: the gateway sends it, the runner never gets it.
 */
async function tlsFront(tls: { key: string; cert: string }, gatewayPort: number) {
  let dropped = 0
  const server = httpsServer(
    { key: await readFile(tls.key), cert: await readFile(tls.cert) },
    (incoming, outgoing) => {
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: gatewayPort,
          path: incoming.url,
          method: incoming.method,
          headers: incoming.headers,
        },
        (reply) => {
          if (
            incoming.url === "/capabilities/v1/session" &&
            reply.statusCode === 200 &&
            dropped === 0
          ) {
            dropped++
            reply.resume()
            reply.once("end", () => incoming.socket.destroy())
            return
          }
          outgoing.writeHead(reply.statusCode ?? 502, reply.headers)
          pipeline(reply, outgoing, () => {})
        },
      )
      upstream.once("error", () => outgoing.destroy())
      pipeline(incoming, upstream, () => {})
    },
  )
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return {
    port: portOf(server),
    dropped: () => dropped,
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

// One key pair serves every case: the job keys, and the GitHub App key of the fixture.
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwks = {
  keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "fixture", use: "sig", alg: "RS256" }],
}

for (const race of [
  false,
  true,
  "revoke-failure",
  "release-failure",
  ...Object.keys(hostileClaims),
  "key",
])
  test(`private HTTPS session bootstrap through the gateway process; bind race=${race}`, async () => {
    const node = fixtureExecutable("node")
    const root = await mkdtemp(join(tmpdir(), "wfd-private-job-"))
    const sandbox = join(root, "sandbox")
    const database = join(root, "store.sqlite")
    await mkdir(sandbox, { mode: 0o700 })
    const tls = await loopbackCertificate(root)
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
    const native = '{ "model" : "fixture-model", "stream": true, "messages": [] }'
    const response = "event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n"
    let upstreamEffects = 0
    let publicArtifacts = 0
    let proofs = 0
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer fixture-provider-access")
        expect(request.headers.get("x-api-key")).toBeNull()
        expect(JSON.parse(await request.text())).toEqual(JSON.parse(native))
        upstreamEffects++
        return new Response(response, { headers: { "content-type": "text/event-stream" } })
      },
    })
    // The runner's OIDC issuer. A hostile race makes the first proof hostile; later proofs are good.
    const issuer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer fixture-request")
        const audience = new URL(request.url).searchParams.get("audience")
        const ref = "refs/heads/workflowd/leases/lease"
        const now = Math.floor(Date.now() / 1000)
        proofs++
        const payload = {
          iss: "https://token.actions.githubusercontent.com",
          aud: audience,
          sub: `repo:fixture@34/repo@12:ref:${ref}`,
          jti: `fixture-jti-${proofs}`,
          iat: now,
          nbf: now,
          exp: now + 120,
          repository: "fixture/repo",
          repository_id: "12",
          repository_owner_id: "34",
          repository_owner: "fixture",
          actor_id: "56",
          ref,
          sha: policy.workflowSha,
          workflow_ref: `fixture/repo/.github/workflows/agent-sandbox-caller.yml@${ref}`,
          workflow_sha: policy.workflowSha,
          job_workflow_ref: `fixture/repo/.github/workflows/agent-sandbox.yml@${ref}`,
          job_workflow_sha: policy.workflowSha,
          run_id: "78",
          run_attempt: "1",
          event_name: "push",
          runner_environment: "github-hosted",
        }
        const hostile =
          proofs === 1 && typeof race === "string" && (race in hostileClaims || race === "key")
        const input = [
          {
            alg: "RS256",
            typ: "JWT",
            kid: hostile && race === "key" ? "untrusted-key" : "fixture",
          },
          hostile ? { ...payload, ...hostileClaims[String(race)] } : payload,
        ]
          .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
          .join(".")
        return Response.json({
          value: `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`,
        })
      },
    })
    const github = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path.endsWith("/access_tokens"))
          return Response.json(
            { token: "fixture-github", expires_at: new Date(Date.now() + 3600000).toISOString() },
            { status: 201 },
          )
        if (path === "/repos/fixture/repo")
          return Response.json({ id: 12, full_name: "fixture/repo", fork: false, private: false })
        if (path.includes("/git/ref/heads/"))
          return Response.json({
            ref: "refs/heads/workflowd/leases/lease",
            object: { sha: policy.workflowSha },
          })
        if (path.endsWith("/actions/runs"))
          return Response.json({
            total_count: 1,
            workflow_runs: [
              {
                id: 78,
                run_attempt: 1,
                event: "push",
                head_sha: policy.workflowSha,
                head_branch: "workflowd/leases/lease",
                path: ".github/workflows/agent-sandbox-caller.yml",
                repository: { id: 12, fork: false },
                head_repository: { id: 12, fork: false },
                actor: { id: 56 },
                triggering_actor: { id: 56 },
                status: "in_progress",
                conclusion: null,
              },
            ],
          })
        if (path.includes("/artifacts")) publicArtifacts++
        return new Response(null, { status: 404 })
      },
    })
    const config = {
      nodeBinary: node,
      noscope: { binary: fixtureExecutable("noscope"), configHome: root },
      providerId: "anthropic",
      credentialRole: "fixture",
      maxStreams: 8,
      maxStreamsPerRun: 2,
      listen: { host: "127.0.0.1", port: 0 },
    }
    let gateway: ReturnType<typeof Bun.spawn> | undefined
    let front: Awaited<ReturnType<typeof tlsFront>> | undefined
    const relayPid = () =>
      readFile(join(sandbox, "relay.pid"), "utf8").then(Number, () => undefined)
    try {
      await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
      await writeFile(
        join(root, "app.pem"),
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 },
      )
      await writeFile(
        join(root, "run.mjs"),
        `import {randomBytes,randomUUID} from 'node:crypto';process.stdout.write(JSON.stringify({token:randomBytes(32).toString('base64url'),token_id:randomUUID(),expires_at:new Date(Date.now()+Number(process.argv[2])*1000).toISOString()}))`,
      )
      await writeFile(
        join(root, "access.mjs"),
        'process.stdout.write(JSON.stringify({token:"fixture-provider-access",token_id:"fixture",expires_at:new Date(Date.now()+120000).toISOString()}))',
      )
      for (const [name, script, argument] of [
        ["run-capability", "run.mjs", " {ttl}"],
        ["provider-access", "access.mjs", ""],
      ] as const)
        await writeFile(
          join(root, `noscope/providers/${name}.toml`),
          `contract_version = 1\n[commands]\nmint = "${node} ${join(root, script)}${argument}"\n`,
          { mode: 0o600 },
        )
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* runStoreMigrations
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO directory_local_identity(singleton,host_id) VALUES(1,'fixture-controller')`
          const runs = yield* AgentRunStore
          const now = new Date()
          yield* runs.create({
            runId: "run",
            route: "fixture",
            providerId: "anthropic",
            modelId: "fixture-model",
            executorKind: "claude",
            agent: "sandbox",
            repository: "fixture",
            directory: root,
            prompt: "fixture",
            promptSha256: "c".repeat(64),
            parentSessionId: null,
            resumePrompt: null,
            maxAttempts: 1,
            createdAt: now,
          })
          yield* runs.claimSpawn({ runId: "run", now })
          const store = yield* makeSandboxStore
          yield* store.request({
            runId: "run",
            leaseId: "lease",
            policy,
            sourceSha: "d".repeat(40),
            now: now.getTime(),
          })
          // workflowd's side: its own gateway (for revocation) and the lease service.
          const local = yield* makeCapabilityGateway(config)
          const api = yield* makeSandboxGithub(
            { appId: 1, privateKeyPath: join(root, "app.pem") },
            Octokit.defaults({
              baseUrl: github.url.toString(),
              log: { debug() {}, info() {}, warn() {}, error() {} },
            }),
          )
          const leases = yield* makeSandboxLeaseService(
            api,
            root,
            () => Promise.reject(new Error("no controller command for a private lease")),
            {
              native: { gateway: local },
              publicationContract: { reference: "fixture-only:worktree", receipt: "fixed-v1" },
            },
          )
          // The run is recorded before the runner asks; with no session the lease stays starting.
          expect((yield* leases.acquire("run")).state).toBe("starting")

          // The gateway as its own process, behind TLS; then the real bootstrap and relay.
          const child = Bun.spawn(
            [
              process.execPath,
              "-e",
              `import { runCapabilityGatewayServer } from ${JSON.stringify(resolve("src/capability-gateway-server.ts"))}
import { Effect } from "effect"
Effect.runFork(runCapabilityGatewayServer(process.env, {
  keys: async () => (${JSON.stringify(jwks)}),
  upstream: (url, init) => fetch(url.replace("https://api.anthropic.com", ${JSON.stringify(upstream.url.origin)}), init),
}))`,
            ],
            {
              cwd: resolve("."),
              env: {
                PATH: process.env.PATH,
                HOME: root,
                WORKFLOWD_DATABASE_PATH: database,
                WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(config),
              },
              stdout: "pipe",
              stderr: "inherit",
            },
          )
          gateway = child
          const listening = yield* Effect.promise(async () => {
            const reader = child.stdout.getReader()
            let text = ""
            while (!text.includes("\n")) {
              const part = await reader.read()
              if (part.done) throw new Error("gateway process exited before listening")
              text += Buffer.from(part.value).toString()
            }
            reader.releaseLock()
            return Number(/^listening (\d+)$/m.exec(text)?.[1])
          })
          const tlsGateway = yield* Effect.promise(() => tlsFront(tls, listening))
          front = tlsGateway
          const bootstrap = Bun.spawn(
            [
              node,
              "--input-type=module",
              "-e",
              `import { prepare } from ${JSON.stringify(resolve("deploy/sandbox/bootstrap.mjs"))}
await prepare({
  directory: ${JSON.stringify(sandbox)},
  identity: (url, init) => fetch(${JSON.stringify(issuer.url.origin + "/token")} + url.search, init),
  // The fixture's gateway answers at once: a new proof after a lost or refused one need not wait.
  backoff: () => 0,
})`,
            ],
            {
              env: {
                PATH: "/usr/bin:/bin",
                SANDBOX_AGENT_IMAGE: policy.agentImage,
                GITHUB_SHA: policy.workflowSha,
                GITHUB_REF: "refs/heads/workflowd/leases/lease",
                GITHUB_REPOSITORY: policy.repository,
                SANDBOX_GATEWAY_URL: `https://127.0.0.1:${tlsGateway.port}`,
                ACTIONS_ID_TOKEN_REQUEST_URL:
                  "https://fixture.actions.githubusercontent.com/token?api-version=2",
                ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request",
                NODE_EXTRA_CA_CERTS: tls.cert,
              },
              stdout: "ignore",
              stderr: "pipe",
            },
          )
          const [code, diagnostic] = yield* Effect.promise(() =>
            Promise.all([bootstrap.exited, new Response(bootstrap.stderr).text()]),
          )
          expect({ code, diagnostic }).toEqual({ code: 0, diagnostic: "" })
          // The gateway sent the first session and the runner lost it; a hostile first proof
          // opened nothing. Two proofs opened sessions; the runner holds the second.
          expect(tlsGateway.dropped()).toBe(1)
          expect(
            yield* sql`SELECT (SELECT count(*) FROM capability_proofs) AS proofs,
              (SELECT session FROM capability_bindings) AS session`,
          ).toEqual([{ proofs: 2, session: 2 }])
          const hostileFirst = typeof race === "string" && (race in hostileClaims || race === "key")
          expect(proofs).toBe(hostileFirst ? 3 : 2)
          expect(
            yield* Effect.promise(() => readFile(join(sandbox, "execution-mode"), "utf8")),
          ).toBe("actions-native")
          const request = (sentinel: string) =>
            fetch("http://capability.invalid/v1/messages", {
              unix: join(sandbox, "gateway.sock"),
              method: "POST",
              body: native,
              headers: {
                authorization: `Bearer ${sentinel}`,
                "content-type": "application/json",
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "oauth-2025-04-20",
              },
            })
          if (race === true || race === "revoke-failure") {
            if (race === "revoke-failure")
              yield* sql`CREATE TRIGGER fixture_revoke_failure BEFORE UPDATE OF revoked ON capability_bindings BEGIN SELECT RAISE(FAIL,'fixture revoke failure'); END`
            // A second acquirer takes the operation after this one records the run, before it
            // commits the session.
            yield* sql`CREATE TRIGGER fixture_owner_race AFTER UPDATE OF actions_run_id ON sandbox_leases
              BEGIN UPDATE sandbox_lease_operations SET owner='fixture-new-owner',generation=generation+1; END`
            expect((yield* Effect.exit(leases.acquire("run")))._tag).toBe("Failure")
            expect((yield* store.read("run"))?.state).toBe("starting")
            expect(yield* sql`SELECT revoked FROM capability_bindings`).toEqual([
              { revoked: race === true ? 1 : 0 },
            ])
            if (race === true)
              expect((yield* Effect.promise(() => request("workflowd-local"))).status).toBe(403)
            expect(upstreamEffects).toBe(0)
            return
          }
          let lease = yield* leases.acquire("run")
          for (let tries = 0; lease.state !== "ready" && tries < 50; tries++)
            lease = yield* leases.acquire("run")
          expect(lease.state).toBe("ready")
          expect(lease.transport).toBeNull()
          if (race === "release-failure") {
            yield* sql`CREATE TRIGGER fixture_revoke_failure BEFORE UPDATE OF revoked ON capability_bindings BEGIN SELECT RAISE(FAIL,'fixture revoke failure'); END`
            expect((yield* Effect.exit(leases.release("run")))._tag).toBe("Failure")
            expect((yield* store.read("run"))?.state).not.toBe("released")
            yield* sql`DROP TRIGGER fixture_revoke_failure`
            return
          }
          expect((yield* Effect.promise(() => request("foreign"))).status).toBe(403)
          expect(upstreamEffects).toBe(0)
          const accepted = yield* Effect.promise(() => request("workflowd-local"))
          expect(accepted.status).toBe(200)
          expect(yield* Effect.promise(() => accepted.text())).toBe(response)
          expect(upstreamEffects).toBe(1)
          expect(publicArtifacts).toBe(0)
          // workflowd revokes; the gateway process refuses the relay's next call.
          yield* local.revoke("run")
          expect((yield* Effect.promise(() => request("workflowd-local"))).status).toBe(403)
          expect(upstreamEffects).toBe(1)
        }).pipe(
          Effect.provide(AgentRunStoreLive),
          Effect.provide(SqliteClient.layer({ filename: database })),
          Effect.scoped,
        ),
      )
    } finally {
      const pid = await relayPid()
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // The relay already stopped.
        }
      }
      front?.close()
      gateway?.kill("SIGKILL")
      await gateway?.exited
      await issuer.stop(true)
      await github.stop(true)
      await upstream.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
