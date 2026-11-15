import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { runStoreMigrations } from "../../src/store/migrations"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { makeSandboxStore } from "../../src/sandbox/store"
import { capabilityDigest, makeCapabilityStore } from "../../src/capability-gateway/store"
import { randomBytes } from "node:crypto"
import { runGatewayMigrations } from "../../src/capability-gateway/migrations"
import { liveGrants } from "../../src/capability-gateway/control-client"

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
    if (yield* store.sessionBound("run", 78, 1))
      yield* (yield* makeSandboxStore).bindSession("run", 78, 1)
    // The session answer names when to renew; production picks 10 to 12 minutes in.
    return { binding: { runId, channel }, token, expiresAt, renewAt: now + 600000 }
  })
