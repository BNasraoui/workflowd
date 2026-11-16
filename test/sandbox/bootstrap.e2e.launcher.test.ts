import { expect, test } from "bun:test"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { loopbackCertificate, tlsFront } from "../helpers/loopback-tls"
import { sign } from "node:crypto"
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, readlink, stat } from "node:fs/promises"
import {
  gatewaySource,
  jwks,
  signingKey,
  startGatewayProcess,
  type Gateway,
} from "../capability-gateway/gateway-process"
import { writeNoscopeProviders } from "../capability-gateway/fixture"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Octokit } from "@octokit/rest"
import { makeDaemonCapability } from "../../src/sandbox/capability-control"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeSandboxStore } from "../../src/sandbox/store"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { runStoreMigrations } from "../../src/store/migrations"
import { sessionKeyPair } from "../../deploy/sandbox/renewal.mjs"

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

/** The forms in which a session's private key could be written: its PKCS #8 bytes and its seed. */
const keyForms = (privateKey: string) => {
  const der = Buffer.from(privateKey, "base64url")
  const seed = der.subarray(-32)
  return [der, seed].flatMap((bytes) => [
    bytes.toString("base64url"),
    bytes.toString("base64").replace(/=+$/, ""),
    bytes.toString("hex"),
  ])
}

/**
 * The outputs of the bootstrap and of its running relay: the bootstrap's standard output and
 * error, each file in the sandbox directory, and the relay's environment, arguments and the
 * targets of its standard output and error; with the gateway's output.
 */
async function runnerOutputs(
  sandbox: string,
  relay: number,
  bootstrap: { readonly stdout: string; readonly stderr: string },
  gateway: string,
) {
  const outputs: Record<string, string> = {
    "bootstrap standard output": bootstrap.stdout,
    "bootstrap standard error": bootstrap.stderr,
    "relay environment": await readFile(`/proc/${relay}/environ`, "latin1"),
    "relay arguments": await readFile(`/proc/${relay}/cmdline`, "latin1"),
    "relay standard output": await readlink(`/proc/${relay}/fd/1`),
    "relay standard error": await readlink(`/proc/${relay}/fd/2`),
    "gateway output": gateway,
  }
  for (const name of await readdir(sandbox))
    if ((await stat(join(sandbox, name))).isFile())
      outputs[`file ${name}`] = await readFile(join(sandbox, name), "latin1")
  return outputs
}

/** Each output of `outputs` that holds a form of `privateKey`. */
const holding = (outputs: Record<string, string>, privateKey: string) =>
  Object.entries(outputs)
    .filter(([, text]) => keyForms(privateKey).some((form) => text.includes(form)))
    .map(([name]) => name)

// One key pair serves every case: the job keys, and the GitHub App key of the fixture.
for (const race of [
  false,
  true,
  "revoke-failure",
  "release-failure",
  ...Object.keys(hostileClaims),
  "key",
  // The bootstrap's environment carries the private key, which the relay then holds: the search
  // of the outputs finds it there.
  "planted",
])
  test(`private HTTPS session bootstrap through the gateway process; bind race=${race}`, async () => {
    const node = fixtureExecutable("node")
    const sessionKey = sessionKeyPair()
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
        expect(request.headers.get("authorization")).toBe("Bearer fixture-access")
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
        // The job keys, as GitHub publishes them for its proofs.
        if (new URL(request.url).pathname === "/jwks") return Response.json(jwks)
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
          value: `${input}.${sign("RSA-SHA256", Buffer.from(input), signingKey).toString("base64url")}`,
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
    // The front drops the first session answer that the gateway grants: the gateway sends it, the
    // runner never gets it.
    let dropped = 0
    const front = await tlsFront(tls, join(root, "front", "gateway.sock"), {
      lost: (path, status) => {
        if (path !== "/capabilities/v1/session" || status !== 200 || dropped > 0) return false
        dropped++
        return true
      },
    })
    const config = {
      noscope: { binary: fixtureExecutable("noscope"), configHome: root },
      providerId: "anthropic",
      credentialRole: "fixture",
      maxStreams: 8,
      maxStreamsPerRun: 2,
      storePath: join(root, "gateway.db"),
      controlSocket: join(root, "control", "gateway.sock"),
      daemon: { uid: process.getuid!(), gid: process.getgid!() },
      listen: {
        socket: join(root, "front", "gateway.sock"),
        front: { uid: process.getuid!(), gid: process.getgid!() },
        service: front.service,
      },
    }
    /** A query on the gateway's own store, which the gateway process holds. */
    const gatewayStore = <A>(query: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
      Effect.promise(() =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`PRAGMA busy_timeout = 5000`
              return yield* query(sql)
            }),
          ).pipe(Effect.provide(SqliteClient.layer({ filename: config.storePath }))),
        ),
      )
    let gateway: Gateway | undefined
    const relayPid = () =>
      readFile(join(sandbox, "relay.pid"), "utf8").then(Number, () => undefined)
    try {
      await writeFile(join(root, "app.pem"), signingKey.export({ type: "pkcs8", format: "pem" }), {
        mode: 0o600,
      })
      await writeNoscopeProviders(root, 120000)
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
          // workflowd's side: its control client of the gateway and the lease service.
          const local = yield* makeDaemonCapability({
            socket: config.controlSocket,
            reconcileEveryMs: 3600000,
          })
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
            },
          )
          // The gateway as its own process, behind TLS; then the real bootstrap and relay.
          gateway = yield* Effect.promise(() =>
            startGatewayProcess(
              [
                process.execPath,
                "-e",
                gatewaySource({
                  keysUrl: `${issuer.url.origin}/jwks`,
                  upstreamUrl: upstream.url.origin,
                }),
              ],
              {
                PATH: process.env.PATH,
                HOME: root,
                TMPDIR: root,
                WORKFLOWD_CAPABILITY_GATEWAY: JSON.stringify(config),
              },
              front,
            ),
          )
          // The run is recorded and granted before the runner asks; with no session the lease
          // stays starting.
          expect((yield* leases.acquire("run")).state).toBe("starting")
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
  sessionKey: ${JSON.stringify(sessionKey)},
})`,
            ],
            {
              env: {
                PATH: "/usr/bin:/bin",
                GITHUB_SHA: policy.workflowSha,
                GITHUB_REF: "refs/heads/workflowd/leases/lease",
                GITHUB_REPOSITORY: policy.repository,
                SANDBOX_GATEWAY_URL: front.origin,
                ACTIONS_ID_TOKEN_REQUEST_URL:
                  "https://fixture.actions.githubusercontent.com/token?api-version=2",
                ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request",
                NODE_EXTRA_CA_CERTS: tls.cert,
                ...(race === "planted" ? { RUNNER_TRACKING_ID: sessionKey.privateKey } : {}),
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          const [code, printed, diagnostic] = yield* Effect.promise(() =>
            Promise.all([
              bootstrap.exited,
              new Response(bootstrap.stdout).text(),
              new Response(bootstrap.stderr).text(),
            ]),
          )
          expect({ code, printed, diagnostic }).toEqual({ code: 0, printed: "", diagnostic: "" })
          // The gateway sent the first session and the runner lost it; a hostile first proof
          // opened nothing. Two proofs opened sessions; the runner holds the second.
          expect(dropped).toBe(1)
          expect(
            yield* gatewayStore(
              (gateway) => gateway`SELECT (SELECT count(*) FROM capability_proofs) AS proofs,
              (SELECT session FROM capability_bindings) AS session`,
            ),
          ).toEqual([{ proofs: 2, session: 2 }])
          // The session holds the public key of the runner's session key.
          expect(
            yield* gatewayStore((gateway) => gateway`SELECT session_key FROM capability_bindings`),
          ).toEqual([{ session_key: sessionKey.publicKey }])
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
              yield* gatewayStore(
                (gateway) =>
                  gateway`CREATE TRIGGER fixture_revoke_failure BEFORE UPDATE OF revoked ON capability_bindings BEGIN SELECT RAISE(FAIL,'fixture revoke failure'); END`,
              )
            // A second acquirer takes the operation after this one records the run, before it
            // commits the session.
            yield* sql`CREATE TRIGGER fixture_owner_race AFTER UPDATE OF actions_run_id ON sandbox_leases
              BEGIN UPDATE sandbox_lease_operations SET owner='fixture-new-owner',generation=generation+1; END`
            expect((yield* Effect.exit(leases.acquire("run")))._tag).toBe("Failure")
            expect((yield* store.read("run"))?.state).toBe("starting")
            expect(
              yield* gatewayStore((gateway) => gateway`SELECT revoked FROM capability_bindings`),
            ).toEqual([{ revoked: race === true ? 1 : 0 }])
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
            // The gateway cannot confirm the revoke; the release goes on without it.
            yield* Effect.promise(() => gateway!.stop())
            yield* Effect.exit(leases.release("run"))
            expect(["releasing", "released"]).toContain(String((yield* store.read("run"))?.state))
            return
          }
          expect((yield* Effect.promise(() => request("foreign"))).status).toBe(403)
          expect(upstreamEffects).toBe(0)
          const accepted = yield* Effect.promise(() => request("workflowd-local"))
          expect(accepted.status).toBe(200)
          expect(yield* Effect.promise(() => accepted.text())).toBe(response)
          expect(upstreamEffects).toBe(1)
          // No output of the bootstrap or of the relay holds the private key.
          const outputs = yield* Effect.promise(async () =>
            runnerOutputs(
              sandbox,
              (await relayPid()) ?? 0,
              { stdout: printed, stderr: diagnostic },
              gateway?.output?.() ?? "",
            ),
          )
          expect(Object.keys(outputs)).toEqual(
            expect.arrayContaining(["relay environment", "file relay.pid", "gateway output"]),
          )
          expect(outputs["relay standard error"]).toBe("/dev/null")
          expect(holding(outputs, sessionKey.privateKey)).toEqual(
            race === "planted" ? ["relay environment"] : [],
          )
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
      front.close()
      await gateway?.stop()
      await issuer.stop(true)
      await github.stop(true)
      await upstream.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
