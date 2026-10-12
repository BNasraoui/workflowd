// Reviewed tooling only. No agent code, configuration or command output is executed or logged.
import { safePublication } from "./publication.mjs"
import assert from "node:assert/strict"
import { setTimeout } from "node:timers/promises"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = join(process.env.RUNNER_TEMP, "workflowd-publish")
const validated = join(root, "validated.json")
const receipt = join(root, "receipt.json")
const repository = process.env.GITHUB_REPOSITORY
const api = process.env.GITHUB_API_URL || "https://api.github.com"
// Only fixed operation labels and numeric HTTP statuses may reach diagnostics.
// Assertion messages can contain agent text, and HTTP errors can contain credentials.
let failureCause = "publication validation failed"
let publicationState

async function bytes(response, maximum) {
  if (!response.ok) failureCause += ` (HTTP ${response.status})`
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

function publicationText(value, message = false) {
  assert.equal(typeof value, "string")
  assert.ok(value.length > 0 && safePublication(value))
  assert.ok(message ? Buffer.byteLength(value, "utf8") <= 10240 : [...value].length <= 200)
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(message ? value.replaceAll("\n", "") : value))
  assert.ok(message || !/[\u2028\u2029]/u.test(value))
}

function configuredCoAuthor() {
  const value = process.env.PUBLISH_CO_AUTHOR
  assert.equal(typeof value, "string")
  assert.ok(value.isWellFormed() && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value))
  assert.match(value, /^[^\s<>][^<>]* <[^\s<>@]+@[^\s<>@]+>$/u)
  return value
}

function publicationCommitMessage(message) {
  const coAuthor = configuredCoAuthor()
  const body = message.split("\n").filter((line) =>
    !/^\s*co-authored-by\s*:/i.test(line),
  ).join("\n").trimEnd()
  return `${body}\n\nCo-authored-by: ${coAuthor}`
}

function publicationBody(state) {
  return `${state.marker}\n\n${state.metadata.body}`
}

function validateBody(value) {
  assert.equal(typeof value, "string")
  assert.ok(value.trim().length > 0 && value.isWellFormed())
  assert.ok(Buffer.byteLength(value, "utf8") <= 32768)
  assert.ok(safePublication(value))
}

function verifyCommit(commit, state) {
  assert.match(commit.sha, /^[a-f0-9]{40}$/)
  assert.equal(commit.tree.sha, state.binding.tree)
  assert.deepEqual(commit.parents.map(parent => parent.sha), [state.binding.source])
  assert.equal(commit.message, publicationCommitMessage(state.metadata.commitMessage))
  assert.equal(commit.verification.verified, true)
}

async function validate() {
  configuredCoAuthor()
  assert.equal(process.env.GHETTIMONSTER_APP_ID, "5232172")
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
  failureCause = "approval validation failed"
  const reviews = await json(`/actions/runs/${run}/approvals`)
  assert.ok(Array.isArray(reviews) && reviews.length <= 100)
  const matches = reviews.filter(review => review.state === "approved" && review.user?.id === actor &&
    review.user?.type === "Bot" && review.environments?.some(env => env.name === "agent-publish"))
  assert.equal(matches.length, 1, "Missing or ambiguous gate approval")
  assert.ok(Buffer.byteLength(matches[0].comment, "utf8") <= 900)
  const binding = JSON.parse(matches[0].comment)
  assert.deepEqual(new Set(Object.keys(binding)), new Set(["artifact", "attempt", "digest", "manifest", "result", "run", "source", "v", "base", "tree"]))
  assert.equal(binding.v, 4)
  assert.equal(typeof binding.base, "string")
  assert.ok(binding.base.length > 0)
  assert.equal(binding.run, run)
  assert.equal(binding.attempt, attempt)
  assert.ok(Number.isSafeInteger(binding.artifact) && binding.artifact > 0)
  assert.match(binding.digest, /^sha256:[a-f0-9]{64}$/)
  assert.match(binding.manifest, /^[a-f0-9]{64}$/)
  failureCause = "artifact validation failed"
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
  failureCause = "bundle validation failed"
  const checked = spawnSync("/usr/bin/python3", [join(dirname(fileURLToPath(import.meta.url)), "result.py"), "validate",
    `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repository}.git`], {
    cwd: root, input: JSON.stringify(binding), timeout: 180000, maxBuffer: 262144,
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
  })
  assert.equal(checked.status, 0, "Bundle validation failed")
  const metadata = JSON.parse(checked.stdout.toString())
  assert.equal(metadata.resultSha, binding.result)
  await writeFile(validated, JSON.stringify({ binding, metadata }), { mode: 0o600 })
  console.log("workflowd.publish validated immutable artifact and approval")
}

async function request(path, method = "GET", body) {
  const response = await fetch(api + path, {
    method, redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${process.env.PUBLISH_TOKEN}`, Accept: "application/vnd.github+json",
      "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok || response.status === 204) {
    if (!response.ok) failureCause += ` (HTTP ${response.status})`
    await response.body?.cancel()
    return { status: response.status }
  }
  return { status: response.status, data: JSON.parse((await bytes(response, 1048576)).toString()) }
}

async function record(state) {
  const value = { ...state }
  delete value.metadata
  await writeFile(receipt + ".tmp", JSON.stringify(value), { mode: 0o600 })
  await rename(receipt + ".tmp", receipt)
  // Only this trusted job emits receipts. The untrusted lease can forge same-run artifacts.
  console.log("workflowd.publish.receipt " + Buffer.from(JSON.stringify(value)).toString("base64"))
}

function verifyPull(pull, state) {
  assert.ok(Number.isSafeInteger(pull.number) && pull.number > 0)
  assert.equal(pull.state, "open")
  assert.equal(pull.draft, true)
  assert.equal(pull.maintainer_can_modify, false)
  assert.equal(pull.user.login, "ghettimonster[bot]")
  assert.equal(pull.user.id, 339414993)
  assert.equal(pull.user.type, "Bot")
  assert.equal(pull.head.ref, state.branch)
  assert.equal(pull.head.sha, state.commitSha)
  assert.equal(pull.title, state.metadata.title)
  assert.equal(pull.base.ref, state.binding.base)
  for (const side of [pull.head, pull.base]) {
    assert.equal(side.repo.full_name, repository)
    assert.equal(side.repo.id, Number(process.env.GITHUB_REPOSITORY_ID))
  }
  assert.equal(pull.body, publicationBody(state))
  assert.equal(pull.html_url, `https://github.com/${repository}/pull/${pull.number}`)
  return pull.number
}

// Query GitHub's parser after both creation and ambiguous-POST recovery. A
// missing/error response is also unsafe: close the known PR before failing.
async function verifyClosingIssues(state) {
  failureCause = "closing issue references could not be verified"
  try {
    const [owner, name] = repository.split("/")
    // Require a stable zero over three observations; allow GitHub's parser to
    // settle between reads. Every read has the existing request timeout.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await setTimeout(2000)
      const response = await request("/graphql", "POST", {
        query: "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences{totalCount}}}}",
        variables: { owner, name, number: state.pr },
      })
      assert.equal(response.status, 200)
      assert.ok(!response.data.errors)
      const count = response.data.data.repository.pullRequest.closingIssuesReferences.totalCount
      assert.ok(Number.isSafeInteger(count) && count >= 0)
      if (count !== 0) failureCause = "PR contains closing issue references"
      assert.equal(count, 0)
    }
  } catch (error) {
    const cause = failureCause
    failureCause = cause + "; PR closure failed"
    const closed = await request(`/repos/${repository}/pulls/${state.pr}`, "PATCH", { state: "closed" })
    assert.equal(closed.status, 200)
    assert.equal(closed.data.state, "closed")
    failureCause = cause + "; PR closed"
    throw error
  }
}

async function publish() {
  failureCause = "manifest validation failed"
  const { binding } = JSON.parse(await readFile(validated, "utf8"))
  // Re-read the sealed bytes: only the manifest digest in the approval authorizes agent text.
  const manifest = await readFile(join(root, "validated", "result.json"))
  assert.equal(createHash("sha256").update(manifest).digest("hex"), binding.manifest)
  const metadata = JSON.parse(manifest.toString("utf8"))
  assert.equal(binding.run, Number(process.env.GITHUB_RUN_ID))
  assert.equal(binding.attempt, Number(process.env.GITHUB_RUN_ATTEMPT))
  assert.equal(binding.v, 4)
  publicationText(metadata.title)
  publicationText(metadata.commitMessage, true)
  validateBody(metadata.body)
  assert.equal(metadata.treeSha, binding.tree)
  assert.equal(metadata.sourceSha, binding.source)
  assert.match(binding.tree, /^[a-f0-9]{40}$/)
  assert.match(binding.source, /^[a-f0-9]{40}$/)
  assert.match(binding.result, /^[a-f0-9]{40}$/)
  assert.equal(metadata.resultSha, binding.result)
  assert.equal(typeof metadata.branch, "string")
  const commitMessage = publicationCommitMessage(metadata.commitMessage)
  assert.ok(process.env.PUBLISH_TOKEN)
  const prefix = `/repos/${repository}`
  const state = { binding, metadata, repository, branch: metadata.branch, stage: "validated", commitSha: null, pr: null, revoked: false,
    closingIssuesVerified: false,
    marker: `<!-- workflowd-publication:${Buffer.from(JSON.stringify(binding)).toString("base64")} -->` }
  publicationState = state
  await record(state)
  const refPath = prefix + "/git/ref/heads/" + encodeURIComponent(state.branch)
  failureCause = "branch lookup failed"
  const existing = await request(refPath)
  if (existing.status === 200) failureCause = "branch already exists (HTTP 200)"
  assert.equal(existing.status, 404, "Branch already exists")
  failureCause = "tree preparation failed"
  const prepared = spawnSync("/usr/bin/python3", [join(dirname(fileURLToPath(import.meta.url)), "result.py"), "tree", binding.source, binding.result], {
    cwd: root, timeout: 180000, maxBuffer: 16 * 1048576,
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
  })
  assert.equal(prepared.status, 0, "Tree preparation failed")
  const tree = JSON.parse(prepared.stdout.toString())
  for (const entry of tree.tree) {
    if (entry.sha !== null) {
      failureCause = "blob creation failed"
      const blob = await request(prefix + "/git/blobs", "POST", { content: entry.content, encoding: "base64" })
      assert.equal(blob.status, 201)
      assert.equal(blob.data.sha, entry.sha)
      delete entry.content
    }
  }
  failureCause = "tree creation failed"
  const createdTree = await request(prefix + "/git/trees", "POST", tree)
  assert.equal(createdTree.status, 201)
  assert.equal(createdTree.data.sha, binding.tree)
  // Omit author/committer so GitHub attributes and signs using the authenticated App.
  failureCause = "commit creation failed"
  const commit = await request(prefix + "/git/commits", "POST", {
    tree: binding.tree, parents: [binding.source], message: commitMessage,
  })
  assert.equal(commit.status, 201)
  failureCause = "commit validation failed"
  verifyCommit(commit.data, state)
  state.commitSha = commit.data.sha
  state.stage = "pushing"
  await record(state)
  // GitHub's create-ref endpoint fails on collisions, including a race after preflight.
  // An ambiguous reply is never retried or adopted as a successful creation.
  failureCause = "branch creation failed"
  const createdRef = await request(prefix + "/git/refs", "POST", { ref: `refs/heads/${state.branch}`, sha: state.commitSha })
  assert.equal(createdRef.status, 201)
  assert.equal(createdRef.data.ref, `refs/heads/${state.branch}`)
  assert.equal(createdRef.data.object.sha, state.commitSha)
  state.stage = "pushed"
  await record(state)
  failureCause = "branch readback failed"
  const remote = await request(refPath)
  assert.equal(remote.status, 200)
  assert.equal(remote.data.ref, `refs/heads/${state.branch}`)
  assert.equal(remote.data.object.sha, state.commitSha)
  state.stage = "creating_pr"
  await record(state)
  let number
  try {
    failureCause = "PR creation failed"
    const created = await request(prefix + "/pulls", "POST", { title: metadata.title, body: publicationBody(state),
      head: state.branch, base: binding.base, draft: true, maintainer_can_modify: false })
    assert.equal(created.status, 201)
    number = created.data.number
  } catch (error) {
    // The branch was proven created above. An ambiguous POST is read back, never retried.
    const originalCause = failureCause
    try {
      failureCause = "PR recovery failed"
      const found = await request(prefix + "/pulls?" + new URLSearchParams({
        state: "all", head: repository.split("/")[0] + ":" + state.branch, base: binding.base, per_page: "100",
      }))
      assert.equal(found.status, 200)
      assert.ok(Array.isArray(found.data) && found.data.length === 1)
      number = found.data[0].number
    } catch {
      failureCause = originalCause
      throw error
    }
  }
  failureCause = "PR validation failed"
  assert.ok(Number.isSafeInteger(number) && number > 0)
  const readback = await request(prefix + "/pulls/" + number)
  assert.equal(readback.status, 200)
  state.pr = verifyPull(readback.data, state)
  await verifyClosingIssues(state)
  state.closingIssuesVerified = true
  await record(state)
  failureCause = "commit validation failed"
  const commitReadback = await request(prefix + "/git/commits/" + state.commitSha)
  assert.equal(commitReadback.status, 200)
  assert.equal(commitReadback.data.sha, state.commitSha)
  verifyCommit(commitReadback.data, state)
  state.stage = "published"
  await record(state)
}

async function revoke() {
  failureCause = "token revocation failed"
  // Idempotent DELETE; 401 means this token is already invalid. No response body is logged.
  const response = await request("/installation/token", "DELETE")
  assert.ok(response.status === 204 || response.status === 401)
  try {
    const state = JSON.parse(await readFile(receipt, "utf8"))
    state.revoked = true
    await record(state)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}

try {
  if (process.argv[2] === "validate") await validate()
  else if (process.argv[2] === "publish") await publish()
  else if (process.argv[2] === "revoke") await revoke()
  else throw new Error("Unknown operation")
} catch {
  // Never include server bodies, credentials, agent metadata or process output.
  if (publicationState !== undefined) {
    publicationState.cause = failureCause
    await record(publicationState).catch(() => undefined)
  }
  console.log("workflowd.publish.failure " + Buffer.from(JSON.stringify({ cause: failureCause })).toString("base64"))
  console.error("Protected publication failed closed: " + failureCause)
  process.exitCode = 1
}
