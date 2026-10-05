#!/usr/bin/env bun
// Opt-in real lease probe. Operator trust settings are read, never provisioned.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { parseSandboxRepositories } from "../../src/sandbox/config.ts"
import { makeSandboxGithub } from "../../src/sandbox/github.ts"
import { makeSandboxLeaseService } from "../../src/sandbox/lease.ts"
import { makeSandboxStore } from "../../src/sandbox/store.ts"
import { runStoreMigrations } from "../../src/store/migrations.ts"

let stage = "operator policy"
const evidence = { started: new Date().toISOString(), observations: [] }
let output
export function probeLease(leases, store, runId) {
  const acquire = Effect.gen(function* () {
    stage = "live lease acquisition"
    const deadline = Date.now() + 300000
    let row
    do {
      row = yield* leases.acquire(runId)
      if (row.state === "ready") break
      yield* Effect.sleep("2 seconds")
    } while (Date.now() < deadline)
    assert.equal(row.state, "ready", "Lease did not become ready within five minutes")
    evidence.observations.push({
      state: row.state,
      actionsRunId: row.actions_run_id,
      attempt: row.actions_attempt,
      peerId: row.peer_id,
      sourceSha: row.source_sha,
      workflowSha: row.policy.workflowSha,
    })
    return row
  })
  const release = Effect.gen(function* () {
    const previousStage = stage
    stage = "confirmed lease release"
    const deadline = Date.now() + 300000
    let row
    do {
      yield* leases.release(runId)
      row = yield* store.read(runId)
      if (row?.state === "released") break
      yield* Effect.sleep("2 seconds")
    } while (Date.now() < deadline)
    assert.equal(
      row?.state,
      "released",
      "Release unconfirmed; preserve the SQLite custody record and reconcile",
    )
    evidence.observations.push({ state: row.state })
    stage = previousStage
  })
  return acquire.pipe(Effect.ensuring(release))
}

async function probe() {
  assert.ok(
    ["--probe-lease", "--check-policy"].includes(process.argv[2]),
    "Expected --probe-lease or --check-policy",
  )
  const value = process.env.WORKFLOWD_AGENT_RUN_SANDBOX_REPOSITORIES
  assert.ok(value, "WORKFLOWD_AGENT_RUN_SANDBOX_REPOSITORIES is required")
  const policies = parseSandboxRepositories(value)
  assert.equal(policies.length, 1, "Probe one repository at a time")
  const [policy] = policies
  stage = "operator trust evidence"
  assert.ok(
    process.env.EVIDENCE_TAILSCALE_TRUST_FILE,
    "EVIDENCE_TAILSCALE_TRUST_FILE is required: provide the operator's non-secret trust configuration",
  )
  const trust = JSON.parse(await readFile(process.env.EVIDENCE_TAILSCALE_TRUST_FILE, "utf8"))
  assert.equal(trust.clientId, policy.tailscaleClientId)
  assert.equal(trust.audience, policy.tailscaleAudience)
  assert.equal(trust.issuer, "https://token.actions.githubusercontent.com")
  assert.equal(
    trust.subject,
    `repo:${policy.repository.split("/")[0]}@${trust.repositoryOwnerId}/${policy.repository.split("/")[1]}@${policy.repositoryId}:ref:refs/heads/workflowd/leases/*`,
  )
  // The operator configured issuer/subject/audience only. Workflow, actor,
  // run and attempt are independently checked by the application at acquisition.
  assert.deepEqual(trust.customClaims, {}, "Operator record specifies no custom-claim restrictions")
  assert.equal(trust.refRestriction.pattern, "workflowd/leases/**")
  assert.deepEqual(trust.refRestriction.operations, [
    "create",
    "update",
    "delete",
    "non_fast_forward",
  ])
  assert.ok(Number.isSafeInteger(trust.refRestriction.ruleset) && trust.refRestriction.ruleset > 0)
  assert.ok(
    Number.isSafeInteger(trust.refRestriction.soleBypassApp) &&
      trust.refRestriction.soleBypassApp > 0,
  )
  assert.equal(trust.runnerInitiatedTailnetConnections, "deny")
  assert.equal(trust.mintInitiatedSsh, "allow")
  // This is operator-supplied configuration evidence. Only the live exchange
  // below establishes that this workflow can join; phase 4 proves denials.
  evidence.policy = policy
  evidence.trust = trust
  if (process.argv[2] === "--check-policy") {
    console.log("Sandbox operator policy is compatible; enforcement remains unverified")
    return
  }
  stage = "App credentials"
  const config = join(homedir(), ".config/workflowd")
  const env = await readFile(join(config, "env"), "utf8")
  const appId = Number(env.match(/^GITHUB_APP_ID=["']?(\d+)/m)?.[1])
  assert.ok(appId > 0, "App ID unavailable")
  assert.equal(appId, trust.refRestriction.soleBypassApp)
  output =
    process.env.EVIDENCE_SANDBOX_ROOT ??
    join(homedir(), ".local/state", `workflowd-sandbox-probe-${randomUUID()}`)
  await mkdir(output, { recursive: true, mode: 0o700 })
  const runId = `probe-${randomUUID()}`
  evidence.runId = runId
  const layer = SqliteClient.layer({ filename: join(output, "leases.sqlite") })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* runStoreMigrations
      const store = yield* makeSandboxStore
      const github = yield* makeSandboxGithub({
        appId,
        privateKeyPath: join(config, "github-app.pem"),
      })
      const leases = yield* makeSandboxLeaseService(github, join(output, "control"))
      stage = "published operator-pinned workflow"
      yield* github.verifyWorkflow(policy)
      stage = "source SHA resolution"
      const sourceSha = yield* github.resolveSource(
        policy,
        process.env.EVIDENCE_SANDBOX_SOURCE_REF ?? "main",
      )
      yield* store.request({ runId, leaseId: runId, policy, sourceSha, now: Date.now() })
      const row = yield* probeLease(leases, store, runId)
      evidence.runUrl = `https://github.com/${policy.repository}/actions/runs/${row.actions_run_id}`
    }).pipe(Effect.provide(layer)),
  )
  evidence.result = "passed"
  console.log(
    JSON.stringify({ result: evidence.result, runUrl: evidence.runUrl, evidence: output }),
  )
}
if (import.meta.main) {
  try {
    await probe()
  } catch (error) {
    evidence.result = "stopped"
    evidence.stage = stage
    // Only prerequisite assertions are printed. SDK/process errors may carry secrets.
    const detail =
      stage.startsWith("operator") && error instanceof Error ? `: ${error.message}` : ""
    console.error(`Sandbox probe stopped at ${stage}${detail}`)
    process.exitCode = 1
  } finally {
    if (output !== undefined)
      await writeFile(join(output, "probe.json"), JSON.stringify(evidence, null, 2) + "\n", {
        mode: 0o600,
      })
  }
}
