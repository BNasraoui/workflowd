// Reviewed tooling only. No agent code, configuration or command output is executed or logged.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = join(process.env.RUNNER_TEMP, "workflowd-publish")
const validated = join(root, "validated.json")
const receipt = join(root, "receipt.json")
const repository = process.env.GITHUB_REPOSITORY
const api = process.env.GITHUB_API_URL || "https://api.github.com"

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

function publicationText(value, message = false) {
  assert.equal(typeof value, "string")
  assert.ok(value.length > 0 && value.isWellFormed())
  assert.ok(message ? Buffer.byteLength(value, "utf8") <= 10240 : [...value].length <= 200)
  assert.ok(!/\p{Cc}/u.test(message ? value.replaceAll("\n", "") : value))
  assert.ok(message || !/[\u2028\u2029]/u.test(value))
}

function configuredCoAuthor() {
  const value = process.env.PUBLISH_CO_AUTHOR
  assert.equal(typeof value, "string")
  assert.ok(value.isWellFormed() && !/[\p{Cc}\u2028\u2029]/u.test(value))
  assert.match(value, /^[^\s<>][^<>]* <[^\s<>@]+@[^\s<>@]+>$/u)
  return value
}

function publicationCommitMessage(message) {
  const coAuthor = configuredCoAuthor()
  const body = message.split("\n").filter((line) =>
    line.replace(/^co-authored-by: */i, "").trimEnd() !== coAuthor || !/^co-authored-by:/i.test(line),
  ).join("\n").trimEnd()
  return `${body}\n\nCo-authored-by: ${coAuthor}`
}

function verifyCommit(commit, state) {
  assert.match(commit.sha, /^[a-f0-9]{40}$/)
  assert.equal(commit.tree.sha, state.binding.tree)
  assert.deepEqual(commit.parents.map(parent => parent.sha), [state.binding.source])
  assert.equal(commit.message, publicationCommitMessage(state.binding.commitMessage))
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
  const reviews = await json(`/actions/runs/${run}/approvals`)
  assert.ok(Array.isArray(reviews) && reviews.length <= 100)
  const matches = reviews.filter(review => review.state === "approved" && review.user?.id === actor &&
    review.user?.type === "Bot" && review.environments?.some(env => env.name === "agent-publish"))
  assert.equal(matches.length, 1, "Missing or ambiguous gate approval")
  const binding = JSON.parse(matches[0].comment)
  assert.deepEqual(new Set(Object.keys(binding)), new Set(["artifact", "attempt", "digest", "manifest", "result", "run", "source", "v", "base", "tree", "title", "commitMessage"]))
  assert.equal(binding.v, 3)
  publicationText(binding.title)
  publicationText(binding.commitMessage, true)
  assert.equal(typeof binding.base, "string")
  assert.ok(binding.base.length > 0)
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
  const checked = spawnSync("/usr/bin/python3", [join(dirname(fileURLToPath(import.meta.url)), "result.py"), "validate",
    `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repository}.git`], {
    cwd: root, input: JSON.stringify(binding), timeout: 180000, maxBuffer: 65536,
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
  if (response.status === 404 || response.status === 204 || response.status === 401)
    return { status: response.status }
  return { status: response.status, data: JSON.parse((await bytes(response, 1048576)).toString()) }
}

async function record(value) {
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
  assert.equal(pull.title, state.binding.title)
  assert.equal(pull.base.ref, state.binding.base)
  for (const side of [pull.head, pull.base]) {
    assert.equal(side.repo.full_name, repository)
    assert.equal(side.repo.id, Number(process.env.GITHUB_REPOSITORY_ID))
  }
  assert.equal(pull.body, state.marker + "\n\n" + state.binding.commitMessage)
  assert.equal(pull.html_url, `https://github.com/${repository}/pull/${pull.number}`)
  return pull.number
}

async function publish() {
  const { binding, metadata } = JSON.parse(await readFile(validated, "utf8"))
  assert.equal(binding.run, Number(process.env.GITHUB_RUN_ID))
  assert.equal(binding.attempt, Number(process.env.GITHUB_RUN_ATTEMPT))
  assert.equal(binding.v, 3)
  publicationText(binding.title)
  publicationText(binding.commitMessage, true)
  assert.equal(metadata.title, binding.title)
  assert.equal(metadata.commitMessage, binding.commitMessage)
  assert.equal(metadata.treeSha, binding.tree)
  assert.equal(metadata.sourceSha, binding.source)
  assert.match(binding.tree, /^[a-f0-9]{40}$/)
  assert.match(binding.source, /^[a-f0-9]{40}$/)
  assert.match(binding.result, /^[a-f0-9]{40}$/)
  assert.equal(metadata.resultSha, binding.result)
  assert.equal(typeof metadata.branch, "string")
  const commitMessage = publicationCommitMessage(binding.commitMessage)
  assert.ok(process.env.PUBLISH_TOKEN)
  const prefix = `/repos/${repository}`
  const state = { binding, repository, branch: metadata.branch, stage: "validated", commitSha: null, pr: null, revoked: false,
    marker: `<!-- workflowd-publication:${Buffer.from(JSON.stringify(binding)).toString("base64")} -->` }
  await record(state)
  const refPath = prefix + "/git/ref/heads/" + encodeURIComponent(state.branch)
  assert.equal((await request(refPath)).status, 404, "Branch already exists")
  const prepared = spawnSync("/usr/bin/python3", [join(dirname(fileURLToPath(import.meta.url)), "result.py"), "tree", binding.source, binding.result], {
    cwd: root, timeout: 180000, maxBuffer: 16 * 1048576,
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
  })
  assert.equal(prepared.status, 0, "Tree preparation failed")
  const tree = JSON.parse(prepared.stdout.toString())
  for (const entry of tree.tree) {
    if (entry.sha !== null) {
      const blob = await request(prefix + "/git/blobs", "POST", { content: entry.content, encoding: "base64" })
      assert.equal(blob.status, 201)
      assert.equal(blob.data.sha, entry.sha)
      delete entry.content
    }
  }
  const createdTree = await request(prefix + "/git/trees", "POST", tree)
  assert.equal(createdTree.status, 201)
  assert.equal(createdTree.data.sha, binding.tree)
  // Omit author/committer so GitHub attributes and signs using the authenticated App.
  const commit = await request(prefix + "/git/commits", "POST", {
    tree: binding.tree, parents: [binding.source], message: commitMessage,
  })
  assert.equal(commit.status, 201)
  verifyCommit(commit.data, state)
  state.commitSha = commit.data.sha
  state.stage = "pushing"
  await record(state)
  // GitHub's create-ref endpoint fails on collisions, including a race after preflight.
  // An ambiguous reply is never retried or adopted as a successful creation.
  const createdRef = await request(prefix + "/git/refs", "POST", { ref: `refs/heads/${state.branch}`, sha: state.commitSha })
  assert.equal(createdRef.status, 201)
  assert.equal(createdRef.data.ref, `refs/heads/${state.branch}`)
  assert.equal(createdRef.data.object.sha, state.commitSha)
  state.stage = "pushed"
  await record(state)
  const remote = await request(refPath)
  assert.equal(remote.status, 200)
  assert.equal(remote.data.ref, `refs/heads/${state.branch}`)
  assert.equal(remote.data.object.sha, state.commitSha)
  state.stage = "creating_pr"
  await record(state)
  let number
  try {
    const created = await request(prefix + "/pulls", "POST", { title: binding.title, body: state.marker + "\n\n" + binding.commitMessage,
      head: state.branch, base: binding.base, draft: true, maintainer_can_modify: false })
    assert.equal(created.status, 201)
    number = created.data.number
  } catch {
    // The branch was proven created above. An ambiguous POST is read back, never retried.
    const found = await request(prefix + "/pulls?" + new URLSearchParams({
      state: "all", head: repository.split("/")[0] + ":" + state.branch, base: binding.base, per_page: "100",
    }))
    assert.equal(found.status, 200)
    assert.ok(Array.isArray(found.data) && found.data.length === 1)
    number = found.data[0].number
  }
  assert.ok(Number.isSafeInteger(number) && number > 0)
  const readback = await request(prefix + "/pulls/" + number)
  assert.equal(readback.status, 200)
  state.pr = verifyPull(readback.data, state)
  const commitReadback = await request(prefix + "/git/commits/" + state.commitSha)
  assert.equal(commitReadback.status, 200)
  assert.equal(commitReadback.data.sha, state.commitSha)
  verifyCommit(commitReadback.data, state)
  state.stage = "published"
  await record(state)
}

async function revoke() {
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
  console.error("Protected publication failed closed")
  process.exitCode = 1
}
