import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { runStoreMigrations } from "../../src/store/migrations"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { makeSandboxStore } from "../../src/sandbox/store"
import { capabilityDigest, makeCapabilityStore } from "../../src/capability-gateway/store"
import { randomBytes } from "node:crypto"
import { runGatewayMigrations } from "../../src/capability-gateway/migrations"
import { liveGrants } from "../../src/sandbox/capability-control"
import { mkdir, writeFile } from "node:fs/promises"
import { sessionKeyPair, signRenewal } from "../../deploy/sandbox/renewal.mjs"
import { join, resolve } from "node:path"

/** The mint command of the real run-capability provider. */
export const runCapabilityMint = [
  process.execPath,
  resolve("src/capability-gateway/noscope-provider.ts"),
  "run",
  "{ttl}",
] as const

/**
 * Writes the noscope provider `name` under `root`, whose mint runs `mint`: its words joined by
 * spaces. Each provider file of a gateway test is written here.
 */
export async function writeNoscopeProvider(
  root: string,
  name: "run-capability" | "provider-access",
  mint: ReadonlyArray<string>,
) {
  await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
  await writeFile(
    join(root, `noscope/providers/${name}.toml`),
    `contract_version = 1\n[commands]\nmint = "${mint.join(" ")}"\n`,
    { mode: 0o600 },
  )
}

/**
 * The noscope providers of a gateway test under `root`: run tokens from `run` (the real
 * run-capability provider unless named), and a fixed provider credential that lives `accessMs`.
 * The credential's script appends a line to `access-mints` at each mint.
 */
export async function writeNoscopeProviders(
  root: string,
  accessMs: number,
  run: ReadonlyArray<string> = runCapabilityMint,
) {
  await writeNoscopeProvider(root, "run-capability", run)
  await writeFile(
    join(root, "access.mjs"),
    `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(join(root, "access-mints"))},'x');process.stdout.write(JSON.stringify({token:"fixture-access",token_id:"fixture",expires_at:new Date(Date.now()+${accessMs}).toISOString()}))`,
  )
  await writeNoscopeProvider(root, "provider-access", [process.execPath, join(root, "access.mjs")])
}

/**
 * workflowd grants each of its live native runs to the gateway store, as its control client does
 * on the socket. In-process tests keep both stores in one database for brevity; the processes
 * never do (control.e2e.test.ts).
 */
export const grantLiveRuns = (now: number) =>
  Effect.gen(function* () {
    const live = yield* liveGrants(null, now)
    return yield* (yield* makeCapabilityStore).reconcileGrants(live)
  })

/**
 * The fixture run and its lease in workflowd's store. With `gatewayStore` (the default) the same
 * database also gets the gateway's tables, and a native run is granted to them.
 */
export const seedCapabilityRun = (
  now: number,
  native = false,
  selection?: { modelId: string; sourceSha: string },
  { gatewayStore = true } = {},
) =>
  Effect.gen(function* () {
    yield* runStoreMigrations
    if (gatewayStore) yield* runGatewayMigrations
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO directory_local_identity(singleton,host_id) VALUES(1,'fixture-controller')`
    const runs = yield* AgentRunStore
    yield* runs.create({
      runId: "run",
      route: "fixture",
      providerId: "anthropic",
      modelId: selection?.modelId ?? "fixture-model",
      executorKind: "claude",
      agent: "sandbox",
      repository: "fixture",
      directory: "/fixture",
      prompt: "fixture",
      promptSha256: "c".repeat(64),
      parentSessionId: null,
      resumePrompt: null,
      maxAttempts: 1,
      createdAt: new Date(now),
    })
    yield* runs.claimSpawn({ runId: "run", now: new Date(now) })
    const leases = yield* makeSandboxStore
    yield* leases.request({
      runId: "run",
      leaseId: "lease",
      policy: {
        ...(native
          ? { privateBootstrap: { mode: "actions-native" as const, repositoryOwnerId: 1 } }
          : {}),
        alias: "fixture",
        repository: "fixture/repo",
        repositoryId: 12,
        installationId: 1,
        workflowSha: "a".repeat(40),
        appActorId: 56,
        agentImage: `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"b".repeat(64)}`,
        tailscaleClientId: "fixture",
        tailscaleAudience: "fixture",
      },
      sourceSha: selection?.sourceSha ?? "d".repeat(40),
      now,
    })
    yield* leases.beginStart("run")
    yield* leases.recordRun("run", 78, 1)
    if (gatewayStore) yield* grantLiveRuns(now)
    return { sql, runs, leases }
  })

/** The session key of each session that `bindRunSession` opens. */
export const fixtureSessionKey = sessionKeyPair()

/** The relay's signature of the renewal of the run token whose digest is `predecessor`. */
export const renewalSignature = (binding: { readonly channel: string }, predecessor: string) =>
  signRenewal(fixtureSessionKey.privateKey, binding.channel, predecessor)

/**
 * Binds the run of `seedCapabilityRun(now, true)` as production does: the lease's challenge, the
 * runner's session for it (its proof already verified, named by `jti`), then the ready lease.
 * The run token is the caller's digest, or a fresh token whose digest the store keeps.
 */
export const bindRunSession = (
  now: number,
  options: { readonly jti?: string; readonly digest?: string; readonly expiresAt?: number } = {},
) =>
  Effect.gen(function* () {
    const store = yield* makeCapabilityStore
    const token = randomBytes(32).toString("base64url")
    const expiresAt = options.expiresAt ?? now + 900000
    const challenge = yield* store.leaseChallenge("lease", now)
    const { runId, channel } = yield* store.bindSession(
      { ...challenge, runId: "run", recipientId: "managed:fixture-controller:run" },
      options.jti ?? "fixture-jti",
      options.digest ?? capabilityDigest(token),
      expiresAt,
      now,
      now + 610000,
      fixtureSessionKey.publicKey,
    )
    if (yield* store.sessionBound("run", 78, 1))
      yield* (yield* makeSandboxStore).bindSession("run", 78, 1)
    // The session answer names when to renew; production picks 10 to 12 minutes in.
    return { binding: { runId, channel }, token, expiresAt, renewAt: now + 600000 }
  })
