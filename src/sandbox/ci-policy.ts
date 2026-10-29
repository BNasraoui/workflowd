import { readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { Schema } from "effect"

const ObjectValue = Schema.Record(Schema.String, Schema.Json)
const object = (value: unknown) => Schema.decodeUnknownSync(ObjectValue)(value)
const mainOnly =
  "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'schedule')"
/** The only runner label PR jobs may use: a disposable GitHub-hosted image. */
export const prRunnerLabel = "ubuntu-24.04"
const setupBun = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"
const setupNode = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020"
// Reviewed in full: anonymous checkout, credential-free pinned Nix installation,
// tokenless pinned Bun setup, locked build/determinism/E2E, and artifact upload
// restricted to main pushes.
// Any dependency, permission, input or script edit requires a fresh review.
const imageWorkflowSha256 = "5cbed263784fda5a91137a9c935d7f1ba4ccb809b31d479b329a76aa9a79a857"
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
  if (job["runs-on"] !== prRunnerLabel)
    throw new Error(`PR jobs must run on the ${prRunnerLabel} GitHub-hosted runner`)
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

export function assertProtectedPublishAction(source: string): void {
  // Reviewed token scope, validation ordering, only key consumer, always-revoke and post fallback.
  if (
    createHash("sha256").update(source).digest("hex") !==
    "6217c92fa2fe9e4b0a38a56fc28d6c30c6c57def65918e51b7aaabcd9f5fd54b"
  )
    throw new Error("Publisher action differs from the reviewed secret-isolation snapshot")
}

function assertPublishIsolation(
  workflow: ReturnType<typeof object>,
  workflows: Record<string, string>,
) {
  const referencesSecrets = (value: unknown) =>
    /secrets\s*(?:\.|\[)|toJSON\s*\(\s*secrets\b/i.test(JSON.stringify(value))
  if (/"secrets"\s*:\s*"inherit"/i.test(JSON.stringify(workflow)))
    throw new Error("Inherited secrets are forbidden in every workflow")
  const { jobs, ...ambient } = workflow
  if (referencesSecrets(ambient)) throw new Error("Workflow-level secrets are forbidden")
  for (const [name, value] of Object.entries(object(jobs))) {
    const job = object(value)
    if (
      job.uses !== undefined &&
      (typeof job.uses !== "string" ||
        !/^\.\/\.github\/workflows\/[^/]+\.ya?ml$/.test(job.uses) ||
        !Object.hasOwn(workflows, job.uses.slice("./.github/workflows/".length)))
    )
      throw new Error(
        "Reusable workflows must reference a scanned local .github/workflows YAML file",
      )
    if (name !== "agent-publish") {
      if (job.environment !== undefined || referencesSecrets(job) || job.secrets !== undefined)
        throw new Error("Only agent-publish may attach an environment or reference secrets")
    } else {
      // Only the separately reviewed ben-approval.yml may select the approval
      // environment. A constant allowlist also excludes dynamic/case aliases.
      if (job.environment !== undefined && job.environment !== "agent-publish")
        throw new Error("Publisher environment must be agent-publish")
      if ("workflow_call" in object(workflow.on))
        throw new Error("agent-publish must be a top-level caller job")
      const { steps, ...ambientJob } = job
      if (referencesSecrets(ambientJob) || job.secrets !== undefined || job.env !== undefined)
        throw new Error("Publisher secrets must be explicit composite inputs")
      const publishSteps = Schema.decodeUnknownSync(Schema.Array(Schema.Json))(steps)
      // One reviewed composite is the entire job: no cache restore/save, setup cache,
      // local checkout, or arbitrary action/script can populate the privileged runner.
      if (publishSteps.length !== 1)
        throw new Error("Publisher must run only the reviewed pinned action without cache steps")
      for (const value of publishSteps) {
        const step = object(value)
        const inputs = object(step.with ?? {})
        if (
          typeof step.uses !== "string" ||
          !/^BNasraoui\/workflowd\/\.github\/actions\/agent-publish@[a-f0-9]{40}$/.test(
            step.uses,
          ) ||
          Object.keys(step).some((key) => !["name", "uses", "with"].includes(key))
        )
          throw new Error("Publisher must use a constant full SHA reference to the reviewed action")
        if (inputs["publisher-private-key"] !== undefined) {
          const { "publisher-private-key": key, ...other } = inputs
          if (
            key !== "${{ secrets.GHETTIMONSTER_PRIVATE_KEY }}" ||
            referencesSecrets({ ...step, with: other })
          )
            throw new Error("Publisher key is only allowed as the reviewed action input")
        } else if (referencesSecrets(step)) throw new Error("Unexpected publisher secret consumer")
      }
    }
  }
}

/** PR paths may call the two reviewed setup actions or the exact image workflow snapshot.
 * Other local/composite/reusable dependencies and inherited secrets are refused. This
 * runs against the PR head to aid review; untrusted code cannot secure its own edits.
 */
export function assertUnprivilegedPrWorkflows(workflows: Record<string, string>): void {
  let pullRequests = 0
  for (const [name, source] of Object.entries(workflows)) {
    if (name === "ben-approval.yml") {
      // Reviewed main-only dispatch, protected environment, pinned actions,
      // read-only workflow token, and single scoped App-key consumer.
      if (
        createHash("sha256").update(source).digest("hex") !==
        "67d9e619b9c9260a7fb4f753e0721a17278bfb09d20e59bfd85d21ea1701b5d8"
      )
        throw new Error("Approval workflow differs from the reviewed secret-isolation snapshot")
      continue
    }
    const workflow = object(Bun.YAML.parse(source))
    if (typeof workflow.on !== "object" || workflow.on === null || Array.isArray(workflow.on))
      throw new Error(
        `${name}: workflow on must be a mapping (for example, on: { workflow_dispatch: {} })`,
      )
    assertPublishIsolation(workflow, workflows)
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
  assertProtectedPublishAction(await Bun.file(".github/actions/agent-publish/action.yml").text())
  assertUnprivilegedPrWorkflows(workflows)
  console.log(
    "PR workflow policy passed: empty permissions, anonymous checkout, no secrets or shared caches",
  )
}
