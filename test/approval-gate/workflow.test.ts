import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { assertUnprivilegedPrWorkflows } from "../../src/sandbox/ci-policy"

test("the approval workflow exists and passes the repository privilege policy", async () => {
  expect(await Bun.file(".github/workflows/ben-approval.yml").exists()).toBe(true)
  const files = Object.fromEntries(
    await Promise.all(
      (await readdir(".github/workflows")).map(
        async (name) => [name, await Bun.file(`.github/workflows/${name}`).text()] as const,
      ),
    ),
  )
  const workflow = Bun.YAML.parse(files["ben-approval.yml"]!)
  expect(workflow).toHaveProperty(
    "run-name",
    "Ben approval: ${{ inputs.action }} ${{ inputs.head_sha }} (PR #${{ inputs.pr_number }})",
  )
  expect(workflow).toHaveProperty(
    "on.workflow_dispatch.inputs.action",
    expect.objectContaining({
      type: "choice",
      required: true,
      default: "approve",
      options: ["approve", "revoke"],
    }),
  )
  expect(workflow).toHaveProperty("on.workflow_dispatch.inputs.pr_number.required", false)
  expect(workflow).toHaveProperty("concurrency", {
    group: "ben-approval-${{ inputs.head_sha }}",
    "cancel-in-progress": false,
  })
  expect(workflow).toHaveProperty("jobs.approve.env", {
    PR_NUMBER: "${{ inputs.pr_number }}",
    HEAD_SHA: "${{ inputs.head_sha }}",
    APPROVAL_ACTION: "${{ inputs.action }}",
    BEN_APPROVAL_APP_ID: "${{ vars.BEN_APPROVAL_APP_ID }}",
  })
  expect(() => assertUnprivilegedPrWorkflows(files)).not.toThrow()
  for (const [before, after] of [
    ["workflow_dispatch:", "pull_request_target:"],
    ["refs/heads/main", "refs/heads/other"],
    ["environment: ben-merge-approval", "environment: other"],
    ["ref: ${{ github.sha }}", "ref: ${{ inputs.head_sha }}"],
    ["persist-credentials: false", "persist-credentials: true"],
    ["permission-checks: write", "permission-contents: write"],
    ["skip-token-revoke: false", "skip-token-revoke: true"],
    ["runs-on: ubuntu-latest", "runs-on: self-hosted"],
    ["node deploy/approval-gate/check.mjs validate", "true"],
    ["node deploy/approval-gate/check.mjs publish", "true"],
    ["    steps:", "    env: { KEY: '${{ secrets.BEN_APPROVAL_PRIVATE_KEY }}' }\n    steps:"],
  ]) {
    const changed = files["ben-approval.yml"]!.replace(before!, after!)
    expect(changed).not.toBe(files["ben-approval.yml"])
    expect(() => assertUnprivilegedPrWorkflows({ ...files, "ben-approval.yml": changed })).toThrow()
  }
})
