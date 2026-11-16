import { expect, setSystemTime, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Fiber } from "effect"
import { boxReadyLine } from "../../deploy/sandbox/box-ready.mjs"
import { AgentRunIngress, agentRunIdentifiers } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { controlClient, liveGrants } from "../../src/sandbox/capability-control"
import { defaultRunBudget } from "../../src/sandbox/config"
import { client } from "../capability-gateway/gateway-process"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import {
  boxReadyModule,
  workspaceArchiveModule,
  daemonRuntime,
  githubStub,
  gitRemote,
  mailbox,
  runnerIdentity,
  runnerModel,
  runnerPolicy,
  step,
  withRunnerDaemon,
  type RunnerControl,
} from "./fixture"

/**
 * The ends of a runner run other than its result: its stop, its deadline, a lost runner, and an
 * Actions run that GitHub ends cancelled or failed; also a run that changed nothing. Each gives
 * the caller exactly one terminal message, also when two causes come at one read. After each end
 * the gateway holds no run, the Actions run is cancelled, the lease ref is gone and the job's run
 * client has ended. The cases with the real gateway process run the real run client and a
 * harness in place of the box; the cases of two causes at one read script the gateway.
 */

const image = `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"b".repeat(64)}`
const submission = { route: "claude", repository: "runner", prompt: "Write the proof file." }
const runId = agentRunIdentifiers({
  ...submission,
  parentSessionId: null,
  resumePrompt: null,
}).runId
/** The Actions run of the fixture's lease ref. */
const actionsRunId = 79

/** Waits until `ready` gives a value other than undefined, each 50 ms, within `limitMs`. */
async function until<A>(name: string, ready: () => Promise<A | undefined> | A | undefined) {
  return step(
    name,
    async () => {
      for (;;) {
        const value = await ready()
        if (value !== undefined) return value
        await Bun.sleep(50)
      }
    },
    undefined,
    60000,
  )
}

/**
 * The harness of the run client in place of the box. It records its pid and, at SIGTERM, the
 * time, in files `fixture-<name>` of the run directory, and writes Claude's first two lines. Then by
 * `mode`: `stream` makes a model call through the relay, records when its stream ended and the
 * answer of one more call, and writes a line; `quiet` writes nothing more; `unchanged` takes the
 * source from the fixture remote `bare`, changes nothing and seals it with the harness's own seal,
 * which leaves a completion with no bundle. `stream` and `quiet` then wait.
 */
async function writeEndingHarness(
  directory: string,
  mode: "stream" | "quiet" | "unchanged",
  bare: string,
) {
  const path = join(directory, `ending-${mode}.mjs`)
  await writeFile(
    path,
    `import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { sealRun } from ${JSON.stringify(resolve("deploy/sandbox/native-seal.mjs"))}
import { directoryArchive } from ${JSON.stringify(workspaceArchiveModule)}
import { boxReadyLine } from ${JSON.stringify(boxReadyModule)}
const launch = JSON.parse(readFileSync(0, "utf8"))
const directory = process.env.WORKFLOWD_RUN_DIRECTORY
const record = (name, value) => writeFileSync(directory + "/fixture-" + name, String(value))
record("pid", process.pid)
process.on("SIGTERM", () => {
  record("terminated", Date.now())
  process.exit(143)
})
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
process.stdout.write(boxReadyLine + "\\n")
line({ type: "system", subtype: "init", session_id: "fixture-session", model: launch.model })
// The first model output, which the dispatch waits for.
line({ type: "assistant", message: { content: [{ type: "text", text: "Working." }] } })
const call = () =>
  new Promise((resolve) => {
    const body = JSON.stringify({ model: launch.model, stream: true, messages: [], max_tokens: 100 })
    const sent = request(
      {
        socketPath: directory + "/gateway.sock",
        path: "/v1/messages",
        method: "POST",
        headers: {
          authorization: "Bearer workflowd-local",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (answer) => {
        let text = ""
        answer.on("data", (bytes) => (text += bytes))
        answer.on("error", () => undefined)
        answer.on("close", () => resolve({ status: answer.statusCode, text }))
      },
    )
    sent.on("error", () => resolve({ status: 0, text: "" }))
    sent.end(body)
  })
if (${mode === "stream"}) {
  await call()
  record("stream-ended", Date.now())
  record("after", JSON.stringify(await call()))
  line({ type: "assistant", message: { content: [{ type: "text", text: "after the stop" }] } })
}
if (${mode === "unchanged"}) {
  line({ type: "assistant", message: { content: [{ type: "text", text: "Nothing to change." }] } })
  line({ type: "result", subtype: "success", is_error: false, result: "Nothing to change." })
  const native = directory + "/native"
  const env = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
  const run = (argv) => execFileSync(argv[0], argv.slice(1), { cwd: native, env, encoding: "utf8" })
  mkdirSync(native + "/workspace", { recursive: true })
  run(["git", "init", "--quiet", "--bare", "source.git"])
  run(["git", "-C", "source.git", "fetch", "--quiet", "--no-tags", ${JSON.stringify(bare)}, launch.sourceSha])
  run(["sh", "-c", 'git -C source.git archive "$1" | tar -x -C workspace', "sh", launch.sourceSha])
  await sealRun({ directory, native, sourceSha: launch.sourceSha, identity: launch.identity, reply: "Nothing to change.", workspace: () => directoryArchive(native + "/workspace") })
} else setInterval(() => undefined, 60000)
`,
  )
  return [fixtureExecutable("node"), path]
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

/** The pid that the harness recorded, if it started. */
const harnessPid = (directory: string) =>
  readFile(join(directory, "fixture-pid"), "utf8").then(Number, () => undefined)

type Daemon = Parameters<Parameters<typeof withRunnerDaemon>[1]>[0]

/** Registers the run with the daemon and gives its id once its first event is read. */
const dispatch = async (daemon: Daemon) =>
  (
    await step("dispatch", () =>
      daemon.runtime.runPromise(
        Effect.flatMap(AgentRunIngress, (ingress) => ingress.register(submission, new Date())),
      ),
    )
  ).runId

/** The run's record once it ended, and its messages to the caller. */
async function ended(runtime: Daemon["runtime"], id: string) {
  const runs = await runtime.runPromise(AgentRunStore)
  const run = await until("run end", async () => {
    const current = await runtime.runPromise(runs.read(id))
    return current !== null && !["spawning", "spawned", "verified"].includes(current.state)
      ? current
      : undefined
  })
  return { run, messages: await runtime.runPromise(mailbox(id)) }
}

/**
 * What every end leaves, once the run ended: the Actions run cancelled (asked once, or not at
 * all when GitHub ended it first), no lease ref once the daemon's reconcile sees the Actions run
 * completed, and a gateway whose answer for the run's session is that of a lease it never knew.
 */
async function released(daemon: Daemon, jobEnded: boolean) {
  await until("lease ref removed", async () => {
    if (daemon.github.leaseRefs().length === 0) return true
    await daemon.runtime.runPromise(daemon.runtime.cleanup(daemon.leaseId()))
    return undefined
  })
  // The release and the daemon's reconcile, which runs beside it, may each ask the cancel of the
  // Actions run; each asks it of that run alone.
  if (!jobEnded) expect(new Set(daemon.github.cancels())).toEqual(new Set([actionsRunId]))
  // The gateway's answer for the run's session: a revoked binding answers as an unknown lease.
  const bound = (lease: string) =>
    Effect.runPromise(
      controlClient(daemon.f.config.controlSocket)
        .sessionBound(lease, actionsRunId, 1)
        .pipe(Effect.catch((error) => Effect.succeed(error._tag))),
    )
  await until("gateway revoke", async () =>
    (await bound(daemon.leaseId())) === true ? undefined : true,
  )
  expect(await bound(daemon.leaseId())).toEqual(await bound("agent-run-never-granted"))
}

/** Ends what a case's job left: the run client and the harness, which a real job's end ends. */
async function endJob(daemon: Daemon, directory: string) {
  for (const pid of [await daemon.runClient(), await harnessPid(directory)])
    if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL")
}

/** Runs `use` with the daemon of a runner job whose harness runs in `mode`. */
async function withEnding<A>(
  mode: "stream" | "quiet" | "unchanged",
  use: (daemon: Daemon, directory: string) => Promise<A>,
) {
  const directory = await mkdtemp(join(tmpdir(), "runner-ending-"))
  try {
    return await withRunnerDaemon(
      {
        directory,
        image,
        harness: (bare) => writeEndingHarness(directory, mode, bare),
      },
      async (daemon) => {
        try {
          return await use(daemon, directory)
        } finally {
          await endJob(daemon, directory)
        }
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const stoppedMessage = (id: string) => ({
  run_id: id,
  session_id: expect.any(String),
  native_session_id: "fixture-session",
  route: "claude",
  model: runnerModel,
  executor: "claude",
  status: "cancelled",
  end_reason: "cancelled",
  ended_at: expect.any(String),
  final_message: null,
  final_message_ref: "fixture-session",
  placement: "runner",
})

test("stop during an open model stream: the gateway closes its upstream call and the runner's stream ends within 5 s, the run ends cancelled", async () => {
  await withEnding("stream", async (daemon, directory) => {
    daemon.f.holdStream()
    const id = await dispatch(daemon)
    await until("model stream open", () =>
      daemon.f.upstreamRequests().length > 0 ? true : undefined,
    )
    const stoppedAt = Date.now()
    await step("stop", () =>
      daemon.runtime.runPromise(
        Effect.flatMap(AgentRunIngress, (ingress) => ingress.cancel(id, new Date())),
      ),
    )
    const end = await ended(daemon.runtime, id)
    expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
      state: "cancelled",
      diagnostic: "cancelled",
    })
    expect(end.messages.map((entry) => entry.message)).toEqual([stoppedMessage(id)])
    // The recorded times: the gateway cancelled its upstream answer, and the runner's stream
    // ended, each within 5 s of the stop.
    const streamEnded = Number(
      await until("runner stream end", () =>
        readFile(join(directory, "fixture-stream-ended"), "utf8").catch(() => undefined),
      ),
    )
    expect(daemon.f.heldCancels().length).toBe(1)
    for (const at of [daemon.f.heldCancels()[0]!, streamEnded]) {
      expect(at).toBeGreaterThanOrEqual(stoppedAt)
      expect(at - stoppedAt).toBeLessThan(5000)
    }
    // The run's token, used after the stop, gets the answer of a token that the gateway never
    // issued.
    const after: unknown = JSON.parse(
      await until("call after the stop", () =>
        readFile(join(directory, "fixture-after"), "utf8").catch(() => undefined),
      ),
    )
    const unknown = await client(daemon.f.front).call("A".repeat(43))
    expect(unknown.status).toBe(403)
    expect(after).toEqual({ status: unknown.status, text: await unknown.text() })
    // The refused batch ends the harness by SIGTERM, then the run client: no process stays.
    await step("job end", daemon.jobEnded, undefined, 60000)
    expect(await readFile(join(directory, "fixture-terminated"), "utf8")).toMatch(/^\d+$/)
    expect(alive((await harnessPid(directory))!)).toBe(false)
    await released(daemon, false)
    // The call after the stop reached no model: the gateway refused its token first.
    expect(daemon.f.upstreamRequests().length).toBe(1)
  })
}, 90000)

test("a runner whose posts stop while its Actions run goes on ends runner_lost, and the cancel of its Actions run that follows adds no message", async () => {
  await withEnding("quiet", async (daemon, directory) => {
    const id = await dispatch(daemon)
    // The runner is lost: its run client and its harness end with no word, and two minutes
    // pass.
    await endJob(daemon, directory)
    let end: Awaited<ReturnType<typeof ended>>
    try {
      setSystemTime(new Date(Date.now() + 120000))
      end = await ended(daemon.runtime, id)
    } finally {
      setSystemTime()
    }
    expect(end.run.state).toBe("operator_required")
    expect(end.run.diagnostic).toBe(
      "runner_lost: no post of the run for 120000ms while its Actions run is in_progress",
    )
    await released(daemon, false)
    // GitHub now reports the Actions run cancelled, by the daemon's own cancel.
    const runs = await daemon.runtime.runPromise(AgentRunStore)
    expect((await daemon.runtime.runPromise(runs.read(id)))?.state).toBe("operator_required")
    expect(end.messages.map((entry) => entry.message)).toEqual([
      expect.objectContaining({
        status: "operator_required",
        end_reason: end.run.diagnostic,
        placement: "runner",
      }),
    ])
    expect((await daemon.runtime.runPromise(mailbox(id))).length).toBe(1)
  })
}, 90000)

for (const [conclusion, reason, text] of [
  ["cancelled", "runner_cancelled", "the run's Actions run was cancelled before its result"],
  ["failure", "runner_failed", "the run's Actions run ended failure before its result"],
] as const)
  test(`an Actions run that GitHub reports ${conclusion} before the run's result ends the run ${reason}`, async () => {
    await withEnding("quiet", async (daemon, directory) => {
      const id = await dispatch(daemon)
      daemon.github.endRun(daemon.leaseId(), conclusion)
      // The daemon reads the Actions run of a run whose posts come each 30 s.
      let end: Awaited<ReturnType<typeof ended>>
      try {
        setSystemTime(new Date(Date.now() + 30000))
        end = await ended(daemon.runtime, id)
      } finally {
        setSystemTime()
      }
      expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
        state: "operator_required",
        diagnostic: `${reason}: ${text}`,
      })
      expect(end.messages.length).toBe(1)
      await released(daemon, true)
      // GitHub ended the Actions run, so the daemon asks no cancel.
      expect(daemon.github.cancels()).toEqual([])
      await endJob(daemon, directory)
    })
  }, 90000)

test("a run that changed nothing ends at once with its final message, end reason unchanged, and pushes nothing", async () => {
  await withEnding("unchanged", async (daemon) => {
    const id = await dispatch(daemon)
    await step("job end", daemon.jobEnded, undefined, 60000)
    const end = await ended(daemon.runtime, id)
    expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
      state: "completed",
      diagnostic: null,
    })
    expect(end.messages.map((entry) => entry.message)).toEqual([
      expect.objectContaining({
        status: "completed",
        end_reason: "unchanged",
        final_message: "Nothing to change.",
        placement: "runner",
      }),
    ])
    expect(
      daemon.remote.ref(`refs/heads/agent-run/${id.replace(/^agent-run-/, "").slice(0, 16)}`),
    ).toBeNull()
    await released(daemon, true)
  })
}, 90000)

/**
 * The gateway as a script, for two causes at one read: its first read gives Claude's first
 * lines; each later read first runs `reading` (which may move the clock, end the Actions run or
 * wait for the test's stop), then gives nothing. Each revoke is counted.
 */
const scripted = (reading: () => Promise<void>) => {
  const revokes: Array<string> = []
  const lines = [
    boxReadyLine,
    ...[
      { type: "system", subtype: "init", session_id: "fixture-session", model: runnerModel },
      { type: "assistant", message: { content: [{ type: "text", text: "Working." }] } },
    ].map((line) => JSON.stringify(line)),
  ]
  const control: RunnerControl = {
    authorize: () => Effect.succeed(undefined),
    revoke: (id) => Effect.sync(() => void revokes.push(id)).pipe(Effect.as(null)),
    startRevoke: (id) => Effect.sync(() => void revokes.push(id)),
    sessionBound: () => Effect.succeed(true),
    readEvents: (_id, after) =>
      after === 0
        ? Effect.succeed({ batches: [{ sequence: 1, lines }], result: false, ended: null })
        : Effect.promise(reading).pipe(Effect.as({ batches: [], result: false, ended: null })),
    readResult: () => Effect.die("no result is held"),
  }
  return { control, revokes }
}

/** Runs the daemon on the scripted gateway `script` and dispatches the run; gives its end. */
async function scriptedEnd(
  script: (
    github: Awaited<ReturnType<typeof githubStub>>,
    stop: () => Promise<void>,
  ) => () => Promise<void>,
  /** Runs once the run ended, with the daemon still up. */
  after?: (runtime: ReturnType<typeof daemonRuntime>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "runner-ending-"))
  const remote = await gitRemote(join(root, "git"))
  const github = await githubStub(remote.sourceSha, () => undefined)
  // The stop goes through the daemon that runs the script, which exists once the script does.
  const daemon: { runtime?: ReturnType<typeof daemonRuntime> } = {}
  const stop = () =>
    daemon.runtime!.runPromise(
      Effect.flatMap(AgentRunIngress, (ingress) => ingress.cancel(runId, new Date())),
    )
  const gateway = scripted(script(github, stop))
  const runtime = daemonRuntime(
    { root, database: join(root, "workflowd.db") },
    github,
    remote.bare,
    runnerPolicy(image),
    Effect.succeed(gateway.control),
  )
  daemon.runtime = runtime
  try {
    await runtime.runPromise(
      Effect.flatMap(AgentRunIngress, (ingress) => ingress.register(submission, new Date())),
    )
    const end = await ended(runtime, runId)
    await after?.(runtime)
    return { ...end, revokes: gateway.revokes, cancels: github.cancels() }
  } finally {
    setSystemTime()
    await runtime.dispose()
    await github.close()
    await remote.close()
    await rm(root, { recursive: true, force: true })
  }
}

test("a stop that comes as the run's deadline passes ends the run cancelled, with one message", async () => {
  const end = await scriptedEnd((_github, stop) => {
    let first = true
    return async () => {
      if (!first) return
      first = false
      // The lease's deadline, 285 minutes from the start, passes; the stop comes at the same read.
      setSystemTime(new Date(Date.now() + 286 * 60000))
      await stop()
    }
  })
  expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
    state: "cancelled",
    diagnostic: "cancelled",
  })
  expect(end.messages.map((entry) => entry.message)).toEqual([stoppedMessage(runId)])
  expect(end.revokes[0]).toBe(runId)
  expect(end.cancels).toEqual([actionsRunId])
}, 30000)

test("a deadline that passes with no stop ends the run runner_deadline; a stop after that end is refused and adds no message", async () => {
  let late: unknown
  const end = await scriptedEnd(
    () => async () => {
      setSystemTime(new Date(Date.now() + 286 * 60000))
    },
    async (runtime) => {
      late = await runtime.runPromise(
        Effect.flatMap(AgentRunIngress, (ingress) =>
          Effect.result(ingress.cancel(runId, new Date())),
        ),
      )
      expect((await runtime.runPromise(mailbox(runId))).length).toBe(1)
    },
  )
  expect(end.run.diagnostic).toBe("runner_deadline: the run's deadline passed before its result")
  expect(end.messages.length).toBe(1)
  expect(late).toMatchObject({ _tag: "Failure" })
  expect(JSON.stringify(late)).toContain("is already operator_required")
}, 30000)

test("a runner that is lost when GitHub reports its Actions run cancelled, at one read, ends runner_cancelled", async () => {
  const end = await scriptedEnd((github) => {
    let first = true
    return () => {
      if (first) {
        first = false
        // The run is quiet past the time of a lost run, and its Actions run ended cancelled.
        setSystemTime(new Date(Date.now() + 120000))
        github.endRun(github.leaseRefs()[0]!, "cancelled")
      }
      return Promise.resolve()
    }
  })
  expect(end.run.diagnostic).toBe(
    "runner_cancelled: the run's Actions run was cancelled before its result",
  )
  expect(end.messages.length).toBe(1)
  expect(end.cancels).toEqual([])
}, 30000)

/**
 * A daemon on the scripted gateway `control` and the store below `root`, with its own files in a
 * new directory below `root`: `use` gets its runtime; the daemon ends after it.
 */
async function withScriptedDaemon<A>(
  root: string,
  github: Awaited<ReturnType<typeof githubStub>>,
  bare: string,
  control: RunnerControl,
  use: (runtime: ReturnType<typeof daemonRuntime>) => Promise<A>,
) {
  const runtime = daemonRuntime(
    { root: await mkdtemp(join(root, "daemon-")), database: join(root, "workflowd.db") },
    github,
    bare,
    runnerPolicy(image),
    Effect.succeed(control),
  )
  try {
    return await use(runtime)
  } finally {
    await runtime.dispose()
  }
}

const cancelRun = (runtime: ReturnType<typeof daemonRuntime>) =>
  runtime.runPromise(
    Effect.flatMap(AgentRunIngress, (ingress) => Effect.result(ingress.cancel(runId, new Date()))),
  )
const registerRun = (runtime: ReturnType<typeof daemonRuntime>) =>
  runtime.runPromise(
    Effect.flatMap(AgentRunIngress, (ingress) =>
      Effect.result(ingress.register(submission, new Date())),
    ),
  )

test("a stop before the run's job holds its session ends the start, and the run ends cancelled with one message", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-ending-"))
  const remote = await gitRemote(join(root, "git"))
  const github = await githubStub(remote.sourceSha, () => undefined)
  const gateway = scripted(() => Promise.resolve())
  try {
    await withScriptedDaemon(
      root,
      github,
      remote.bare,
      // The job never opens its session.
      { ...gateway.control, sessionBound: () => Effect.succeed(false) },
      async (runtime) => {
        const registering = registerRun(runtime)
        await until("lease ref", () => (github.leaseRefs().length > 0 ? true : undefined))
        expect((await cancelRun(runtime))._tag).toBe("Success")
        expect((await registering)._tag).toBe("Failure")
        const end = await ended(runtime, runId)
        expect(end.run.state).toBe("cancelled")
        expect(end.messages.map((entry) => entry.message)).toEqual([
          expect.objectContaining({ status: "cancelled", end_reason: "cancelled" }),
        ])
        expect(gateway.revokes[0]).toBe(runId)
      },
    )
  } finally {
    await github.close()
    await remote.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("a runner run that is live at a start of the daemon ends once at that start, its lease released; a stop after that is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-ending-"))
  const remote = await gitRemote(join(root, "git"))
  const github = await githubStub(remote.sourceSha, () => undefined)
  const gateway = scripted(() => Promise.resolve())
  try {
    await withScriptedDaemon(root, github, remote.bare, gateway.control, async (runtime) => {
      expect((await registerRun(runtime))._tag).toBe("Success")
    })
    // The daemon starts again on the same store: no executor of it reads the live run.
    await withScriptedDaemon(root, github, remote.bare, gateway.control, async (runtime) => {
      const end = await ended(runtime, runId)
      expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
        state: "operator_required",
        diagnostic: "Sandbox coordinator restarted",
      })
      expect(end.messages.length).toBe(1)
      expect(gateway.revokes).toContain(runId)
      expect(github.cancels()).toEqual([actionsRunId])
      expect((await cancelRun(runtime))._tag).toBe("Failure")
      expect((await runtime.runPromise(mailbox(runId))).length).toBe(1)
    })
  } finally {
    await github.close()
    await remote.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("a job that holds no session within 30 minutes of its lease ends the start runner_start, once, with its lease released, and the daemon grants the run no more", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-ending-"))
  const remote = await gitRemote(join(root, "git"))
  const github = await githubStub(remote.sourceSha, () => undefined)
  const gateway = scripted(() => Promise.resolve())
  const authorized: Array<string> = []
  try {
    await withScriptedDaemon(
      root,
      github,
      remote.bare,
      {
        ...gateway.control,
        authorize: (id) => Effect.sync(() => void authorized.push(id)),
        // No job holds the run's session. The daemon reads that last in each acquisition, and
        // 30 minutes have passed since the lease once it read it.
        sessionBound: () =>
          Effect.sync(() => {
            setSystemTime(new Date(Date.now() + 30 * 60000 + 1000))
            return false
          }),
      },
      async (runtime) => {
        try {
          const refusal = await step("start end", () => registerRun(runtime), undefined, 10000)
          expect(refusal._tag).toBe("Failure")
        } finally {
          setSystemTime()
        }
        const end = await ended(runtime, runId)
        expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
          state: "operator_required",
          diagnostic: "runner_start: the run's job held no gateway session within 30 minutes",
        })
        expect(end.messages.length).toBe(1)
        // The release revoked the run after its one grant, and cancelled its Actions run.
        expect(authorized).toEqual([runId])
        expect(gateway.revokes).toContain(runId)
        expect(github.cancels()).toEqual([actionsRunId])
        // The daemon's grants, which its reconcile sends the gateway, hold none of the run: a
        // job that starts late gets no session.
        expect(
          await runtime.runPromise(
            liveGrants(null, Date.now(), defaultRunBudget, {
              aliases: ["runner"],
              identity: runnerIdentity,
              providerId: "anthropic",
            }),
          ),
        ).toEqual([])
        expect((await runtime.runPromise(mailbox(runId))).length).toBe(1)
      },
    )
  } finally {
    await github.close()
    await remote.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("a stop of the daemon while its runner run waits for the job's session ends the wait at once, releases the lease and ends the run once, runner_start", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-ending-"))
  const remote = await gitRemote(join(root, "git"))
  const github = await githubStub(remote.sourceSha, () => undefined)
  const gateway = scripted(() => Promise.resolve())
  try {
    await withScriptedDaemon(
      root,
      github,
      remote.bare,
      // The job never opens its session.
      { ...gateway.control, sessionBound: () => Effect.succeed(false) },
      async (runtime) => {
        const dispatching = runtime.runFork(
          Effect.flatMap(AgentRunIngress, (ingress) => ingress.register(submission, new Date())),
        )
        await until("lease ref", () => (github.leaseRefs().length > 0 ? true : undefined))
        // The daemon's stop interrupts the dispatch that it runs.
        const stoppedAt = Date.now()
        await step(
          "daemon stop",
          () => runtime.runPromise(Fiber.interrupt(dispatching)),
          undefined,
          10000,
        )
        expect(Date.now() - stoppedAt).toBeLessThan(5000)
        const end = await ended(runtime, runId)
        expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
          state: "operator_required",
          diagnostic:
            "runner_start: the daemon stopped before the run's job held its gateway session",
        })
        expect(end.messages.length).toBe(1)
        expect(gateway.revokes).toContain(runId)
        expect(github.cancels()).toEqual([actionsRunId])
      },
    )
  } finally {
    await github.close()
    await remote.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

test("a runner run that is live at a restart of the daemon, over the gateway that outlived it, ends once at the start: the gateway revokes its session, its Actions run is cancelled, its ref removed and its run client ends", async () => {
  await withEnding("quiet", async (daemon) => {
    const id = await dispatch(daemon)
    const runtime = await step("restart", daemon.restart)
    const end = await ended(runtime, id)
    expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
      state: "operator_required",
      diagnostic: "Sandbox coordinator restarted",
    })
    expect(end.messages.length).toBe(1)
    // The gateway process ran through the restart; the new daemon's start revoked the run there.
    await released({ ...daemon, runtime }, false)
    // The run client's next post is refused, so it ends, and with it the run's harness.
    await step("job end", daemon.jobEnded, undefined, 60000)
    expect((await runtime.runPromise(mailbox(id))).length).toBe(1)
  })
}, 90000)

test("a runner whose posts stop while GitHub cannot be read ends runner_lost, and does not hold its lease to its deadline", async () => {
  const end = await scriptedEnd((github) => {
    let first = true
    return () => {
      if (first) {
        first = false
        // The run is quiet for two minutes, and GitHub's API does not answer.
        github.unreadable()
        setSystemTime(new Date(Date.now() + 120000))
      }
      return Promise.resolve()
    }
  })
  expect(end.run.diagnostic).toBe(
    "runner_lost: no post of the run for 120000ms while its Actions run is unread",
  )
  expect(end.messages.length).toBe(1)
  expect(end.revokes).toContain(runId)
}, 30000)
