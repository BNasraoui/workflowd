import { readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { Schema } from "effect"

const ObjectValue = Schema.Record(Schema.String, Schema.Json)
const object = (value: unknown) => Schema.decodeUnknownSync(ObjectValue)(value)
const mainOnly =
  "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'schedule')"
const setupBun = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"
const setupNode = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020"
// Reviewed in full: anonymous checkout, credential-free pinned Nix installation,
// locked build/determinism/E2E, and artifact upload restricted to main pushes.
// Any dependency, permission, input or script edit requires a fresh review.
const imageWorkflowSha256 = "483f0cfecd3f4dc404dd977d281a0318c556174ce326244c1f223bf7f2736c2f"
const head = "${{ github.event.pull_request.head.sha || github.sha }}"
const base = "${{ github.event.pull_request.base.sha || github.event.before }}"
const checkout = `set -euo pipefail
[[ "$HEAD_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$BASE_SHA" =~ ^[a-f0-9]{40}$ ]]
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
git init .
git remote add origin https://github.com/BNasraoui/workflowd.git
git -c credential.helper= -c http.extraHeader= fetch --no-tags origin "$HEAD_SHA" "$BASE_SHA"
git checkout --detach "$HEAD_SHA"`

function requireEmpty(value: unknown) {
  if (Object.keys(object(value)).length !== 0)
    throw new Error("PR permissions must be explicitly empty")
}

function assertStep(value: Schema.Json) {
  const step = object(value)
  if (step.uses === undefined) return
  const inputs = object(step.with ?? {})
  if (step.uses === setupBun) {
    if (
      inputs.token !== "" ||
      inputs["no-cache"] !== true ||
      inputs["bun-version"] !== "1.3.14" ||
      Object.keys(inputs).length !== 3
    )
      throw new Error("Bun setup must be tokenless with caching disabled")
  } else if (step.uses === setupNode) {
    if (
      inputs.token !== "" ||
      inputs["node-version"] !== "24.11.1" ||
      Object.keys(inputs).length !== 2
    )
      throw new Error("Node setup must be tokenless with caching disabled")
  } else throw new Error("PR action/reusable dependency is not an approved pinned setup action")
}

function assertJob(value: Schema.Json, workflows: Record<string, string>) {
  const job = object(value)
  requireEmpty(job.permissions)
  if (job.uses === "./.github/workflows/agent-image.yml") {
    const source = workflows["agent-image.yml"]
    if (
      Object.keys(job).some((key) => key !== "uses" && key !== "permissions") ||
      source === undefined ||
      createHash("sha256").update(source).digest("hex") !== imageWorkflowSha256
    )
      throw new Error("Image build differs from the reviewed unprivileged snapshot")
    return
  }
  if (
    job.uses !== undefined ||
    job.secrets !== undefined ||
    job.environment !== undefined ||
    job.container !== undefined ||
    job.services !== undefined
  )
    throw new Error("PR job may not attach secrets, environments, containers or reusable workflows")
  if (job["runs-on"] !== "ubuntu-latest")
    throw new Error("PR jobs require disposable GitHub runners")
  const serialized = JSON.stringify(job).replace(/\\[nrt]/g, " ")
  if (
    /toJSON\s*\(\s*(?:github|secrets)\b|secrets\s*(?:\.|\[)|github\s*(?:\.\s*token|\[)|ACTIONS_(?:ID_TOKEN|RUNTIME)|GITHUB_TOKEN|workflow_run|pull_request_target/i.test(
      serialized,
    )
  )
    throw new Error("PR job references privileged context")
  const steps = Schema.decodeUnknownSync(Schema.Array(Schema.Json))(job.steps)
  for (const step of steps) assertStep(step)
  const checkouts = steps.map(object).filter((step) => step.name === "Anonymous checkout")
  if (checkouts.length > 1) throw new Error("Duplicate checkout")
  for (const step of checkouts) {
    if (
      step.run !== checkout + "\n" ||
      JSON.stringify(step.env) !== JSON.stringify({ HEAD_SHA: head, BASE_SHA: base })
    )
      throw new Error("Anonymous checkout differs from the approved snapshot")
  }
  if (
    serialized.includes("bun install") &&
    !serialized.includes("bun install --frozen-lockfile --ignore-scripts")
  )
    throw new Error("Dependency installation must ignore scripts")
}

/** PR paths may call the two reviewed setup actions or the exact image workflow snapshot.
 * Other local/composite/reusable dependencies and inherited secrets are refused. This
 * runs against an operator-reviewed snapshot; untrusted code cannot secure its own edits.
 */
export function assertUnprivilegedPrWorkflows(workflows: Record<string, string>): void {
  let pullRequests = 0
  for (const source of Object.values(workflows)) {
    const workflow = object(Bun.YAML.parse(source))
    const triggers = object(workflow.on)
    if ("pull_request_target" in triggers || "workflow_run" in triggers)
      throw new Error("Privileged PR/downstream triggers are forbidden")
    if (!("pull_request" in triggers)) continue
    pullRequests++
    requireEmpty(workflow.permissions)
    if (workflow.env !== undefined || workflow.defaults !== undefined)
      throw new Error("PR workflow ambient environment/defaults are not approved")
    for (const job of Object.values(object(workflow.jobs))) {
      if (object(job).if === mainOnly) continue
      assertJob(job, workflows)
    }
  }
  if (pullRequests < 2) throw new Error("CI and CodeQL PR policy workflows are required")
}

if (import.meta.main) {
  const root = ".github/workflows"
  const names = await readdir(root)
  const workflows = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await Bun.file(`${root}/${name}`).text()] as const),
    ),
  )
  assertUnprivilegedPrWorkflows(workflows)
  console.log(
    "PR workflow policy passed: empty permissions, anonymous checkout, no secrets or shared caches",
  )
}
