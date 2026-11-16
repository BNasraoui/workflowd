import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { Fixture } from "../capability-gateway/gateway-process"
import { grantsJobIdentity, runnerJob, runSteps, type JobStep } from "./workflow-job"
import { Effect } from "effect"
import { AgentRunIngress } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { claudeBetas } from "../../src/capability-gateway/claude"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { mailbox, run, runnerModel, step, withRunnerDaemon } from "./fixture"

/**
 * The whole runner run on a host with Docker and the agent image, as the agent image job of CI
 * runs it: the daemon dispatches a run of a repository placed on a runner; the real runner
 * scripts (bootstrap.mjs, run-client.mjs, the relay, native-runner.mjs, runner.sh) open the
 * job's session with a proof of the fixture OIDC key, read the launch, clone the source through
 * the gateway's Git route, run the pinned Claude Code in the box against the fixture model, post
 * its events and its sealed result; the daemon checks it, pushes agent-run/<id> and writes the
 * caller's message. `WORKFLOWD_RUNNER_IMAGE` names the image by its registry digest.
 */

const image = process.env.WORKFLOWD_RUNNER_IMAGE ?? ""
/** The job's run directory, as on a runner. */
const directory = "/run/workflowd-sandbox"
const pinned = `${readFileSync("test/resources/claude-code-version", "utf8").trim()} (Claude Code)`
const proofText = "written by the runner run\n"

const event = (type: string, value: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`
/** A model answer of one content block, ending with `stop`. */
const answer = (block: object, delta: object, stop: string) =>
  event("message_start", {
    message: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: runnerModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  }) +
  event("content_block_start", { index: 0, content_block: block }) +
  event("content_block_delta", { index: 0, delta }) +
  event("content_block_stop", { index: 0 }) +
  event("message_delta", {
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: 20 },
  }) +
  event("message_stop", {})
const text = (value: string) =>
  answer({ type: "text", text: "" }, { type: "text_delta", text: value }, "end_turn")
/** The model's first turn of the run: Claude Code's Write tool writes the proof file. */
const write = answer(
  { type: "tool_use", id: "toolu_fixture", name: "Write", input: {} },
  {
    type: "input_json_delta",
    partial_json: JSON.stringify({ file_path: "/workdir/runner-proof.txt", content: proofText }),
  },
  "tool_use",
)

/**
 * Runs `use` with the daemon and a runner job in the run directory of a runner; then the job's
 * release step (`runner.sh stop`) and the removal of the run directory.
 */
async function withBoxJob(use: Parameters<typeof withRunnerDaemon>[1]) {
  await step("run directory", async () =>
    run("run directory", [
      "sudo",
      "install",
      "-d",
      "-o",
      String(process.getuid!()),
      "-g",
      String(process.getgid!()),
      "-m",
      "700",
      directory,
    ]),
  )
  try {
    await withRunnerDaemon({ directory, image }, use)
  } finally {
    // The job's release step: the box, its network and its rules; then the run directory.
    Bun.spawnSync(["bash", "deploy/sandbox/runner.sh", "stop"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    Bun.spawnSync(["sudo", "rm", "-rf", directory])
  }
}

/**
 * Runs `use` with the daemon, its production workers, and a runner job of this repository's
 * source that `start` runs; then the job's release step (`runner.sh stop`), the run directory and
 * the tooling that the job's private first contact installed.
 */
async function withTrialJob(
  start: NonNullable<Parameters<typeof withRunnerDaemon>[0]["start"]>,
  use: Parameters<typeof withRunnerDaemon>[1],
) {
  try {
    await withRunnerDaemon(
      {
        directory,
        image,
        source: resolve(import.meta.dir, "../.."),
        start,
        productionWorkers: true,
      },
      use,
    )
  } finally {
    Bun.spawnSync(["bash", "deploy/sandbox/runner.sh", "stop"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    Bun.spawnSync([
      "sudo",
      "rm",
      "-rf",
      directory,
      "/usr/local/lib/workflowd-sandbox",
      "/usr/local/bin/runner-control",
      "/usr/local/bin/container-use",
    ])
  }
}

/** Whether the process `pid` is alive. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The ids of the containers, or of the volumes, that carry the label of a run's box. */
const boxed = (kind: "container" | "volume") =>
  run("boxes", [
    "docker",
    ...(kind === "container" ? ["ps", "-aq"] : ["volume", "ls", "-q"]),
    "--filter",
    "label=io.workflowd.native",
  ])

test("a runner run on the real runner scripts runs the pinned Claude Code in the box and reaches agent-run/<id> and the caller's mailbox", async () => {
  await step("image", async () => {
    if (!/^ghcr\.io\/bnasraoui\/workflowd-agent-base@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error("WORKFLOWD_RUNNER_IMAGE names no image by its digest")
  })
  // The image's Claude Code is the one from which the gateway's anthropic-beta list is recorded.
  expect(
    await step("pin", async () =>
      run("pin", [
        "docker",
        "run",
        "--rm",
        "--pull=never",
        "--entrypoint",
        "/bin/claude",
        image,
        "--version",
      ]),
    ),
  ).toBe(pinned)
  await withBoxJob(async ({ f, runtime, remote, jobEnded, github, leaseId, record }) => {
    f.onUpstream(async (request) => {
      const path = new URL(request.url).pathname
      const body = await request.clone().text()
      if (path.endsWith("/count_tokens")) f.setAnswerJson('{"input_tokens":10}')
      else if (body.includes('"tool_result"')) f.setAnswerText(text("Runner run done."))
      else if (body.includes('"name":"Write"')) f.setAnswerText(write)
      else f.setAnswerText(text("ok"))
    })
    // GitHub reports the Actions run completed once its job ended. The dispatch returns once the
    // run's first model output arrived; a job that ends first, with none, ends the run and fails
    // this step with the job's record.
    void jobEnded().then(
      () => github.endRun(leaseId()),
      () => github.endRun(leaseId(), "failure"),
    )
    const receipt = await step(
      "dispatch",
      () =>
        runtime.runPromise(
          Effect.flatMap(AgentRunIngress, (ingress) =>
            ingress.register(
              { route: "claude", repository: "runner", prompt: "Write the proof file." },
              new Date(),
            ),
          ),
        ),
      record,
      360000,
    )
    await step("job", jobEnded, record, 300000)
    // The job's hold step ends well: the run client posted the run's result.
    const hold = await step(
      "hold",
      async (): Promise<unknown> =>
        JSON.parse(
          run("hold", [
            fixtureExecutable("node"),
            "deploy/sandbox/public-output.mjs",
            "audit",
            "--",
            "bash",
            "deploy/sandbox/runner.sh",
            "hold",
          ]),
        ),
      record,
    )
    expect(hold).toMatchObject({ outcome: "ok", reason: "none" })
    const runs = await runtime.runPromise(AgentRunStore)
    const ended = await step(
      "run end",
      async () => {
        for (let tries = 0; tries < 1200; tries++) {
          const current = await runtime.runPromise(runs.read(receipt.runId))
          if (current !== null && !["spawning", "spawned", "verified"].includes(current.state))
            return current
          await Bun.sleep(100)
        }
        throw new Error("the run did not end")
      },
      record,
    )
    expect({ state: ended.state, diagnostic: ended.diagnostic }).toEqual({
      state: "completed",
      diagnostic: null,
    })
    // The model calls went through the box, the relay and the gateway, with listed betas only.
    const calls = f.upstreamRequests().filter((call) => call.path.startsWith("/v1/messages"))
    expect(calls.length).toBeGreaterThanOrEqual(2)
    const betas = calls.flatMap((call) =>
      (call.headers["anthropic-beta"] ?? "").split(",").map((value) => value.trim()),
    )
    expect(betas.filter((value) => value !== "" && !claudeBetas.has(value))).toEqual([])
    const branch = `refs/heads/agent-run/${receipt.runId.replace(/^agent-run-/, "").slice(0, 16)}`
    const pushed = await step("branch", async () => {
      const sha = remote.ref(branch)
      if (sha === null) throw new Error(`${branch} is not in the remote`)
      return sha
    })
    expect(run("branch", ["git", "-C", remote.bare, "rev-parse", `${pushed}^`])).toBe(
      remote.sourceSha,
    )
    expect(run("branch", ["git", "-C", remote.bare, "show", `${pushed}:runner-proof.txt`])).toBe(
      proofText.trim(),
    )
    const messages = await runtime.runPromise(mailbox(receipt.runId))
    expect(messages.map((entry) => entry.id)).toEqual([`agent-run-end-${receipt.runId}`])
    expect(messages[0]?.message).toMatchObject({
      run_id: receipt.runId,
      route: "claude",
      model: runnerModel,
      executor: "claude",
      status: "completed",
      end_reason: "completed",
      final_message: "Runner run done.",
      placement: "runner",
    })
  })
}, 900000)

test("a stop of a runner run while Claude Code's model stream is open in the box ends the run cancelled, and no box, volume or process of it stays", async () => {
  await withBoxJob(async ({ f, runtime, jobEnded, record, runClient }) => {
    f.onUpstream(async (request) => {
      const path = new URL(request.url).pathname
      const body = await request.clone().text()
      if (path.endsWith("/count_tokens")) f.setAnswerJson('{"input_tokens":10}')
      // The turn after the tool's result stays open until the gateway ends it.
      else if (body.includes('"tool_result"')) f.holdStream()
      else if (body.includes('"name":"Write"')) f.setAnswerText(write)
      else f.setAnswerText(text("ok"))
    })
    const receipt = await step(
      "dispatch",
      () =>
        runtime.runPromise(
          Effect.flatMap(AgentRunIngress, (ingress) =>
            ingress.register(
              { route: "claude", repository: "runner", prompt: "Write the proof file." },
              new Date(),
            ),
          ),
        ),
      record,
      360000,
    )
    await step(
      "held stream",
      async () => {
        while (!f.upstreamRequests().some((call) => call.body.includes('"tool_result"')))
          await Bun.sleep(100)
      },
      record,
      300000,
    )
    const stoppedAt = Date.now()
    await step("stop", () =>
      runtime.runPromise(
        Effect.flatMap(AgentRunIngress, (ingress) => ingress.cancel(receipt.runId, new Date())),
      ),
    )
    // The run client ends its harness, which removes the box, then ends itself.
    await step("job", jobEnded, record, 120000)
    const endedAt = Date.now()
    expect(f.heldCancels().length).toBeGreaterThanOrEqual(1)
    expect(f.heldCancels()[0]! - stoppedAt).toBeLessThan(5000)
    const runs = await runtime.runPromise(AgentRunStore)
    const ended = await runtime.runPromise(runs.read(receipt.runId))
    expect({ state: ended?.state, diagnostic: ended?.diagnostic }).toEqual({
      state: "cancelled",
      diagnostic: "cancelled",
    })
    expect((await runtime.runPromise(mailbox(receipt.runId))).length).toBe(1)
    // Before the job's release step: no box, no volume, no run client.
    expect(boxed("container")).toBe("")
    expect(boxed("volume")).toBe("")
    const pid = await runClient()
    expect(pid === undefined ? false : alive(pid)).toBe(false)
    expect(endedAt - stoppedAt).toBeLessThan(120000)
  })
}, 900000)

/** The variables of the repository that the caller workflow reads, as the owner sets them. */
const trialVars = (gateway: string, agentImage = image): Readonly<Record<string, string>> => ({
  SANDBOX_AGENT_IMAGE: agentImage,
  SANDBOX_BOOTSTRAP_MODE: "private",
  SANDBOX_GATEWAY_URL: gateway,
  TS_AGENT_CLIENT_ID: "fixture-client",
  TS_AGENT_AUDIENCE: "fixture-audience",
})
/** The lease push of the trial: the fixture's workflow commit, on the fixture repository. */
const trialPush = (leaseId: string) => ({
  leaseId,
  sha: "a".repeat(40),
  repository: "fixture/repo",
})
const repositoryRoot = resolve(import.meta.dir, "../..")

/**
 * The parts of the job that cannot run in a test, each with its reason. The test checks the
 * values that the workflow gives each one, and covers what is on each side of it.
 */
const handOver = {
  // The Actions runtime's checkout. The tooling is this checkout's deploy/sandbox, at its head.
  "Check out pinned tooling": (job: JobStep) => {
    expect(job.with.ref).toBe(trialPush("").sha)
    expect(job.with["sparse-checkout"]).toBe("deploy/sandbox")
  },
  // tailscale.sh joins the tailnet with the federation of Tailscale and the runner's tag; the
  // test host has no tailnet and no Tailscale Service. workflow.test.ts runs its enrollment with
  // these values; here the runner reaches the gateway's front on loopback, as through the Service.
  "Join the restricted tailnet": (job: JobStep) => {
    expect(job.env).toEqual({
      SANDBOX_TAILSCALE_CLIENT_ID: "fixture-client",
      SANDBOX_AUDIENCE: "fixture-audience",
      SANDBOX_BOOTSTRAP_MODE: "private",
    })
  },
  // It logs out of the tailnet and stops the tailscaled unit, which the test host does not have.
  // Its first command, runner.sh stop, runs in the test's own cleanup.
  "Release disposable containers": (job: JobStep) => {
    expect(job.run).toContain("bash deploy/sandbox/runner.sh stop")
  },
}

test("a trial run: a lease push of this repository's source runs the private-mode steps that the caller workflow gives, and the daemon with its production workers checks the sealed result of a one-line change and pushes agent-run/<id>", async () => {
  // The workflow first, with no gateway yet: the caller selects private mode, gives each input
  // that a step that runs reads, and no step uploads an artifact.
  const planned = await step("workflow", () =>
    runnerJob(
      trialPush("trial"),
      // The image is the job's own; a placeholder of its form until the image step reads it.
      trialVars(
        "https://gateway.example.invalid",
        `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"0".repeat(64)}`,
      ),
    ),
  )
  expect(planned.inputs["bootstrap-mode"]).toBe("private")
  // Each variable that the private first contact reads, other than those that the runner gives
  // (GITHUB_*, ACTIONS_*, RUNNER_*) and the optional trust root, comes from the step's own values.
  const reads = new Set(
    [
      ...(await Bun.file(`${repositoryRoot}/deploy/sandbox/bootstrap.mjs`).text()).matchAll(
        /environment\.([A-Z][A-Z0-9_]*)/g,
      ),
    ]
      .map((match) => match[1] ?? "")
      .filter(
        (name) => !/^(?:GITHUB|ACTIONS|RUNNER)_/.test(name) && name !== "NODE_EXTRA_CA_CERTS",
      ),
  )
  const firstContact = planned.steps.find((entry) => entry.run?.includes("prepare-private"))
  expect([...reads].filter((name) => firstContact?.env[name] === undefined)).toEqual([])
  expect(
    planned.steps.filter((entry) => entry.uses?.startsWith("actions/upload-artifact@")),
  ).toEqual([])
  await step("image", async () => {
    if (!/^ghcr\.io\/bnasraoui\/workflowd-agent-base@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error("WORKFLOWD_RUNNER_IMAGE names no image by its digest")
  })
  const scripts = await mkdtemp(join(tmpdir(), "wfd-trial-steps-"))
  // Test only: the runner's OIDC endpoint is GitHub's; here, the fixture issuer of the gateway.
  const identity = join(scripts, "oidc-endpoint.mjs")
  const ran: Array<string> = []
  const start = async ({ leaseId, issuer, f }: { leaseId: string; issuer: string; f: Fixture }) => {
    await writeFile(
      identity,
      `const real = globalThis.fetch
globalThis.fetch = (url, init) => {
  const target = new URL(String(url))
  return target.hostname.endsWith(".actions.githubusercontent.com")
    ? real(${JSON.stringify(issuer)} + target.search, init)
    : real(url, init)
}
`,
    )
    const job = await runnerJob(trialPush(leaseId), trialVars(f.front.origin))
    const push = trialPush(leaseId)
    const base: Record<string, string> = {
      PATH: `${dirname(fixtureExecutable("node"))}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: process.env.HOME ?? "/home/runner",
      GITHUB_REF: `refs/heads/workflowd/leases/${leaseId}`,
      GITHUB_SHA: push.sha,
      GITHUB_REPOSITORY: push.repository,
      GITHUB_RUN_ID: "79",
      GITHUB_RUN_ATTEMPT: "1",
      // The runner gives a step the OIDC request authority only when the job grants it.
      ...((await grantsJobIdentity())
        ? {
            ACTIONS_ID_TOKEN_REQUEST_URL:
              "https://fixture.actions.githubusercontent.com/token?api-version=2",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request",
          }
        : {}),
      // Test only: the gateway's front has the fixture's certificate, and the OIDC endpoint is
      // the fixture's. On a runner the Service has a public certificate.
      NODE_EXTRA_CA_CERTS: f.tls.cert,
      NODE_OPTIONS: `--import=${identity}`,
    }
    ran.push(...(await runSteps(job.steps, { cwd: repositoryRoot, base, scripts, handOver })))
  }
  try {
    await withTrialJob(start, async ({ f, runtime, remote, jobEnded, github, leaseId, record }) => {
      f.onUpstream(async (request) => {
        const path = new URL(request.url).pathname
        const body = await request.clone().text()
        if (path.endsWith("/count_tokens")) f.setAnswerJson('{"input_tokens":10}')
        else if (body.includes('"tool_result"')) f.setAnswerText(text("Runner run done."))
        else if (body.includes('"name":"Write"')) f.setAnswerText(write)
        else f.setAnswerText(text("ok"))
      })
      void jobEnded().then(
        () => github.endRun(leaseId()),
        () => github.endRun(leaseId(), "failure"),
      )
      const receipt = await step(
        "dispatch",
        () =>
          runtime.runPromise(
            Effect.flatMap(AgentRunIngress, (ingress) =>
              ingress.register(
                { route: "claude", repository: "runner", prompt: "Write the proof file." },
                new Date(),
              ),
            ),
          ),
        record,
        360000,
      )
      await step("job", jobEnded, record, 300000)
      // The job ran each step of private mode that a test can run, the hold to its good end.
      expect(ran).toEqual(
        planned.steps.map((entry) => entry.name).filter((name) => !Object.hasOwn(handOver, name)),
      )
      expect(ran.at(-1)).toBe("Hold the lease")
      const runs = await runtime.runPromise(AgentRunStore)
      const ended = await step(
        "run end",
        async () => {
          for (let tries = 0; tries < 1200; tries++) {
            const current = await runtime.runPromise(runs.read(receipt.runId))
            if (current !== null && !["spawning", "spawned", "verified"].includes(current.state))
              return current
            await Bun.sleep(100)
          }
          throw new Error("the run did not end")
        },
        record,
      )
      expect({ state: ended.state, diagnostic: ended.diagnostic }).toEqual({
        state: "completed",
        diagnostic: null,
      })
      // The source is this repository's head; the branch is one commit on it, of one line.
      expect(remote.sourceSha).toBe(run("head", ["git", "-C", repositoryRoot, "rev-parse", "HEAD"]))
      const branch = `refs/heads/agent-run/${receipt.runId.replace(/^agent-run-/, "").slice(0, 16)}`
      const pushed = await step("branch", async () => {
        const sha = remote.ref(branch)
        if (sha === null) throw new Error(`${branch} is not in the remote`)
        return sha
      })
      expect(run("branch", ["git", "-C", remote.bare, "rev-parse", `${pushed}^`])).toBe(
        remote.sourceSha,
      )
      expect(
        run("branch", ["git", "-C", remote.bare, "diff", "--numstat", remote.sourceSha, pushed]),
      ).toBe("1\t0\trunner-proof.txt")
      const messages = await runtime.runPromise(mailbox(receipt.runId))
      expect(messages[0]?.message).toMatchObject({
        run_id: receipt.runId,
        status: "completed",
        end_reason: "completed",
        placement: "runner",
      })
      // No worker of the production start failed on the runner run.
      expect(runtime.logs().filter((line) => line.startsWith("Error"))).toEqual([])
    })
  } finally {
    await rm(scripts, { recursive: true, force: true })
  }
}, 900000)
