#!/usr/bin/env bun
// Explicit opt-in: reads only owner-authorized credentials; never changes App settings or reruns CI.
import assert from "node:assert/strict"
import { createHmac, sign } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { resolve, join } from "node:path"
import { spawn } from "node:child_process"

const repo = resolve(import.meta.dirname, "../..")
mkdirSync(join(repo, ".scratch"), { recursive: true })
const root = mkdtempSync(join(repo, ".scratch/app-evidence-"))
chmodSync(root, 0o700)
const repository = "BNasraoui/workflowd"
let stage = "credential copy"
try {
  const source = join(homedir(), ".config/workflowd")
  const id = readFileSync(join(source, "env"), "utf8")
    .split("\n")
    .map(
      (line) =>
        line.trimStart().match(/^(?:export[ \t]+)?GITHUB_APP_ID[ \t]*=[ \t]*["']?(\d+)/)?.[1],
    )
    .find((value) => value !== undefined)
  assert.ok(id, "App ID unavailable")
  writeFileSync(join(root, "app-id"), id, { mode: 0o600 })
  for (const file of ["github-app.pem", "github-webhook-secret"]) {
    copyFileSync(join(source, file), join(root, file))
    chmodSync(join(root, file), 0o600)
  }
  const secret = readFileSync(join(root, "github-webhook-secret"), "utf8").trim()
  const now = Math.floor(Date.now() / 1000)
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const input =
    b64({ alg: "RS256", typ: "JWT" }) + "." + b64({ iat: now - 60, exp: now + 540, iss: id })
  const jwt =
    input +
    "." +
    sign("RSA-SHA256", Buffer.from(input), readFileSync(join(root, "github-app.pem"))).toString(
      "base64url",
    )
  async function api(path, token = jwt, method = "GET") {
    stage = method + " " + path
    const response = await fetch("https://api.github.com" + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    })
    assert.ok(response.ok, `GitHub HTTP ${response.status}`)
    // Delivery IDs exceed Number.MAX_SAFE_INTEGER. Preserve them for detail requests.
    return JSON.parse((await response.text()).replace(/("id"\s*:\s*)(\d{16,})/g, '$1"$2"'))
  }
  const app = await api("/app")
  const installations = await api("/app/installations")
  assert.equal(installations.length, 1, "Expected one installation")
  const installation = installations[0]
  assert.equal(installation.suspended_at, null, "Installation suspended")
  for (const record of [app, installation]) {
    assert.ok(["read", "write"].includes(record.permissions.actions), "Actions permission missing")
    for (const event of ["workflow_run", "check_suite"])
      assert.ok(record.events.includes(event), `Missing ${event}`)
  }
  const token = await api(`/app/installations/${installation.id}/access_tokens`, jwt, "POST")
  const inventory = await api("/installation/repositories", token.token)
  assert.equal(inventory.total_count, 1)
  assert.deepEqual(
    inventory.repositories.map((r) => r.full_name),
    [repository],
  )
  const fixtures = { repository, workflows: ["CI"] }
  await Promise.all(
    [
      ["success", process.env.EVIDENCE_SUCCESS_DELIVERY],
      ["failure", process.env.EVIDENCE_FAILURE_DELIVERY],
    ].map(async ([name, deliveryId]) => {
      assert.match(deliveryId ?? "", /^\d+$/, "Set both EVIDENCE_*_DELIVERY IDs")
      const delivery = await api(`/app/hook/deliveries/${deliveryId}`)
      assert.equal(delivery.event, "workflow_run")
      assert.equal(delivery.action, "completed")
      const payload = delivery.request.payload
      assert.equal(payload.repository.full_name, repository)
      assert.equal(payload.installation.id, installation.id)
      assert.equal(payload.workflow_run.conclusion, name)
      const body = JSON.stringify(payload)
      const signature = delivery.request.headers["X-Hub-Signature-256"]
      assert.equal(
        "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
        signature,
        "Cannot reconstruct original signed bytes",
      )
      const run = payload.workflow_run
      const jobs = await api(
        `/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
        token.token,
      )
      fixtures[name] = {
        sha: run.head_sha,
        runId: run.id,
        attempt: run.run_attempt,
        failingJobs: jobs.jobs
          .filter((job) => !["success", "skipped", "neutral"].includes(job.conclusion))
          .map((job) => job.name),
        body,
        signature,
        deliveryId: delivery.guid,
      }
      console.log(
        JSON.stringify({
          kind: "verified-original-delivery",
          name,
          runId: run.id,
          attempt: run.run_attempt,
          deliveryId: delivery.guid,
          failingJobs: fixtures[name].failingJobs,
        }),
      )
    }),
  )
  writeFileSync(join(root, "fixtures.json"), JSON.stringify(fixtures), { mode: 0o600 })
  stage = "isolated harness"
  const child = spawn(process.execPath, [join(repo, "scripts/evidence/agent-inboxes.mjs")], {
    cwd: repo,
    stdio: "inherit",
    env: {
      ...process.env,
      EVIDENCE_GITHUB_APP_ID: id,
      EVIDENCE_GITHUB_INSTALLATION_ID: String(installation.id),
      EVIDENCE_GITHUB_KEY: join(root, "github-app.pem"),
      EVIDENCE_GITHUB_WEBHOOK_SECRET_FILE: join(root, "github-webhook-secret"),
      EVIDENCE_CI_FIXTURES: join(root, "fixtures.json"),
    },
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
} catch {
  // Never serialize SDK errors or raw responses carrying authorization headers.
  console.error(`Evidence stopped at ${stage}; no credentials logged.`)
  process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
  console.log("App scratch configuration and delivery signatures removed.")
}
