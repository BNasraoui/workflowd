import { expect, test, spyOn } from "bun:test"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import * as filesystem from "node:fs/promises"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Fiber } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Octokit } from "@octokit/rest"
import { serveBootstrap } from "../../deploy/sandbox/bootstrap.mjs"
import { disposableSsh } from "./fixtures/ssh.mjs"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { makeCapabilityTransport } from "../../src/sandbox/capability-transport"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeSandboxStore } from "../../src/sandbox/store"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { runStoreMigrations } from "../../src/store/migrations"

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
}
for (const race of [
  false,
  true,
  "revoke-failure",
  "release-failure",
  "filesystem",
  ...Object.keys(hostileClaims),
  "key",
  "peer",
  "host-key",
])
  test(`signed private SSH/HTTP2/noscope/SQLite acquisition; bind race=${race}`, async () => {
    const node = fixtureExecutable("node")
    const ssh = await disposableSsh(
      (root) => `${node} ${resolve("test/sandbox/fixtures/capability-job.mjs")} attach ${root}`,
      "100.64.0.1",
      22,
    )
    const root = await mkdtemp(join(tmpdir(), "wfd-private-job-"))
    await writeFile(
      join(root, "foreign-host"),
      "100.64.0.1 " + (await readFile(join(ssh.root, "client.pub"), "utf8")),
      { mode: 0o600 },
    )
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
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const jwks = {
      keys: [
        { ...keys.publicKey.export({ format: "jwk" }), kid: "fixture", use: "sig", alg: "RS256" },
      ],
    }
    const native = '{ "model" : "fixture-model", "stream": true, "messages": [] }'
    const response = "event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n"
    let upstreamEffects = 0
    let publicArtifacts = 0
    let activated = 0
    let beforeHandoff = async () => {}
    let attempt = "2"
    let relay: ReturnType<typeof Bun.spawn> | undefined
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer fixture-provider-access")
        expect(request.headers.get("x-api-key")).toBeNull()
        expect(await request.text()).toBe(native)
        upstreamEffects++
        return new Response(response, { headers: { "content-type": "text/event-stream" } })
      },
    })
    const github = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/jwks") return Response.json(jwks)
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
    const bootstrap = () =>
      serveBootstrap({
        directory: ssh.root,
        identity: {
          peerId: race === "peer" && attempt === "2" ? "foreign-peer" : "fixture-peer",
          agentImage: policy.agentImage,
          workflowSha: policy.workflowSha,
        },
        issue: async (audience) => {
          const ref = "refs/heads/workflowd/leases/lease"
          const now = Math.floor(Date.now() / 1000)
          const payload = {
            iss: "https://token.actions.githubusercontent.com",
            aud: audience,
            sub: `repo:fixture@34/repo@12:ref:${ref}`,
            jti: `fixture-jti-${attempt}`,
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
            run_attempt: attempt,
            event_name: "push",
            runner_environment: "github-hosted",
          }
          const hostile =
            typeof race === "string" && (race in hostileClaims || race === "key") && attempt === "2"
          const input = [
            {
              alg: "RS256",
              typ: "JWT",
              kid: hostile && race === "key" ? "untrusted-key" : "fixture",
            },
            hostile ? { ...payload, run_attempt: "1", ...hostileClaims[String(race)] } : payload,
          ]
            .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
            .join(".")
          return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`
        },
        activate: async (grant) => {
          activated++
          const child = Bun.spawn(
            [node, resolve("test/sandbox/fixtures/capability-job.mjs"), "runner", ssh.root],
            {
              env: { PATH: "/usr/bin:/bin", HOME: root },
              stdin: new Blob([JSON.stringify(grant)]),
              stdout: "pipe",
              stderr: "ignore",
            },
          )
          relay = child
          const ready = await child.stdout.getReader().read()
          expect(ready.done).toBe(false)
          expect(Buffer.from(ready.value ?? []).toString()).toBe("ready\n")
          await beforeHandoff()
        },
      })
    let helper = await bootstrap()
    let completed = helper.completed.then(
      () => "accepted",
      () => "refused",
    )
    try {
      await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
      await writeFile(
        join(root, "app.pem"),
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 },
      )
      await writeFile(
        join(root, "noscope/providers/run-capability.toml"),
        `contract_version = 1\n[commands]\nmint = "${process.execPath} ${resolve("src/capability-gateway/noscope-provider.ts")} run {ttl}"\n`,
        { mode: 0o600 },
      )
      await writeFile(
        join(root, "access.mjs"),
        'process.stdout.write(JSON.stringify({token:"fixture-provider-access",token_id:"fixture",expires_at:new Date(Date.now()+120000).toISOString()}))',
      )
      await writeFile(
        join(root, "noscope/providers/provider-access.toml"),
        `contract_version = 1\n[commands]\nmint = "${node} ${join(root, "access.mjs")}"\n`,
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
          const gateway = yield* makeCapabilityGateway(
            {
              noscope: { binary: fixtureExecutable("noscope"), configHome: root },
              providerId: "anthropic",
              credentialRole: "fixture",
              maxStreams: 8,
              maxStreamsPerRun: 2,
            },
            (url, input) => {
              expect(url).toBe("https://api.anthropic.com/v1/messages")
              return fetch(new URL("v1/messages", upstream.url), input)
            },
          )
          const sshArguments = () => [
            ...ssh.args.map((arg) =>
              race === "host-key" && attempt === "2" && arg.startsWith("UserKnownHostsFile=")
                ? `UserKnownHostsFile=${join(root, "foreign-host")}`
                : arg,
            ),
            "exec /usr/local/bin/container-use stdio",
          ]
          const transport = yield* makeCapabilityTransport(gateway, node, root, sshArguments)
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
            async (args) => {
              expect(args).toEqual(["/usr/bin/tailscale", "status", "--json"])
              return JSON.stringify({
                Peer: {
                  fixture: {
                    ID: "fixture-peer",
                    HostName: "lease-78-1",
                    Online: true,
                    TailscaleIPs: ["100.64.0.1"],
                    Tags: ["tag:agent-runner"],
                    sshHostKeys: [ssh.key],
                  },
                },
              })
            },
            {
              native: { gateway, transport },
              publicationContract: { reference: "fixture-only:worktree", receipt: "fixed-v1" },
              sshArguments,
              keys: () => fetch(new URL("jwks", github.url)).then((response) => response.json()),
            },
          )
          if (race === "filesystem") {
            const original = filesystem.writeFile
            const entered = Promise.withResolvers<void>()
            const proceed = Promise.withResolvers<void>()
            let block = false
            const fault = spyOn(filesystem, "writeFile").mockImplementation(
              async (path, data, options) => {
                if (
                  typeof path === "string" &&
                  path.includes("/bootstrap-") &&
                  path.endsWith("/known_hosts")
                ) {
                  if (block) {
                    entered.resolve()
                    await proceed.promise
                  } else await mkdir(path)
                }
                return original(path, data, options)
              },
            )
            try {
              expect((yield* Effect.exit(leases.acquire("run")))._tag).toBe("Failure")
              expect(
                (yield* Effect.promise(() => readdir(root))).filter((name) =>
                  name.startsWith("bootstrap-"),
                ),
              ).toEqual([])
              block = true
              const pending = yield* leases.acquire("run").pipe(Effect.forkScoped)
              yield* Effect.promise(() => entered.promise)
              const interrupted = Effect.runPromise(Fiber.interrupt(pending))
              proceed.resolve()
              yield* Effect.promise(() => interrupted)
              expect(
                (yield* Effect.promise(() => readdir(root))).filter((name) =>
                  name.startsWith("bootstrap-"),
                ),
              ).toEqual([])
              const retained = yield* sql`SELECT owner FROM sandbox_lease_operations`
              expect(retained[0]?.owner).not.toBeNull()
              // Existing interrupted-acquisition custody must age out before
              // trusted ref reconciliation can perform the positive retry.
              yield* sql`UPDATE sandbox_lease_operations SET expires_at=0`
            } finally {
              proceed.resolve()
              fault.mockRestore()
            }
          }
          const refused = yield* Effect.result(leases.acquire("run"))
          expect(refused._tag).toBe("Failure")
          if (race === "host-key") helper.close()
          expect(yield* Effect.promise(() => completed)).toBe("refused")
          expect(activated).toBe(0)
          expect(upstreamEffects).toBe(0)
          helper.close()
          attempt = "1"
          helper = yield* Effect.promise(bootstrap)
          completed = helper.completed.then(
            () => "accepted",
            () => "refused",
          )
          if (race === true || race === "revoke-failure") {
            beforeHandoff = () =>
              Effect.runPromise(
                Effect.gen(function* () {
                  yield* sql`UPDATE sandbox_lease_operations SET owner='fixture-new-owner',generation=generation+1`
                  if (race === "revoke-failure")
                    yield* sql`CREATE TRIGGER fixture_revoke_failure BEFORE UPDATE OF revoked ON capability_bindings BEGIN SELECT RAISE(FAIL,'fixture revoke failure'); END`
                }),
              )
            expect((yield* Effect.exit(leases.acquire("run")))._tag).toBe("Failure")
            expect(activated).toBe(1)
            expect(upstreamEffects).toBe(0)
            const remaining = yield* Effect.promise(() => readdir(root))
            expect(
              remaining.filter(
                (name) => name.startsWith("gateway-") || name.startsWith("bootstrap-"),
              ),
            ).toEqual([])
            if (!relay) throw new Error("relay missing")
            const child = relay
            yield* Effect.promise(() => child.exited)
            return
          }
          const lease = yield* leases.acquire("run")
          expect(lease.state).toBe("ready")
          expect(yield* Effect.promise(() => completed)).toBe("accepted")
          expect(activated).toBe(1)
          if (race === "release-failure") {
            yield* sql`CREATE TRIGGER fixture_revoke_failure BEFORE UPDATE OF revoked ON capability_bindings BEGIN SELECT RAISE(FAIL,'fixture revoke failure'); END`
            expect((yield* Effect.exit(leases.release("run")))._tag).toBe("Failure")
            const remaining = yield* Effect.promise(() => readdir(root))
            expect(
              remaining.filter(
                (name) => name.startsWith("gateway-") || name.startsWith("bootstrap-"),
              ),
            ).toEqual([])
            expect((yield* store.read("run"))?.state).not.toBe("released")
            yield* sql`DROP TRIGGER fixture_revoke_failure`
            return
          }
          const request = (sentinel: string) =>
            fetch("http://capability.invalid/v1/messages", {
              unix: join(ssh.root, "gateway.sock"),
              method: "POST",
              body: native,
              headers: {
                authorization: `Bearer ${sentinel}`,
                "content-type": "application/json",
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "oauth-2025-04-20",
              },
            })
          expect((yield* Effect.promise(() => request("foreign"))).status).toBe(403)
          expect(upstreamEffects).toBe(0)
          const accepted = yield* Effect.promise(() => request("workflowd-local"))
          expect(accepted.status).toBe(200)
          expect(yield* Effect.promise(() => accepted.text())).toBe(response)
          expect(upstreamEffects).toBe(1)
          expect(publicArtifacts).toBe(0)
          yield* gateway.revoke("run")
          expect((yield* Effect.promise(() => request("workflowd-local"))).status).toBe(403)
          expect(upstreamEffects).toBe(1)
        }).pipe(
          Effect.provide(AgentRunStoreLive),
          Effect.provide(SqliteClient.layer({ filename: join(root, "store.sqlite") })),
          Effect.scoped,
        ),
      )
      expect(
        (await readdir(root)).filter(
          (name) => name.startsWith("gateway-") || name.startsWith("bootstrap-"),
        ),
      ).toEqual([])
    } finally {
      helper.close()
      relay?.kill("SIGKILL")
      await relay?.exited
      await github.stop(true)
      await upstream.stop(true)
      await ssh.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
