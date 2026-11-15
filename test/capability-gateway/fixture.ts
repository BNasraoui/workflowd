import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { runStoreMigrations } from "../../src/store/migrations"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { makeSandboxStore } from "../../src/sandbox/store"
import { capabilityDigest, makeCapabilityStore } from "../../src/capability-gateway/store"
import { randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

/**
 * The noscope providers of a gateway test under `root`: run tokens from the real run-capability
 * provider, and a fixed provider credential that lives `accessMs`.
 */
export async function writeNoscopeProviders(root: string, accessMs: number) {
  await mkdir(join(root, "noscope/providers"), { recursive: true, mode: 0o700 })
  await writeFile(
    join(root, "noscope/providers/run-capability.toml"),
    `contract_version = 1\n[commands]\nmint = "${process.execPath} ${resolve("src/capability-gateway/noscope-provider.ts")} run {ttl}"\n`,
    { mode: 0o600 },
  )
  await writeFile(
    join(root, "access.mjs"),
    `process.stdout.write(JSON.stringify({token:"fixture-access",token_id:"fixture",expires_at:new Date(Date.now()+${accessMs}).toISOString()}))`,
  )
  await writeFile(
    join(root, "noscope/providers/provider-access.toml"),
    `contract_version = 1\n[commands]\nmint = "${process.execPath} ${join(root, "access.mjs")}"\n`,
    { mode: 0o600 },
  )
}

export const seedCapabilityRun = (
  now: number,
  native = false,
  selection?: { modelId: string; sourceSha: string },
) =>
  Effect.gen(function* () {
    yield* runStoreMigrations
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
    return { sql, runs, leases }
  })

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
    )
    yield* (yield* makeSandboxStore).bindSession("run", 78, 1)
    // The session answer names when to renew; production picks 10 to 12 minutes in.
    return { binding: { runId, channel }, token, expiresAt, renewAt: now + 600000 }
  })
