import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Effect } from "effect"
import type { GatewayEnd } from "../../src/capability-control/protocol"
import { AgentRunIngress, agentRunIdentifiers } from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
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
  { type: "system", subtype: "init", session_id: "fixture-session", model: runnerModel },
  { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
  { type: "result", subtype: "success", is_error: false, result: "Done." },
].map((line) => JSON.stringify(line))

type Remote = Awaited<ReturnType<typeof gitRemote>>
type Sealed = { readonly manifest: Record<string, unknown>; readonly bundle: Buffer }

/**
 * A result as the box seals it, with the real result.py: `files` written on `base` (the source,
 * unless named) and committed as `identity` (the daemon's agent identity, unless named).
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
  run("seal", ["tar", "-cf", "capture.tar", "-C", "workspace", "."], directory)
  const result = resolve("deploy/sandbox/result.py")
  run("seal", ["python3", "-I", result, "native-export", "capture.tar", base], directory)
  run(
    "seal",
    ["python3", "-I", result, "native-seal", base],
    directory,
    JSON.stringify({
      completion: {
        title: "workflowd agent run",
        commitMessage: "workflowd agent run\n",
        body: "One file.",
        finalMessage: "Done.",
      },
      sensitiveValues: [],
      identity: options.identity ?? runnerIdentity,
    }),
  )
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
 * The gateway as a script: the run's lease has its session at once; its events are `lines` in one
 * batch, then its result `body` (none when undefined) or its own end `ended`. `parts` cuts the
 * stored result as `readResult` answers it, the whole body from its offset unless named.
 */
const scripted = (script: {
  readonly body?: Buffer
  readonly ended?: GatewayEnd
  readonly parts?: (offset: number) => { size: number; sha256: string; part: string }
}): RunnerControl => ({
  authorize: () => Effect.void,
  revoke: () => Effect.void,
  startRevoke: () => Effect.void,
  sessionBound: () => Effect.succeed(true),
  readEvents: (_runId, after) =>
    Effect.succeed(
      after === 0
        ? { batches: [{ sequence: 1, lines }], result: false, ended: null }
        : { batches: [], result: script.body !== undefined, ended: script.ended ?? null },
    ),
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
})

/**
 * Dispatches the run with the gateway that `gateway` scripts, given the fixture remote, and waits
 * for its end. Gives the run's record, its message in the caller's mailbox and the remote.
 */
async function dispatch(
  gateway: (remote: Remote, root: string) => Promise<RunnerControl>,
  prepare: (remote: Remote) => void = () => undefined,
) {
  const root = await mkdtemp(join(tmpdir(), "runner-dispatch-"))
  const remote = await gitRemote(join(root, "git"))
  const github = await githubStub(remote.sourceSha, () => undefined)
  prepare(remote)
  const runtime = daemonRuntime(
    { root, database: join(root, "workflowd.db") },
    github,
    remote.bare,
    runnerPolicy(image),
    Effect.succeed(await gateway(remote, root)),
  )
  try {
    const receipt = await runtime.runPromise(
      Effect.flatMap(AgentRunIngress, (ingress) => ingress.register(submission, new Date())),
    )
    const runs = await runtime.runPromise(AgentRunStore)
    for (let tries = 0; tries < 300; tries++) {
      const current = await runtime.runPromise(runs.read(receipt.runId))
      if (current !== null && !["spawning", "spawned", "verified"].includes(current.state)) {
        const messages = await runtime.runPromise(mailbox(receipt.runId))
        return { run: current, message: messages[0]?.message, branch: remote.ref(branch) }
      }
      await Bun.sleep(50)
    }
    throw new Error("the run did not end")
  } finally {
    await runtime.dispose()
    await github.close()
    await remote.close()
    await rm(root, { recursive: true, force: true })
  }
}

test("a sealed result that passes the check is pushed as agent-run/<id>, and the run completes", async () => {
  const ended = await dispatch(async (remote, root) =>
    scripted({ body: bodyOf(await seal(root, remote)) }),
  )
  expect({ state: ended.run.state, diagnostic: ended.run.diagnostic }).toEqual({
    state: "completed",
    diagnostic: null,
  })
  expect(ended.branch).not.toBeNull()
  expect(ended.message).toMatchObject({
    status: "completed",
    end_reason: "completed",
    final_message: "Done.",
    placement: "runner",
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
    check: "github_path",
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
    const ended = await dispatch(
      async (remote, root) => scripted({ body: await result(remote, root) }),
      (remote) => {
        prepare?.(remote)
        pushedBefore = remote.ref(branch)
      },
    )
    expect({ state: ended.run.state, diagnostic: ended.run.diagnostic }).toEqual({
      state: "operator_required",
      diagnostic: expect.stringMatching(new RegExp(`^result_refused: ${check}(:|$)`)),
    })
    expect(ended.branch).toBe(pushedBefore)
    expect(ended.message).toMatchObject({
      status: "operator_required",
      end_reason: ended.run.diagnostic,
      placement: "runner",
    })
  }, 30000)

test("a run that the gateway ended gives its reason and its use in the caller's message", async () => {
  const ended = await dispatch(async () =>
    scripted({ ended: { reason: "budget", calls: 7, outputTokens: 1234 } }),
  )
  expect({ state: ended.run.state, diagnostic: ended.run.diagnostic }).toEqual({
    state: "operator_required",
    diagnostic: "gateway_ended: ended: budget (7 calls, 1234 output tokens)",
  })
  expect(ended.branch).toBeNull()
  expect(ended.message).toMatchObject({
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
    const ended = await dispatch(async (remote, root) => {
      const body = bodyOf(await seal(root, remote))
      return scripted({ body, parts: parts(body) })
    })
    expect({ state: ended.run.state, diagnostic: ended.run.diagnostic }).toEqual({
      state: "operator_required",
      diagnostic: `result_format: ${reason}`,
    })
    expect(ended.branch).toBeNull()
  }, 30000)
