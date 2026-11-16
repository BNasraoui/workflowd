import { expect, setSystemTime, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { boxReadyLine } from "../../deploy/sandbox/box-ready.mjs"
import { sealRun } from "../../deploy/sandbox/native-seal.mjs"
import { directoryArchive } from "../helpers/workspace-archive.mjs"
import type { GatewayEnd } from "../../src/capability-control/protocol"
import { AgentRunIngress, agentRunIdentifiers } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { claudeEndpointIdentity } from "../../src/kernel/claude-session"
import { KernelSessionStore } from "../../src/kernel/session-store"
import { CapabilityGatewayUnavailable } from "../../src/sandbox/capability-control"
import {
  daemonRuntime,
  githubStub,
  gitRemote,
  mailbox,
  run,
  runnerIdentity,
  runnerModel,
  runnerPolicy,
  type RunnerControl,
} from "./fixture"

/**
 * The runner branch of the sandbox dispatch, through the daemon's ingress: its start of the run
 * (prepareRunner), its check and push of the run's sealed result (publishRunner) and its end
 * (finishRunner). The gateway is a script: its event batches, its stored result and its own end;
 * the lease is real, on the GitHub API stub; the check is the daemon's, against a fixture remote.
 */

const image = `ghcr.io/bnasraoui/workflowd-agent-base@sha256:${"b".repeat(64)}`
const submission = { route: "claude", repository: "runner", prompt: "Write the proof file." }
const runId = agentRunIdentifiers({
  ...submission,
  parentSessionId: null,
  resumePrompt: null,
}).runId
const branch = `refs/heads/agent-run/${runId.replace(/^agent-run-/, "").slice(0, 16)}`
const lines = [
  boxReadyLine,
  ...[
    { type: "system", subtype: "init", session_id: "fixture-session", model: runnerModel },
    { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
    { type: "result", subtype: "success", is_error: false, result: "Done." },
  ].map((line) => JSON.stringify(line)),
]

type Remote = Awaited<ReturnType<typeof gitRemote>>
type Sealed = { readonly manifest: Record<string, unknown>; readonly bundle: Buffer }

/**
 * A result as the box seals it, with the harness's own seal: `files` written on `base` (the
 * source, unless named) and committed as `identity` (the daemon's agent identity, unless named).
 */
async function seal(
  root: string,
  remote: Remote,
  options: {
    readonly files?: Readonly<Record<string, string>>
    readonly identity?: { readonly name: string; readonly email: string }
    readonly base?: string
  } = {},
): Promise<Sealed> {
  const directory = await mkdtemp(join(root, "seal-"))
  const base = options.base ?? remote.sourceSha
  run("seal", ["git", "init", "--quiet", "--bare", "source.git"], directory)
  run(
    "seal",
    ["git", "-C", "source.git", "fetch", "--quiet", "--no-tags", remote.bare, base],
    directory,
  )
  await mkdir(join(directory, "workspace"))
  run(
    "seal",
    ["sh", "-c", 'git -C source.git archive "$1" | tar -x -C workspace', "sh", base],
    directory,
  )
  for (const [path, text] of Object.entries(options.files ?? { "runner-proof.txt": "proof\n" })) {
    await mkdir(dirname(join(directory, "workspace", path)), { recursive: true })
    await writeFile(join(directory, "workspace", path), text)
  }
  await sealRun({
    directory,
    native: directory,
    sourceSha: base,
    identity: options.identity ?? runnerIdentity,
    reply: "Done.",
    workspace: () => directoryArchive(join(directory, "workspace")),
  })
  const manifest: unknown = JSON.parse(
    await readFile(join(directory, "result/result.json"), "utf8"),
  )
  if (typeof manifest !== "object" || manifest === null) throw new Error("seal: no manifest")
  return {
    manifest: Object.fromEntries(Object.entries(manifest)),
    bundle: await readFile(join(directory, "result/result.bundle")),
  }
}

/** A result of one commit on the source, made with git as the agent identity: `path` added. */
async function committed(root: string, remote: Remote, path: string): Promise<Sealed> {
  const work = await mkdtemp(join(root, "commit-"))
  const git = (...args: ReadonlyArray<string>) => {
    const child = Bun.spawnSync(["git", "-C", work, ...args], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: runnerIdentity.name,
        GIT_AUTHOR_EMAIL: runnerIdentity.email,
        GIT_COMMITTER_NAME: runnerIdentity.name,
        GIT_COMMITTER_EMAIL: runnerIdentity.email,
      },
    })
    if (child.exitCode !== 0)
      throw new Error(`step commit: git ${args[0]}: ${child.stderr.toString()}`)
  }
  git("init", "--quiet")
  git("fetch", "--quiet", remote.bare, remote.sourceSha)
  git("checkout", "--quiet", "--detach", remote.sourceSha)
  await mkdir(dirname(join(work, path)), { recursive: true })
  await writeFile(join(work, path), "on: push\n")
  git("add", "--", path)
  git("commit", "--quiet", "-m", "workflowd agent run")
  git("update-ref", "refs/workflowd/result", "HEAD")
  git(
    "bundle",
    "create",
    "--quiet",
    "result.bundle",
    "refs/workflowd/result",
    `^${remote.sourceSha}`,
  )
  return {
    manifest: {
      sourceSha: remote.sourceSha,
      title: "workflowd agent run",
      body: "One file.",
      finalMessage: "Done.",
    },
    bundle: await readFile(join(work, "result.bundle")),
  }
}

/** The result body as the run client posts it: result.json's 4-byte length, result.json, bundle. */
const framed = (json: Buffer, bundle: Buffer) => {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(json.length)
  return Buffer.concat([head, json, bundle])
}
const bodyOf = (sealed: Sealed) =>
  framed(Buffer.from(JSON.stringify(sealed.manifest)), sealed.bundle)
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/**
 * The gateway as a script: the run's lease has its session at once; its events are `first` (`lines`
 * unless named) in one batch, `readyAfterMs` after the first read (at once unless named), then its
 * result `body` (none when undefined) or its own end `ended`. `parts` cuts the stored result as
 * `readResult` answers it, the whole body from its offset unless named.
 */
const scripted = (script: {
  readonly first?: ReadonlyArray<string>
  readonly readyAfterMs?: number
  readonly body?: Buffer
  readonly ended?: GatewayEnd
  /** What the gateway answers after the first batch: its fault, or nothing yet, ever. */
  readonly later?: "unavailable" | "nothing"
  /** Runs at each read after the first batch. */
  readonly reading?: () => void
  readonly parts?: (offset: number) => { size: number; sha256: string; part: string }
}): RunnerControl => {
  let firstRead: number | undefined
  return {
    authorize: () => Effect.succeed(undefined),
    revoke: () => Effect.succeed(null),
    startRevoke: () => Effect.void,
    sessionBound: () => Effect.succeed(true),
    readEvents: (_runId, after) => {
      firstRead ??= Date.now()
      if (after === 0)
        return Effect.succeed({
          batches:
            Date.now() - firstRead >= (script.readyAfterMs ?? 0)
              ? [{ sequence: 1, lines: script.first ?? lines }]
              : [],
          result: false,
          ended: null,
        })
      script.reading?.()
      if (script.later === "unavailable")
        return Effect.fail(new CapabilityGatewayUnavailable({ reason: "fixture fault" }))
      return Effect.succeed({
        batches: [],
        result: script.later !== "nothing" && script.body !== undefined,
        ended: script.later === "nothing" ? null : (script.ended ?? null),
      })
    },
    readResult: (_runId, offset) =>
      Effect.sync(() => {
        if (script.parts !== undefined) return script.parts(offset)
        const body = script.body ?? Buffer.alloc(0)
        return {
          size: body.length,
          sha256: sha256(body),
          part: body.subarray(offset).toString("base64"),
        }
      }),
  }
}

/**
 * The daemon with the gateway that `gateway` scripts, given the fixture remote: its runtime and
 * the remote, for `use`. `options` name what the daemon finds: the job's workflows in the
 * repository (yes, unless named) and the remote that it pushes to (the fixture's, unless named).
 */
async function withDispatch<A>(
  gateway: (remote: Remote, root: string) => Promise<RunnerControl>,
  use: (runtime: ReturnType<typeof daemonRuntime>, remote: Remote) => Promise<A>,
  options: {
    readonly prepare?: (remote: Remote) => void
    readonly workflows?: boolean
    readonly pushTo?: string
    /** The window for the run's first model output, 120 s unless named. */
    readonly verifyTimeoutMs?: number
    /** Whether GitHub reports the job's Actions run completed from its start. */
    readonly jobEnded?: boolean
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "runner-dispatch-"))
  const remote = await gitRemote(join(root, "git"))
  const stub: { github?: Awaited<ReturnType<typeof githubStub>> } = {}
  const github = await githubStub(
    remote.sourceSha,
    (leaseId) => {
      if (options.jobEnded === true) stub.github?.endRun(leaseId)
    },
    options.workflows,
  )
  stub.github = github
  options.prepare?.(remote)
  const runtime = daemonRuntime(
    { root, database: join(root, "workflowd.db") },
    github,
    options.pushTo ?? remote.bare,
    runnerPolicy(image),
    Effect.succeed(await gateway(remote, root)),
    options.verifyTimeoutMs === undefined ? {} : { verifyTimeoutMs: options.verifyTimeoutMs },
  )
  try {
    return await use(runtime, remote)
  } finally {
    await runtime.dispose()
    await github.close()
    await remote.close()
    await rm(root, { recursive: true, force: true })
  }
}

/** Registers `input` with the daemon: its receipt, or its refusal's text. */
const register = (runtime: ReturnType<typeof daemonRuntime>, input = submission) =>
  runtime.runPromise(
    Effect.result(
      Effect.flatMap(AgentRunIngress, (ingress) => ingress.register(input, new Date())),
    ),
  )

/** The text of a refusal, with the message of each error that it holds. */
const refusalText = (refusal: unknown) =>
  JSON.stringify(refusal, (_key, value: unknown) =>
    value instanceof Error ? value.message : value,
  )

/** Waits for the end of the run `runId`: its record, its message and the branch in the remote. */
async function ended(runtime: ReturnType<typeof daemonRuntime>, remote: Remote, runId: string) {
  const runs = await runtime.runPromise(AgentRunStore)
  for (let tries = 0; tries < 300; tries++) {
    const current = await runtime.runPromise(runs.read(runId))
    if (current !== null && !["spawning", "spawned", "verified"].includes(current.state)) {
      const messages = await runtime.runPromise(mailbox(runId))
      const session =
        current.sessionId === null
          ? null
          : await runtime.runPromise(
              Effect.flatMap(KernelSessionStore, (sessions) =>
                sessions.readSession(current.sessionId!),
              ),
            )
      return { run: current, message: messages[0]?.message, branch: remote.ref(branch), session }
    }
    await Bun.sleep(50)
  }
  throw new Error("the run did not end")
}

/**
 * Dispatches the run with the gateway that `gateway` scripts, given the fixture remote, and waits
 * for its end. Gives the run's record, its message in the caller's mailbox and the remote.
 */
const dispatch = (
  gateway: (remote: Remote, root: string) => Promise<RunnerControl>,
  options: Parameters<typeof withDispatch>[2] = {},
) =>
  withDispatch(
    gateway,
    async (runtime, remote) => {
      const receipt = await register(runtime)
      if (receipt._tag === "Failure") throw new Error(JSON.stringify(receipt.failure))
      return ended(runtime, remote, receipt.success.runId)
    },
    options,
  )

test("a sealed result that passes the check is pushed as agent-run/<id>, and the run completes", async () => {
  const end = await dispatch(async (remote, root) =>
    scripted({ body: bodyOf(await seal(root, remote)) }),
  )
  expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
    state: "completed",
    diagnostic: null,
  })
  expect(end.branch).not.toBeNull()
  expect(end.message).toMatchObject({
    status: "completed",
    end_reason: "completed",
    final_message: "Done.",
    placement: "runner",
  })
  // The run's Claude session is held on the runner, not on this host.
  expect(end.session).toMatchObject({
    provider_kind: "claude",
    server_id: "github-actions",
    endpoint_identity: claudeEndpointIdentity("github-actions"),
  })
})

/** A result that each check refuses, made from one that passes. */
const refused: ReadonlyArray<{
  readonly check: string
  readonly result: (remote: Remote, root: string) => Promise<Buffer>
  readonly prepare?: (remote: Remote) => void
}> = [
  {
    check: "manifest",
    result: async (remote, root) =>
      framed(Buffer.from("{not json"), (await seal(root, remote)).bundle),
  },
  {
    check: "unknown_key",
    result: async (remote, root) => {
      const sealed = await seal(root, remote)
      return bodyOf({ ...sealed, manifest: { ...sealed.manifest, branch: "main" } })
    },
  },
  {
    check: "missing_key",
    result: async (remote, root) => {
      const sealed = await seal(root, remote)
      const { title: _title, ...manifest } = sealed.manifest
      return bodyOf({ ...sealed, manifest })
    },
  },
  {
    check: "source",
    result: async (remote, root) => {
      const sealed = await seal(root, remote)
      return bodyOf({ ...sealed, manifest: { ...sealed.manifest, sourceSha: "e".repeat(40) } })
    },
  },
  {
    check: "title",
    result: async (remote, root) => {
      const sealed = await seal(root, remote)
      return bodyOf({ ...sealed, manifest: { ...sealed.manifest, title: "Ask @someone" } })
    },
  },
  {
    check: "body",
    result: async (remote, root) => {
      const sealed = await seal(root, remote)
      return bodyOf({ ...sealed, manifest: { ...sealed.manifest, body: "" } })
    },
  },
  {
    check: "final_message",
    result: async (remote, root) => {
      const sealed = await seal(root, remote)
      return bodyOf({ ...sealed, manifest: { ...sealed.manifest, finalMessage: "\u0007" } })
    },
  },
  {
    check: "bundle_format",
    result: async (remote, root) =>
      bodyOf({ ...(await seal(root, remote)), bundle: Buffer.from("not a bundle\n") }),
  },
  {
    check: "base",
    result: async (remote, root) => {
      // A result on a commit of its own, not on the run's source.
      const first = await seal(root, remote, { files: { "other.txt": "other\n" } })
      const work = await mkdtemp(join(root, "base-"))
      run("base", ["git", "init", "--quiet", "--bare", work])
      run("base", ["git", "-C", work, "fetch", "--quiet", remote.bare, remote.sourceSha])
      await writeFile(join(work, "result.bundle"), first.bundle)
      run("base", ["git", "-C", work, "fetch", "--quiet", "result.bundle", "refs/workflowd/result"])
      const other = run("base", ["git", "-C", work, "rev-parse", "FETCH_HEAD"])
      run("base", [
        "git",
        "-C",
        remote.bare,
        "fetch",
        "--quiet",
        work,
        `${other}:refs/fixture/other`,
      ])
      const sealed = await seal(root, remote, { base: other })
      return bodyOf({ ...sealed, manifest: { ...sealed.manifest, sourceSha: remote.sourceSha } })
    },
  },
  {
    check: "protected_path",
    // The seal itself refuses such a path; a run that bypasses it commits with git.
    result: async (remote, root) =>
      bodyOf(await committed(root, remote, ".GitHub/workflows/x.yml")),
  },
  {
    check: "identity",
    result: async (remote, root) =>
      bodyOf(
        await seal(root, remote, { identity: { name: "Other", email: "other@example.invalid" } }),
      ),
  },
  {
    check: "target_exists",
    result: async (remote, root) => bodyOf(await seal(root, remote)),
    prepare: (remote) =>
      run("target", ["git", "-C", remote.bare, "update-ref", branch, remote.sourceSha]),
  },
]

for (const { check, result, prepare } of refused)
  test(`a sealed result that the check refuses for ${check} ends the run with that check, and nothing is pushed`, async () => {
    let pushedBefore: string | null = null
    const end = await dispatch(
      async (remote, root) => scripted({ body: await result(remote, root) }),
      {
        prepare: (remote) => {
          prepare?.(remote)
          pushedBefore = remote.ref(branch)
        },
      },
    )
    expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
      state: "operator_required",
      diagnostic: expect.stringMatching(new RegExp(`^result_refused: ${check}(:|$)`)),
    })
    expect(end.branch).toBe(pushedBefore)
    expect(end.message).toMatchObject({
      status: "operator_required",
      end_reason: end.run.diagnostic,
      placement: "runner",
    })
  }, 30000)

test("a run that the gateway ended gives its reason and its use in the caller's message", async () => {
  const end = await dispatch(async () =>
    scripted({ ended: { reason: "budget", calls: 7, outputTokens: 1234 } }),
  )
  expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
    state: "operator_required",
    diagnostic: "gateway_ended: ended: budget (7 calls, 1234 output tokens)",
  })
  expect(end.branch).toBeNull()
  expect(end.message).toMatchObject({
    status: "operator_required",
    ended: "budget",
    used: { calls: 7, output_tokens: 1234 },
    placement: "runner",
  })
})

for (const [name, parts, reason] of [
  [
    "a part that changes while it is read",
    (body: Buffer) => (offset: number) => ({
      size: offset === 0 ? body.length : body.length + 1,
      sha256: sha256(body),
      part: body.subarray(offset, offset + 8).toString("base64"),
    }),
    "the result changed while it was read",
  ],
  [
    "an empty part",
    (body: Buffer) => () => ({ size: body.length, sha256: sha256(body), part: "" }),
    "a part of the result is empty",
  ],
  [
    "bytes that are not the result held",
    (body: Buffer) => () => ({
      size: body.length,
      sha256: "0".repeat(64),
      part: body.toString("base64"),
    }),
    "the result read is not the result held",
  ],
  [
    "a body with no framing",
    () => () => ({
      size: 2,
      sha256: sha256(Buffer.from("{}")),
      part: Buffer.from("{}").toString("base64"),
    }),
    "the result is not framed as the run routes say",
  ],
] as const)
  test(`a stored result read as ${name} ends the run as result_format, and nothing is pushed`, async () => {
    const end = await dispatch(async (remote, root) => {
      const body = bodyOf(await seal(root, remote))
      return scripted({ body, parts: parts(body) })
    })
    expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
      state: "operator_required",
      diagnostic: `result_format: ${reason}`,
    })
    expect(end.branch).toBeNull()
  }, 30000)

test("a job that held its session, posted its result and ended before the daemon read its session still completes the run", async () => {
  const end = await dispatch(
    async (remote, root) => scripted({ body: bodyOf(await seal(root, remote)) }),
    { jobEnded: true },
  )
  expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
    state: "completed",
    diagnostic: null,
  })
  expect(end.branch).not.toBeNull()
})

test("the window for a run's first model output starts at its box's ready line: a box ready after a window's length still gives its first output in time", async () => {
  // The image pull, the box's start and the clone take 3 s; the window is 2 s.
  const end = await dispatch(
    async (remote, root) =>
      scripted({ readyAfterMs: 3000, body: bodyOf(await seal(root, remote)) }),
    { verifyTimeoutMs: 2000 },
  )
  expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
    state: "completed",
    diagnostic: null,
  })
}, 30000)

test("a run whose first event is not its box's ready line is refused and ends runner_start, and nothing is pushed", async () => {
  const end = await withDispatch(
    async () => scripted({ first: lines.slice(1), later: "nothing" }),
    async (runtime, remote) => {
      const refusal = await register(runtime)
      expect(refusal._tag).toBe("Failure")
      expect(refusalText(refusal)).toContain(
        "runner_start: the run's first event is not its box's ready line",
      )
      return ended(runtime, remote, runId)
    },
  )
  expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
    state: "operator_required",
    diagnostic: "runner_start: the run's first event is not its box's ready line",
  })
  expect(end.branch).toBeNull()
})

test("a runner run whose job's workflows the repository lacks is refused at its start", async () => {
  const refusal = await withDispatch(
    async () => scripted({}),
    async (runtime) => register(runtime),
    { workflows: false },
  )
  expect(refusal._tag).toBe("Failure")
  expect(refusalText(refusal)).toContain("runner_start")
})

test("a runner run past the bound of runs at one time is refused runner_capacity", async () => {
  const second = await withDispatch(
    async () => scripted({ later: "nothing" }),
    async (runtime) => {
      const first = await register(runtime)
      expect(first._tag).toBe("Success")
      return register(runtime, { ...submission, prompt: "A second run." })
    },
  )
  expect(second._tag).toBe("Failure")
  expect(refusalText(second)).toContain("runner_capacity: 1 runner runs are live; the bound is 1")
})

test("a gateway that fails while the run's events are read ends the run gateway_unavailable", async () => {
  const end = await dispatch(async () => scripted({ later: "unavailable" }))
  expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
    state: "operator_required",
    diagnostic: "gateway_unavailable: gateway: CapabilityGatewayUnavailable",
  })
  expect(end.branch).toBeNull()
})

test("a run whose deadline passes before its result ends runner_deadline", async () => {
  try {
    const end = await dispatch(async () =>
      scripted({
        later: "nothing",
        // The lease's deadline, 285 minutes from the start, has passed.
        reading: () => setSystemTime(new Date(Date.now() + 286 * 60000)),
      }),
    )
    expect({ state: end.run.state, diagnostic: end.run.diagnostic }).toEqual({
      state: "operator_required",
      diagnostic: "runner_deadline: the run's deadline passed before its result",
    })
  } finally {
    setSystemTime()
  }
})

test("a remote that the check cannot reach ends the run with the check's fault, and nothing is pushed", async () => {
  const end = await dispatch(
    async (remote, root) => scripted({ body: bodyOf(await seal(root, remote)) }),
    { pushTo: "/nonexistent/remote.git" },
  )
  expect(end.run.state).toBe("operator_required")
  expect(end.run.diagnostic).toContain("runner.result")
  expect(end.branch).toBeNull()
})
