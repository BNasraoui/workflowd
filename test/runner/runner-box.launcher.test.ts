import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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
