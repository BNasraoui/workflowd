import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { Schema } from "effect"

const Step = Schema.Struct({
  uses: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
})
const Workflow = Schema.Struct({
  on: Schema.Record(Schema.String, Schema.Json),
  permissions: Schema.Json,
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      uses: Schema.optionalKey(Schema.String),
      if: Schema.optionalKey(Schema.String),
      secrets: Schema.optionalKey(Schema.Json),
      permissions: Schema.optionalKey(Schema.Json),
      "runs-on": Schema.optionalKey(Schema.String),
      "timeout-minutes": Schema.optionalKey(Schema.Number),
      steps: Schema.optionalKey(Schema.Array(Step)),
    }),
  ),
})

const root = resolve(import.meta.dir, "../..")

test("only App lease pushes can invoke the repository-bound reusable workflow", async () => {
  const caller = Schema.decodeUnknownSync(Workflow)(
    Bun.YAML.parse(await Bun.file(`${root}/.github/workflows/agent-sandbox-caller.yml`).text()),
  )
  expect(caller.on).toEqual({ push: { branches: ["workflowd/leases/**"] } })
  expect(caller.permissions).toEqual({})
  expect(caller.jobs.sandbox?.uses).toBe("./.github/workflows/agent-sandbox.yml")
  expect(caller.jobs.sandbox?.if).toContain("github.actor_id == '306741873'")
  expect(caller.jobs.sandbox?.if).toContain("github.repository_id == '1306107007'")
  expect(caller.jobs.sandbox?.secrets).toBeUndefined()
})

test("runner workflow grants only read/OIDC and pins third-party actions", async () => {
  const workflow = Schema.decodeUnknownSync(Workflow)(
    Bun.YAML.parse(await Bun.file(`${root}/.github/workflows/agent-sandbox.yml`).text()),
  )
  expect(Object.keys(workflow.on)).toEqual(["workflow_call"])
  const job = workflow.jobs.runner
  if (job === undefined || job.steps === undefined) throw new Error("Missing runner job")
  expect(job["runs-on"]).toBe("ubuntu-24.04")
  expect(job["timeout-minutes"]).toBe(300)
  expect(job.permissions).toEqual({ contents: "read", "id-token": "write" })
  for (const step of job.steps) {
    if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/)
  }
  expect(
    job.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"))?.with?.[
      "persist-credentials"
    ],
  ).toBe(false)
  expect(
    job.steps.find((step: { uses?: string }) => step.uses?.startsWith("tailscale/github-action@"))
      ?.uses,
  ).toBe("tailscale/github-action@d1b6cd204f8dceda5b3eaad7f1f767be390056cd")
})

test("runner rejects malformed source requests before invoking Docker", async () => {
  const child = Bun.spawn(["bash", `${root}/deploy/sandbox/runner.sh`, "initialize"], {
    stdin: new Blob(['{"repository":"elsewhere/other","sourceSha":"main"}\n']),
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited).toBe(1)
  expect(stderr).toContain("Invalid sandbox source request")
})

test("runner disables routes after the action joins and before preparing tooling", async () => {
  const workflow = Schema.decodeUnknownSync(Workflow)(
    Bun.YAML.parse(await Bun.file(`${root}/.github/workflows/agent-sandbox.yml`).text()),
  )
  const steps = workflow.jobs.runner?.steps
  if (steps === undefined) throw new Error("Missing runner steps")
  const join = steps.findIndex((step) => step.uses?.startsWith("tailscale/github-action@"))
  // The pinned action always supplies --accept-routes to `tailscale up`.
  // Passing the flag again makes the CLI reject the whole join command.
  expect(steps[join]?.with?.args).toBe("--ssh")
  expect(steps[join + 1]?.run).toBe("sudo tailscale set --accept-routes=false")
  expect(steps[join + 2]?.run).toBe("bash deploy/sandbox/runner.sh prepare")
  expect(steps.at(-1)?.run).toBe("bash deploy/sandbox/runner.sh stop")
})
