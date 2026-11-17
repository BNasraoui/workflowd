import { expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { Schema } from "effect"

const Step = Schema.Struct({
  if: Schema.optionalKey(Schema.String),
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
      with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
      secrets: Schema.optionalKey(Schema.Json),
      permissions: Schema.optionalKey(Schema.Json),
      "runs-on": Schema.optionalKey(Schema.String),
      "timeout-minutes": Schema.optionalKey(Schema.Number),
      steps: Schema.optionalKey(Schema.Array(Step)),
    }),
  ),
})

const root = resolve(import.meta.dir, "../..")

test("legacy readiness remains the explicit default and private bootstrap never uploads rendezvous", async () => {
  const workflow = Schema.decodeUnknownSync(Workflow)(
    Bun.YAML.parse(await Bun.file(`${root}/.github/workflows/agent-sandbox.yml`).text()),
  )
  const call = Schema.decodeUnknownSync(
    Schema.Struct({
      inputs: Schema.Struct({
        "bootstrap-mode": Schema.optionalKey(
          Schema.Struct({ type: Schema.String, default: Schema.String }),
        ),
      }),
    }),
  )(workflow.on.workflow_call)
  expect(call.inputs["bootstrap-mode"]?.default).toBe("legacy-artifact")
  const steps = workflow.jobs.runner?.steps ?? []
  const legacy = steps.filter((step) => step.if === "inputs.bootstrap-mode == 'legacy-artifact'")
  const privateSteps = steps.filter((step) => step.if === "inputs.bootstrap-mode == 'private'")
  expect(legacy.some((step) => step.run?.endsWith("runner.sh prepare"))).toBe(true)
  expect(legacy.some((step) => step.with?.path === "/run/workflowd-sandbox/ready.json")).toBe(true)
  expect(privateSteps.some((step) => step.run?.endsWith("runner.sh prepare-private"))).toBe(true)
  expect(
    steps.filter((step) => step.with?.path === "/run/workflowd-sandbox/ready.json"),
  ).toHaveLength(1)
  expect(privateSteps.some((step) => step.uses?.startsWith("actions/upload-artifact@"))).toBe(false)
})

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

test("the caller selects the bootstrap mode, the gateway URL and the image from the repository's variables, legacy-artifact when no mode is set", async () => {
  const caller = Schema.decodeUnknownSync(Workflow)(
    Bun.YAML.parse(await Bun.file(`${root}/.github/workflows/agent-sandbox-caller.yml`).text()),
  )
  expect(caller.jobs.sandbox?.with).toMatchObject({
    "bootstrap-mode": "${{ vars.SANDBOX_BOOTSTRAP_MODE || 'legacy-artifact' }}",
    "gateway-url": "${{ vars.SANDBOX_GATEWAY_URL }}",
    "agent-image": "${{ vars.SANDBOX_AGENT_IMAGE }}",
  })
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
  expect(job.if).toContain("github.event_name == 'push'")
  expect(job.if).toContain("startsWith(github.ref, 'refs/heads/workflowd/leases/')")
  expect(job.if).toContain("github.repository_id == inputs.repository-id")
  expect(job.if).toContain("github.actor_id == inputs.app-actor-id")
  expect(job.if).toContain("github.event.repository.fork == false")
  for (const step of job.steps) {
    if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/)
  }
  expect(
    job.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"))?.with?.[
      "persist-credentials"
    ],
  ).toBe(false)
  expect(
    job.steps.some(
      (step) =>
        step.run ===
        "node deploy/sandbox/public-output.mjs setup -- bash deploy/sandbox/tailscale.sh",
    ),
  ).toBe(true)
  expect(job.steps.some((step) => step.uses?.startsWith("tailscale/github-action@"))).toBe(false)
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

test("runner joins without accepting routes or DNS before preparing tooling", async () => {
  const source = await Bun.file(`${root}/deploy/sandbox/tailscale.sh`).text()
  expect(source).toContain("--accept-routes=false")
  expect(source).toContain("--accept-dns=false")
  expect(source).not.toContain("ip route show table 52")
  const workflow = Schema.decodeUnknownSync(Workflow)(
    Bun.YAML.parse(await Bun.file(`${root}/.github/workflows/agent-sandbox.yml`).text()),
  )
  const steps = workflow.jobs.runner?.steps ?? []
  const join = steps.findIndex(
    (step) =>
      step.run ===
      "node deploy/sandbox/public-output.mjs setup -- bash deploy/sandbox/tailscale.sh",
  )
  expect(join).toBeGreaterThan(0)
  expect(steps[join + 1]?.run).toBe(
    "node deploy/sandbox/public-output.mjs bootstrap -- bash deploy/sandbox/runner.sh prepare",
  )
  expect(steps.at(-1)?.run).toContain("tailscale logout")
})

test("publication uses a fresh environment-gated runner with a step-scoped explicit publisher key", async () => {
  const source = await Bun.file(`${root}/.github/workflows/agent-sandbox-caller.yml`).text()
  const raw = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
    Bun.YAML.parse(source),
  )
  const jobs = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(raw.jobs)
  const job = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
    jobs["agent-publish"],
  )
  expect(job.needs).toBe("sandbox")
  expect(job.environment).toBe("agent-publish")
  expect(job.permissions).toEqual({ actions: "read", contents: "read" })
  expect(job["runs-on"]).toBe("ubuntu-24.04")
  expect(JSON.stringify(job)).not.toMatch(/tailscale|id-token|secrets: inherit/)
  expect(JSON.stringify(job)).toContain("secrets.GHETTIMONSTER_PRIVATE_KEY")
  const runner = await Bun.file(`${root}/.github/workflows/agent-sandbox.yml`).text()
  expect(runner).toContain("sandbox-result-${{ github.run_id }}-${{ github.run_attempt }}")
  expect(runner).not.toMatch(/agent-publish:|environment:|secrets[.:]/)
  expect(source).toMatch(
    /uses: BNasraoui\/workflowd\/\.github\/actions\/agent-publish@[a-f0-9]{40}/,
  )
  expect(source).not.toContain("ref: ${{ github.sha }}")
})

test("reviewed composite validates before minting a repository-only token and always revokes", async () => {
  const source = await Bun.file(`${root}/.github/actions/agent-publish/action.yml`).text()
  const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))
  const action = record(Bun.YAML.parse(source))
  const steps = Schema.decodeUnknownSync(Schema.Array(Schema.Json))(record(action.runs).steps).map(
    (value) => record(value),
  )
  expect(record(steps[0]?.env).PUBLISH_CO_AUTHOR).toBe("${{ inputs.co-author }}")
  expect(record(steps[2]?.env).PUBLISH_CO_AUTHOR).toBe("${{ inputs.co-author }}")
  expect(steps[0]?.run).toContain('publish.mjs" validate')
  expect(steps[1]?.uses).toBe(
    "actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349",
  )
  expect(steps[1]?.with).toEqual({
    "app-id": "${{ inputs.publisher-app-id }}",
    "private-key": "${{ inputs.publisher-private-key }}",
    owner: "${{ github.repository_owner }}",
    repositories: "${{ github.event.repository.name }}",
    "permission-contents": "write",
    "permission-pull-requests": "write",
    "skip-token-revoke": false,
  })
  expect(steps[2]?.run).toContain('publish.mjs" publish')
  expect(steps[3]?.if).toBe("${{ always() && steps.token.outputs.token != '' }}")
  expect(steps[3]?.run).toContain('publish.mjs" revoke')
  expect(
    steps.filter((step) => JSON.stringify(step).includes("inputs.publisher-private-key")),
  ).toEqual([steps[1]!])
  expect(source).not.toContain("canary")
})

for (const tracked of [false, true]) {
  test(`runner image configuration stays outside the source tree; tracked=${tracked}`, async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { command } = await import("./harness")
    const directory = await mkdtemp(join(tmpdir(), "sandbox-image-"))
    const bin = join(directory, "bin")
    const repo = join(directory, "repo")
    const image = `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"a".repeat(64)}`
    try {
      await mkdir(bin)
      await mkdir(repo)
      await writeFile(join(bin, "docker"), '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 })
      await writeFile(
        join(bin, "container-use"),
        '#!/bin/sh\nmkdir -p .container-use\nprintf "%s" "$4" > .container-use/environment.json\n',
        { mode: 0o755 },
      )
      await command(["git", "init", "-q"], repo)
      await command(["git", "config", "user.name", "fixture"], repo)
      await command(["git", "config", "user.email", "fixture@example.invalid"], repo)
      if (tracked) {
        await mkdir(join(repo, ".container-use"))
        await writeFile(join(repo, ".container-use/environment.json"), "original")
        await command(["git", "add", "."], repo)
      }
      await command(["git", "commit", "--allow-empty", "-qm", "source"], repo)
      const head = await command(["git", "rev-parse", "HEAD"], repo)
      const source = await Bun.file(`${root}/deploy/sandbox/runner.sh`).text()
      const helper = source.slice(
        source.indexOf("configure_image() {"),
        source.indexOf('\ncase "${1:-}"'),
      )
      const child = Bun.spawn(
        ["bash", "-c", helper + '\nconfigure_image "$1"\nconfigure_image "$1"', "_", image],
        {
          cwd: repo,
          env: { PATH: `${bin}:/usr/bin:/bin` },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      expect(await child.exited).toBe(0)
      expect(await Bun.file(join(repo, ".container-use/environment.json")).text()).toBe(image)
      expect(await command(["git", "status", "--porcelain"], repo)).toBe("")
      expect(await command(["git", "rev-parse", "HEAD"], repo)).toBe(head)
      expect(source).toContain("os.environ['SANDBOX_AGENT_IMAGE']")
      if (!tracked)
        expect(
          (await Bun.file(join(repo, ".git/info/exclude")).text()).split(
            "/.container-use/environment.json",
          ),
        ).toHaveLength(2)
      for (const bad of [
        "ubuntu:24.04",
        `ghcr.io/bnasraoui/workflowd-agent-base:${"a".repeat(40)}`,
        image + "extra",
        image + "\n",
        image.replace("bnasraoui", "other"),
      ]) {
        const unsafe = Bun.spawn(["bash", "-c", helper + '\nconfigure_image "$1"', "_", bad], {
          cwd: repo,
          env: { PATH: `${bin}:/usr/bin:/bin` },
          stderr: "pipe",
        })
        expect(await unsafe.exited).not.toBe(0)
      }
      const { symlink } = await import("node:fs/promises")
      for (const path of [".container-use/environment.json", ".container-use"]) {
        await rm(join(repo, path), { recursive: true, force: true })
        const target = join(
          directory,
          path.endsWith(".json") ? "outside-file" : "outside-directory",
        )
        if (!path.endsWith(".json")) await mkdir(target)
        const protectedFile = path.endsWith(".json") ? target : join(target, "environment.json")
        await writeFile(protectedFile, "untouched")
        await symlink(target, join(repo, path))
        const unsafe = Bun.spawn(["bash", "-c", helper + '\nconfigure_image "$1"', "_", image], {
          cwd: repo,
          env: { PATH: `${bin}:/usr/bin:/bin` },
          stderr: "pipe",
        })
        expect(await unsafe.exited).not.toBe(0)
        expect(await Bun.file(protectedFile).text()).toBe("untouched")
      }
      expect(source).toContain('configure_image "$(cat /run/workflowd-sandbox/agent-image)"')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test("a private runner gets the gateway URL, waits at most five minutes for its first contact, and joins the tailnet without Tailscale SSH", async () => {
  const workflow = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Struct({
        runner: Schema.Struct({
          steps: Schema.Array(
            Schema.Struct({
              name: Schema.optionalKey(Schema.String),
              env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
              "timeout-minutes": Schema.optionalKey(Schema.Number),
            }),
          ),
        }),
      }),
    }),
  )(Bun.YAML.parse(await Bun.file(`${root}/.github/workflows/agent-sandbox.yml`).text()))
  const step = (name: string) => workflow.jobs.runner.steps.find((entry) => entry.name === name)
  expect(step("Prepare private first contact")?.env).toEqual({
    SANDBOX_GATEWAY_URL: "${{ inputs.gateway-url }}",
    SANDBOX_AGENT_IMAGE: "${{ inputs.agent-image }}",
  })
  expect(step("Prepare private first contact")?.["timeout-minutes"]).toBe(5)
  expect(step("Join the restricted tailnet")?.env?.SANDBOX_BOOTSTRAP_MODE).toBe(
    "${{ inputs.bootstrap-mode }}",
  )
  const source = await Bun.file(`${root}/deploy/sandbox/tailscale.sh`).text()
  const enroll = /python3 - <<'PY'\n([\s\S]*?)\nPY\n/.exec(source)?.[1]
  if (enroll === undefined) throw new Error("enrollment script missing")
  const directory = await mkdtemp(join(tmpdir(), "wfd-tailscale-join-"))
  const issuer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ value: "fixture-id-token" }),
  })
  try {
    await writeFile(
      join(directory, "sudo"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(directory, "argv")}"\ncat > /dev/null\n`,
      { mode: 0o700 },
    )
    for (const mode of ["private", "legacy-artifact"]) {
      const child = Bun.spawn(["/usr/bin/python3", "-c", enroll], {
        env: {
          PATH: `${directory}:/usr/bin:/bin`,
          ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${issuer.port}/token?api-version=2`,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request",
          SANDBOX_AUDIENCE: "fixture",
          SANDBOX_TAILSCALE_CLIENT_ID: "fixture",
          SANDBOX_BOOTSTRAP_MODE: mode,
          GITHUB_RUN_ID: "78",
          GITHUB_RUN_ATTEMPT: "1",
        },
        stdout: "ignore",
        stderr: "pipe",
      })
      expect(await child.exited).toBe(0)
      const argv = (await readFile(join(directory, "argv"), "utf8")).split("\n")
      expect(argv.slice(0, 3)).toEqual(["-n", "tailscale", "up"])
      expect(argv.includes("--ssh")).toBe(mode !== "private")
      expect(argv).toContain("--advertise-tags=tag:agent-runner")
    }
  } finally {
    await issuer.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})
