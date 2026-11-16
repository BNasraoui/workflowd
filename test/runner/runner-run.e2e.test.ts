import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Stream } from "effect"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import {
  client,
  gatewaySource,
  proof,
  startGatewayProcess,
  withGateway,
  type Fixture,
  type Gateway,
} from "../capability-gateway/gateway-process"
import { runnerKey } from "../capability-gateway/gateway-process"
import { controlClient, liveGrants } from "../../src/sandbox/capability-control"
import { defaultRunBudget } from "../../src/sandbox/config"
import { makeRunnerExecutor } from "../../src/kernel/runner-executor"
import { AgentRunIngress } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import {
  mailbox,
  run,
  runnerModel,
  step,
  withRunnerDaemon,
  writeHarness,
  sealedReply,
  writeSealingHarness,
} from "./fixture"

const image = `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"b".repeat(64)}`

/** Runs git in `directory` and gives its standard output, trimmed. */
const git = (directory: string, ...args: ReadonlyArray<string>) => {
  const run = Bun.spawnSync(["git", "-C", directory, ...args], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  })
  if (run.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.toString()}`)
  return run.stdout.toString().trim()
}

/** A sealed result as the seal makes it: one commit on the source, as a bundle of one ref. */
async function sealedResult(directory: string) {
  await mkdir(directory)
  git(directory, "init", "--quiet", "-b", "main")
  await Bun.write(join(directory, "a.txt"), "source\n")
  git(directory, "add", "a.txt")
  git(directory, "commit", "--quiet", "-m", "Source")
  const source = git(directory, "rev-parse", "HEAD")
  await Bun.write(join(directory, "a.txt"), "result\n")
  git(directory, "commit", "--quiet", "-am", "Change the file")
  git(directory, "update-ref", "refs/workflowd/result", "HEAD")
  git(
    directory,
    "bundle",
    "create",
    "--quiet",
    "result.bundle",
    `^${source}`,
    "refs/workflowd/result",
  )
  return {
    source,
    manifest: JSON.stringify({
      sourceSha: source,
      title: "Change the file",
      body: "One file changed.",
      finalMessage: "Done.",
    }),
    bundle: await readFile(join(directory, "result.bundle")),
  }
}

/**
 * The real gateway process; once it listens, workflowd's side grants the fixture run with its
 * launch, as it grants each run of a runner placement from its first grant on.
 */
async function runnerGateway(f: Fixture): Promise<Gateway> {
  const gateway = await startGatewayProcess(
    [process.execPath, "-e", gatewaySource(f)],
    f.env,
    f.front,
  )
  await f
    .store(
      Effect.flatMap(
        liveGrants(null, Date.now(), defaultRunBudget, {
          aliases: ["fixture"],
          identity: { name: "Fixture Agent", email: "agent@example.invalid" },
        }),
        (live) => controlClient(f.config.controlSocket).reconcile(live),
      ),
    )
    .catch(async (error: unknown) => {
      await gateway.stop()
      throw error
    })
  return gateway
}

/** The daemon's executor of the runner placement, on the fixture gateway's control socket. */
const executorOf = (f: Fixture) => {
  const control = controlClient(f.config.controlSocket)
  return makeRunnerExecutor({
    gateway: {
      readEvents: control.readEvents,
      readResult: control.readResult,
      revoke: control.revoke,
    },
    maxRuns: 1,
    begin: () => Effect.void,
  })
}

/**
 * Opens the runner's session, then runs the real run client with the real relay in `root`, with
 * the fixture harness. Resolves to the run client's exit code and its standard error.
 */
async function runClient(
  f: Fixture,
  gateway: Parameters<typeof client>[0],
  root: string,
  harness: string,
) {
  const runner = client(gateway)
  const { audience, channel } = await runner.audience()
  const grant = await runner.grant(await runner.session(proof(audience, "jti-runner-run")))
  await Bun.write(join(root, "agent-image"), image)
  const child = Bun.spawn(
    [
      fixtureExecutable("node"),
      resolve("deploy/sandbox/run-client.mjs"),
      "runner",
      root,
      "--",
      fixtureExecutable("node"),
      harness,
    ],
    {
      env: { PATH: "/usr/bin:/bin", HOME: root, NODE_EXTRA_CA_CERTS: f.tls.cert },
      stdin: new Blob([
        JSON.stringify({
          ...grant,
          channel,
          sessionKey: runnerKey.privateKey,
          gateway: f.front.origin,
        }),
      ]),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const code = await child.exited
    return {
      code,
      stderr: await new Response(child.stderr).text(),
      stdout: await new Response(child.stdout).text(),
    }
  } finally {
    child.kill("SIGKILL")
  }
}

test("a runner run's launch, events and sealed result go from the run client through the gateway to the daemon's executor", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-run-"))
  try {
    const result = await sealedResult(join(root, "source"))
    const harness = await writeHarness(root, result, { extraLines: 80 })
    await withGateway(runnerGateway, async (f, gateway) => {
      const run = await runClient(f, gateway, root, harness)
      expect({ step: "run client", code: run.code, stderr: run.stderr }).toEqual({
        step: "run client",
        code: 0,
        stderr: "",
      })
      expect(run.stdout).toBe("ready\n")
      const executor = executorOf(f)
      const handle = await Effect.runPromise(
        executor.start({
          runId: "run",
          repository: "fixture",
          imageDigest: image,
          sourceSha: "d".repeat(40),
          prompt: "fixture",
          model: "fixture-model",
          deadline: new Date(Date.now() + 60000),
        }),
      )
      const events = await Effect.runPromise(Stream.runCollect(executor.events(handle)))
      // The launch reached the harness: its model, its prompt and its source commit.
      expect(events[0]).toEqual({
        type: "thread.started",
        threadId: "fixture-session",
        model: "fixture-model",
      })
      expect(events).toContainEqual({
        type: "agent_message",
        text: `prompt: fixture at ${"d".repeat(40)}`,
      })
      expect(events.at(-1)).toEqual({ type: "turn.completed", outputTokens: null })
      // The 80 long lines went in more than one numbered batch, none lost.
      expect(events.length).toBe(83)
      const sealed = await Effect.runPromise(executor.result(handle))
      expect({
        sourceSha: sealed.sourceSha,
        title: sealed.title,
        finalMessage: sealed.finalMessage,
        bundle: Buffer.from(sealed.bundle).equals(result.bundle),
      }).toEqual({
        sourceSha: result.source,
        title: "Change the file",
        finalMessage: "Done.",
        bundle: true,
      })
      // The run routes cost the run no call.
      expect(
        await f.gatewaySql((sql) => sql`SELECT calls FROM capability_usage WHERE run_id='run'`),
      ).toEqual([{ calls: 0 }])
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60000)

test("a run client whose harness fails posts no result, and the daemon's executor sees none", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-run-"))
  try {
    const harness = await writeHarness(root, null, { exitCode: 3 })
    await withGateway(runnerGateway, async (f, gateway) => {
      const run = await runClient(f, gateway, root, harness)
      expect({ step: "run client", code: run.code, stderr: run.stderr }).toEqual({
        step: "run client",
        code: 1,
        stderr: "run client failed\n",
      })
      const control = controlClient(f.config.controlSocket)
      const read = await Effect.runPromise(control.readEvents("run", 0))
      expect({ result: read.result, ended: read.ended, batches: read.batches.length > 0 }).toEqual({
        result: false,
        ended: null,
        batches: true,
      })
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60000)

test("a run client refuses a launch whose image is not its job's own, and runs no harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-run-"))
  try {
    const harness = await writeHarness(root, null)
    await withGateway(runnerGateway, async (f, gateway) => {
      const runner = client(gateway)
      const { audience, channel } = await runner.audience()
      const grant = await runner.grant(await runner.session(proof(audience, "jti-image")))
      await Bun.write(join(root, "agent-image"), image.replace("b".repeat(64), "c".repeat(64)))
      const child = Bun.spawn(
        [
          fixtureExecutable("node"),
          resolve("deploy/sandbox/run-client.mjs"),
          "runner",
          root,
          "--",
          fixtureExecutable("node"),
          harness,
        ],
        {
          env: { PATH: "/usr/bin:/bin", HOME: root, NODE_EXTRA_CA_CERTS: f.tls.cert },
          stdin: new Blob([
            JSON.stringify({
              ...grant,
              channel,
              sessionKey: runnerKey.privateKey,
              gateway: f.front.origin,
            }),
          ]),
          stdout: "ignore",
          stderr: "ignore",
        },
      )
      expect(await child.exited).toBe(1)
      const read = await Effect.runPromise(
        controlClient(f.config.controlSocket).readEvents("run", 0),
      )
      expect(read.batches).toEqual([])
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60000)

test("a runner dispatch goes from the ingress through the lease, the job's session, the run client and the gateway to agent-run/<id> and the caller's mailbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runner-job-"))
  try {
    await withRunnerDaemon(
      {
        directory,
        image,
        harness: async (bare) => [
          fixtureExecutable("node"),
          await writeSealingHarness(await mkdtemp(join(directory, "harness-")), bare),
        ],
      },
      async ({ runtime, remote, jobEnded }) => {
        const receipt = await step("dispatch", () =>
          runtime.runPromise(
            Effect.flatMap(AgentRunIngress, (ingress) =>
              ingress.register(
                { route: "claude", repository: "runner", prompt: "Write the proof file." },
                new Date(),
              ),
            ),
          ),
        )
        await step("job", jobEnded)
        const runs = await runtime.runPromise(AgentRunStore)
        const ended = await step("run end", async () => {
          for (let tries = 0; tries < 600; tries++) {
            const current = await runtime.runPromise(runs.read(receipt.runId))
            if (current !== null && !["spawning", "spawned", "verified"].includes(current.state))
              return current
            await Bun.sleep(100)
          }
          throw new Error("the run did not end")
        })
        expect({ state: ended.state, diagnostic: ended.diagnostic }).toEqual({
          state: "completed",
          diagnostic: null,
        })
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
          run("branch", ["git", "-C", remote.bare, "show", `${pushed}:runner-proof.txt`]),
        ).toBe("written by the runner run")
        const messages = await runtime.runPromise(mailbox(receipt.runId))
        expect(messages.map((entry) => entry.id)).toEqual([`agent-run-end-${receipt.runId}`])
        expect(messages[0]?.message).toEqual({
          run_id: receipt.runId,
          session_id: expect.any(String),
          native_session_id: "fixture-session",
          route: "claude",
          model: runnerModel,
          executor: "claude",
          status: "completed",
          end_reason: "completed",
          ended_at: expect.any(String),
          final_message: sealedReply,
          final_message_ref: null,
          placement: "runner",
        })
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)
