// Reviewed tooling only. The canary candidate deliberately cannot mint a write token.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = join(process.env.RUNNER_TEMP, "workflowd-publish")
const receipt = join(root, "validated.json")

async function bytes(response, maximum) {
  assert.ok(response.ok, "GitHub request failed")
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    assert.ok(size <= maximum, "GitHub response exceeded bound")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function validate() {
  const repository = process.env.GITHUB_REPOSITORY
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  const run = Number(process.env.GITHUB_RUN_ID)
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT)
  const actor = Number(process.env.GATE_ACTOR_ID)
  assert.ok(Number.isSafeInteger(run) && run > 0 && attempt === 1 && actor > 0)
  const endpoint = `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${repository}`
  const request = (path) => fetch(endpoint + path, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30000),
  })
  const json = async (path) => JSON.parse((await bytes(await request(path), 1048576)).toString())
  const reviews = await json(`/actions/runs/${run}/approvals`)
  assert.ok(Array.isArray(reviews) && reviews.length <= 100)
  const matches = reviews.filter(review => review.state === "approved" && review.user?.id === actor &&
    review.user?.type === "Bot" && review.environments?.some(env => env.name === "agent-publish"))
  assert.equal(matches.length, 1, "Missing or ambiguous gate approval")
  const binding = JSON.parse(matches[0].comment)
  assert.deepEqual(Object.keys(binding).sort(), ["artifact", "attempt", "digest", "manifest", "result", "run", "source", "v"])
  assert.equal(binding.v, 1)
  assert.equal(binding.run, run)
  assert.equal(binding.attempt, attempt)
  assert.ok(Number.isSafeInteger(binding.artifact) && binding.artifact > 0)
  assert.match(binding.digest, /^sha256:[a-f0-9]{64}$/)
  assert.match(binding.manifest, /^[a-f0-9]{64}$/)
  const artifact = await json(`/actions/artifacts/${binding.artifact}`)
  assert.equal(artifact.id, binding.artifact)
  assert.equal(artifact.name, `sandbox-result-${run}-${attempt}`)
  assert.equal(artifact.digest, binding.digest)
  assert.equal(artifact.expired, false)
  assert.equal(artifact.workflow_run.id, run)
  assert.equal(artifact.workflow_run.repository_id, Number(process.env.GITHUB_REPOSITORY_ID))
  assert.equal(artifact.workflow_run.head_repository_id, Number(process.env.GITHUB_REPOSITORY_ID))
  assert.equal(artifact.workflow_run.head_sha, process.env.GITHUB_SHA)
  assert.equal(artifact.workflow_run.head_branch, process.env.GITHUB_REF_NAME)
  assert.ok(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 16 * 1048576)
  await mkdir(root, { mode: 0o700 })
  const archive = join(root, "result.zip")
  await writeFile(archive, await bytes(await request(`/actions/artifacts/${binding.artifact}/zip`), 16 * 1048576), { mode: 0o600 })
  const checked = spawnSync("python3", [join(dirname(fileURLToPath(import.meta.url)), "result.py"), "validate", archive,
    `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repository}.git`, join(root, "validated")], {
    input: JSON.stringify(binding), timeout: 180000, maxBuffer: 65536,
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
  })
  assert.equal(checked.status, 0, "Bundle validation failed")
  const metadata = JSON.parse(checked.stdout.toString())
  assert.equal(metadata.resultSha, binding.result)
  await writeFile(receipt, JSON.stringify({ binding, metadata }), { mode: 0o600 })
  console.log("workflowd.publish validated immutable artifact and approval")
}

async function canary() {
  const { binding } = JSON.parse(await readFile(receipt, "utf8"))
  assert.equal(binding.run, Number(process.env.GITHUB_RUN_ID))
  assert.equal(binding.attempt, Number(process.env.GITHUB_RUN_ATTEMPT))
  assert.ok(process.env.PUBLISH_PROBE_CANARY, "Environment canary absent")
  assert.equal(process.env.GHETTIMONSTER_APP_ID, "5232172")
  assert.ok(!process.env.GHETTIMONSTER_PRIVATE_KEY, "Publish key must remain absent for this probe")
  console.log("workflowd.publish canary passed; no write token minted")
}

try {
  if (process.argv[2] === "validate") await validate()
  else if (process.argv[2] === "canary") await canary()
  else throw new Error("Unknown operation")
} catch {
  // Never include server bodies, environment values, agent metadata or process output.
  console.error("Protected publication probe failed closed")
  process.exitCode = 1
}
