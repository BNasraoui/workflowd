import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Redacted, Schema } from "effect"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createHash, randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { constants as zlibConstants, deflateRawSync, deflateSync } from "node:zlib"
import {
  checkSealedResult,
  decodeSealedResult,
  pushSealedResult,
  removeSealedResultScratch,
  SealedResultFault,
  SealedResultRefused,
  sealedResultLimits,
  type SealedResult,
  type SealedResultCheck,
  type SealedResultOptions,
} from "../../src/kernel/sealed-result"
import { githubApiStub } from "../sandbox/github-api-stub"
import { command } from "../sandbox/harness"

// The real sealing script of the runner, and a daemon check that pushes into a bare
// fixture remote on disk. Nothing here reaches GitHub.
const script = resolve("deploy/sandbox/result.py")
const target = { ref: "refs/heads/agent-run/run-1", expectedHead: null }
const token = "ghs_FixtureInstallationToken0123456789"
// The identity the daemon gives agent runs; the seal commits as it and the check requires it.
const agentGit = {
  name: "Fixture Agent",
  email: "agent@example.invalid",
  blockedEmails: ["owner@example.invalid"],
}
const asAgent = {
  GIT_AUTHOR_NAME: agentGit.name,
  GIT_AUTHOR_EMAIL: agentGit.email,
  GIT_COMMITTER_NAME: agentGit.name,
  GIT_COMMITTER_EMAIL: agentGit.email,
}
// result.json holds the wording; the commit message reaches the daemon only in the commit.
const wording = {
  title: "Add the result file",
  body: "## Result\n\nOne file.",
  finalMessage: "Done: one file added.",
}
const completion = { ...wording, commitMessage: "Add the result file\n\nThe run wrote one file.\n" }

/** Runs a command of the fixture as the agent identity, with optional stdin. */
async function run(
  args: ReadonlyArray<string>,
  cwd: string,
  input?: string | Uint8Array,
  env: Record<string, string> = {},
): Promise<string> {
  const child = Bun.spawn([...args], {
    cwd,
    env: { ...process.env, ...asAgent, ...env },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (status !== 0) throw new Error(`${args.join(" ")} exited ${status}: ${stderr}`)
  return stdout.trim()
}

type Fixture = {
  readonly root: string
  readonly work: string
  readonly remote: string
  readonly scratchRoot: string
  readonly sourceSha: string
  readonly git: (cwd: string, ...args: string[]) => Promise<string>
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sealed-result-"))
  const work = join(root, "work")
  const remote = join(root, "remote.git")
  const scratchRoot = join(root, "scratch")
  await mkdir(work)
  // The daemon's root of scratch directories: only its own user may use it.
  await mkdir(scratchRoot, { mode: 0o700 })
  const git = (cwd: string, ...args: string[]) =>
    run(["git", "-c", "commit.gpgsign=false", ...args], cwd)
  await git(work, "init", "-q", "-b", "main")
  await writeFile(join(work, "README.md"), "fixture\n")
  await writeFile(join(work, "run.sh"), "#!/bin/sh\n")
  await chmod(join(work, "run.sh"), 0o755)
  await git(work, "add", ".")
  await git(work, "commit", "-q", "-m", "base")
  const sourceSha = await git(work, "rev-parse", "HEAD")
  await command(["git", "clone", "-q", "--bare", work, remote])
  return { root, work, remote, scratchRoot, sourceSha, git }
}

const options = (f: Fixture, extra: Partial<SealedResultOptions> = {}): SealedResultOptions => ({
  remote: f.remote,
  sourceSha: f.sourceSha,
  token: Redacted.make(token),
  agentGit,
  scratchRoot: f.scratchRoot,
  ...extra,
})

const manifest = (sourceSha: string, fields: Record<string, unknown> = {}) =>
  new TextEncoder().encode(JSON.stringify({ sourceSha, ...wording, ...fields }))

/** Seals a workspace with the real result.py: export of a workspace archive, then seal. */
async function sealWithResultPy(
  f: Fixture,
  change: (workspace: string) => Promise<void>,
  sealed: Record<string, unknown> = completion,
): Promise<{ json: Uint8Array; bundle: Uint8Array }> {
  const workspace = join(f.root, "workspace")
  const seal = join(f.root, "seal")
  await command(["git", "clone", "-q", f.work, workspace])
  await change(workspace)
  await mkdir(seal)
  await command(["tar", "--exclude=.git", "-cf", join(seal, "workspace.tar"), "-C", workspace, "."])
  await command(["git", "clone", "-q", "--bare", f.work, join(seal, "source.git")])
  await command(["python3", "-I", script, "native-export", "workspace.tar", f.sourceSha], seal)
  const child = Bun.spawn(["python3", "-I", script, "native-seal", f.sourceSha], {
    cwd: seal,
    stdin: new Blob([
      JSON.stringify({
        completion: sealed,
        sensitiveValues: [],
        identity: { name: agentGit.name, email: agentGit.email },
      }),
    ]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, , stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (status !== 0) throw new Error(`native-seal exited ${status}: ${stderr}`)
  return {
    json: await Bun.file(join(seal, "result", "result.json")).bytes(),
    bundle: await Bun.file(join(seal, "result", "result.bundle")).bytes(),
  }
}

/** A bundle made by hand, as a misbehaving runner could send it. */
async function handBundle(
  f: Fixture,
  build: (git: (...args: string[]) => Promise<string>, dir: string) => Promise<unknown>,
  bundleArgs?: (resultSha: string) => string[],
): Promise<Uint8Array> {
  const dir = join(f.root, `hand-${crypto.randomUUID()}`)
  await command(["git", "clone", "-q", f.work, dir])
  const git = (...args: string[]) => f.git(dir, ...args)
  await build(git, dir)
  const resultSha = await git("rev-parse", "HEAD")
  await git("update-ref", "refs/workflowd/result", resultSha)
  const out = join(dir, "..", `${crypto.randomUUID()}.bundle`)
  await git(
    "bundle",
    "create",
    "-q",
    out,
    ...(bundleArgs?.(resultSha) ?? ["refs/workflowd/result", `^${f.sourceSha}`]),
  )
  return Bun.file(out).bytes()
}

const commitFile = async (
  git: (...args: string[]) => Promise<string>,
  dir: string,
  path: string,
  content: string | Uint8Array = "content\n",
) => {
  await mkdir(join(dir, path, ".."), { recursive: true })
  await writeFile(join(dir, path), content)
  await git("add", "--", path)
  await git("commit", "-q", "-m", "Add a file")
}

const decode = (json: Uint8Array, bundle: Uint8Array) =>
  Effect.runPromise(decodeSealedResult(json, bundle))

/** Check, then optionally act on the remote, then push; one scope holds the scratch repository. */
const publish = (
  result: SealedResult,
  opts: SealedResultOptions,
  between: () => Promise<void> = async () => {},
  checkedTarget: { ref: string; expectedHead: string | null } = target,
) =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const checked = yield* checkSealedResult(result, checkedTarget, opts)
        yield* Effect.promise(between)
        return yield* pushSealedResult(checked)
      }),
    ),
  )

const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const error = Cause.squash(exit.cause)
  return error
}

const refusal = (exit: Exit.Exit<unknown, unknown>) => {
  const error = failure(exit)
  if (!(error instanceof SealedResultRefused)) throw error
  return error
}

const refusedCheck = (exit: Exit.Exit<unknown, unknown>) => refusal(exit).check

const remoteRef = (f: Fixture, ref = target.ref) =>
  command(["git", "for-each-ref", "--format=%(objectname)", ref], f.remote)

const withFixture = (body: (f: Fixture) => Promise<void>) => async () => {
  const f = await fixture()
  try {
    await body(f)
    // The scratch repository is gone on each path: accept, refuse, fault and timeout.
    expect(await readdir(f.scratchRoot)).toEqual([])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
}

test(
  "a result sealed by result.py is checked and published as agent-run/<id>",
  withFixture(async (f) => {
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "intended public content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    expect(result).toMatchObject({ sourceSha: f.sourceSha, ...wording })
    const exit = await publish(result, options(f))
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    const pushed = await remoteRef(f)
    expect(exit.value).toEqual({ ref: target.ref, sha: pushed })
    expect(await command(["git", "rev-parse", `${pushed}^`], f.remote)).toBe(f.sourceSha)
    expect(await command(["git", "show", `${pushed}:result.txt`], f.remote)).toBe(
      "intended public content",
    )
    expect(await command(["git", "log", "-1", "--format=%B", pushed], f.remote)).toBe(
      completion.commitMessage.trim(),
    )
  }),
)

test(
  "text that starts with a dash or names an option stays data in the seal and the push",
  withFixture(async (f) => {
    const dashed = {
      title: "--force",
      commitMessage: "--amend\n\n-m other",
      body: "-rf /\n\n--mirror",
      finalMessage: "--delete refs/heads/main",
    }
    const sealed = await sealWithResultPy(
      f,
      async (workspace) => {
        await writeFile(join(workspace, "-n"), "a file named like an option\n")
      },
      dashed,
    )
    const result = await decode(sealed.json, sealed.bundle)
    const { commitMessage: _commitMessage, ...dashedWording } = dashed
    expect(result).toMatchObject(dashedWording)
    const exit = await publish(result, options(f))
    expect(Exit.isSuccess(exit)).toBe(true)
    const pushed = await remoteRef(f)
    expect(await command(["git", "log", "-1", "--format=%B", pushed], f.remote)).toBe(
      dashed.commitMessage,
    )
    expect(await command(["git", "show", `${pushed}:-n`], f.remote)).toBe(
      "a file named like an option",
    )
    expect(await command(["git", "rev-parse", "main"], f.remote)).toBe(f.sourceSha)
  }),
)

for (const [name, fields, check] of [
  ["a newline in the title", { title: "one\ntwo" }, "title"],
  ["a NUL in the title", { title: "one\u0000two" }, "title"],
  ["a NUL in the body", { body: "one\u0000two" }, "body"],
  ["a NUL in the final message", { finalMessage: "one\u0000two" }, "final_message"],
  ["an empty title", { title: "" }, "title"],
  ["a title that is not text", { title: 7 }, "title"],
  ["a source that is not a commit id", { sourceSha: "--upload-pack=touch" }, "source"],
  ["a mention in the title", { title: "Ask @owner" }, "title"],
  ["HTML in the title", { title: "<img src=x>" }, "title"],
  ["a bidirectional control in the title", { title: "abc\u202edef" }, "title"],
  ["a mention in the body", { body: "Thanks @owner" }, "body"],
  ["an issue closing reference in the body", { body: "Closes #1" }, "body"],
  ["a link reference definition in the body", { body: "[x]: https://example.invalid" }, "body"],
  ["a character reference in the body", { body: "&#64;owner" }, "body"],
  ["a blank body", { body: " \n " }, "body"],
  [
    "a terminal control sequence in the final message",
    { finalMessage: "a \u001b[2J b" },
    "final_message",
  ],
  [
    "an operating system command in the final message",
    { finalMessage: "\u001b]8;;http://x\u001b\\" },
    "final_message",
  ],
  ["a carriage return in the final message", { finalMessage: "one\rtwo" }, "final_message"],
  [
    "a bidirectional control in the final message",
    { finalMessage: "abc\u202edef" },
    "final_message",
  ],
  ["a zero-width space in the final message", { finalMessage: "a\u200bb" }, "final_message"],
  ["a lone surrogate in the final message", { finalMessage: "a\ud800b" }, "final_message"],
  ["a final message over 64 KiB", { finalMessage: "a".repeat(64 * 1024 + 1) }, "final_message"],
] as const)
  test(`result.json with ${name} is refused`, async () => {
    const error = await Effect.runPromise(
      Effect.flip(decodeSealedResult(manifest("a".repeat(40), fields), new Uint8Array([1, 2, 3]))),
    )
    expect(error).toBeInstanceOf(SealedResultRefused)
    expect(error.check).toBe(check)
  })

test("result.json keeps a newline and a tab in the final message", async () => {
  const result = await Effect.runPromise(
    decodeSealedResult(
      manifest("a".repeat(40), { finalMessage: "Done.\n\tOne file: @owner <b> $x \\" }),
      new Uint8Array([1, 2, 3]),
    ),
  )
  expect(result.finalMessage).toBe("Done.\n\tOne file: @owner <b> $x \\")
})

test("result.json with a key outside SealedResult is refused by the name of the key", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      decodeSealedResult(manifest("a".repeat(40), { branch: "main" }), new Uint8Array([1, 2, 3])),
    ),
  )
  expect(error.check).toBe("unknown_key")
  expect(error.message).toBe('result_refused: unknown_key "branch"')
  // The commit object is the one source of the commit message.
  const message = await Effect.runPromise(
    Effect.flip(
      decodeSealedResult(
        manifest("a".repeat(40), { commitMessage: "m" }),
        new Uint8Array([1, 2, 3]),
      ),
    ),
  )
  expect(message.message).toBe('result_refused: unknown_key "commitMessage"')
  const missing = await Effect.runPromise(
    Effect.flip(
      decodeSealedResult(
        new TextEncoder().encode(JSON.stringify({ sourceSha: "a".repeat(40) })),
        new Uint8Array(),
      ),
    ),
  )
  expect(missing.check).toBe("missing_key")
  for (const raw of ["[]", "not json", JSON.stringify("x".repeat(300_000))]) {
    const invalid = await Effect.runPromise(
      Effect.flip(decodeSealedResult(new TextEncoder().encode(raw), new Uint8Array())),
    )
    expect(invalid.check).toBe("manifest")
  }
})

test(
  "hooks, filters and config of the caller never run: content is objects, the environment is fixed",
  withFixture(async (f) => {
    const marker = join(f.root, "executed")
    const hooks = join(f.root, "hooks")
    await mkdir(hooks)
    for (const hook of [
      "pre-push",
      "post-update",
      "reference-transaction",
      "post-checkout",
      "pre-receive",
      "update",
      "post-receive",
    ]) {
      await writeFile(join(hooks, hook), `#!/bin/sh\ntouch ${marker}\n`)
      await chmod(join(hooks, hook), 0o755)
    }
    const hostile = join(f.root, "hostile.gitconfig")
    await writeFile(
      hostile,
      `[core]\n\thooksPath = ${hooks}\n[filter "evil"]\n\tclean = touch ${marker}\n\tsmudge = touch ${marker}\n\tprocess = touch ${marker}\n[credential]\n\thelper = !touch ${marker}\n`,
    )
    const bundle = await handBundle(f, async (git, dir) => {
      await writeFile(join(dir, ".gitattributes"), "* filter=evil\n")
      await mkdir(join(dir, "hooks"))
      await writeFile(join(dir, "hooks", "post-checkout"), `#!/bin/sh\ntouch ${marker}\n`)
      await chmod(join(dir, "hooks", "post-checkout"), 0o755)
      await writeFile(join(dir, "pre-push"), `#!/bin/sh\ntouch ${marker}\n`)
      await git("add", "-A")
      await git("commit", "-q", "-m", "hook-named files and attributes")
    })
    const result = await decode(manifest(f.sourceSha), bundle)
    const saved = { ...process.env }
    try {
      process.env.GIT_CONFIG_GLOBAL = hostile
      process.env.GIT_CONFIG_PARAMETERS = `'core.hookspath'='${hooks}'`
      process.env.GIT_ASKPASS = join(hooks, "pre-push")
      const exit = await publish(result, options(f))
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    } finally {
      for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_PARAMETERS", "GIT_ASKPASS"])
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
    }
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(await command(["git", "show", `${await remoteRef(f)}:.gitattributes`], f.remote)).toBe(
      "* filter=evil",
    )
  }),
)

const GitCall = Schema.decodeUnknownSync(
  Schema.Struct({
    argv: Schema.Array(Schema.String),
    env: Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String)),
  }),
)

/** A git that records its arguments and environment, then runs the real git. */
async function recordingGit(f: Fixture) {
  const log = join(f.root, "git-calls.jsonl")
  const path = join(f.root, "recording-git")
  await writeFile(
    path,
    `#!/bin/sh\n/usr/bin/python3 -I -c 'import json,os,sys; open(sys.argv[1],"a").write(json.dumps({"argv":sys.argv[2:],"env":dict(os.environ)})+"\\n")' ${log} "$@"\nexec /usr/bin/git "$@"\n`,
  )
  await chmod(path, 0o755)
  const calls = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => GitCall(JSON.parse(line)))
  return { path, calls }
}

test(
  "the token reaches git only through the environment; a failed push holds it nowhere",
  withFixture(async (f) => {
    const recorder = await recordingGit(f)
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    const exit = await publish(result, options(f, { gitBinary: recorder.path }), () =>
      // The target ref appears in the remote after the check and before the push.
      command(["git", "update-ref", target.ref, f.sourceSha], f.remote).then(() => undefined),
    )
    const error = refusal(exit)
    expect(error.check).toBe("target_exists")
    const encoded = Buffer.from(`x-access-token:${token}`).toString("base64")
    const text = `${String(error)} ${JSON.stringify(error)} ${error.detail}`
    expect(text).not.toContain(token)
    expect(text).not.toContain(encoded)
    const calls = await recorder.calls()
    expect(calls.some((call) => call.argv.includes("push"))).toBe(true)
    for (const call of calls) {
      expect(call.argv.join("\n")).not.toContain(token)
      expect(call.argv.join("\n")).not.toContain(encoded)
      expect(call.argv).toContain("credential.helper=")
      expect(
        call.argv.some((arg) => arg.includes("--force") && !arg.startsWith("--force-with-lease=")),
      ).toBe(false)
      expect(call.argv.some((arg) => arg.startsWith("+"))).toBe(false)
      expect(call.env).toMatchObject({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        HOME: "/nonexistent",
        PATH: "/usr/bin:/bin",
      })
      for (const key of ["GIT_ASKPASS", "SSH_ASKPASS", "GIT_CONFIG_PARAMETERS", "GIT_TRACE"])
        expect(call.env[key]).toBeUndefined()
      const values = Object.entries(call.env)
      expect(values.filter(([, value]) => value?.includes(token))).toEqual([])
      if (call.env.GIT_CONFIG_COUNT !== undefined)
        expect(values.filter(([, value]) => value?.includes(encoded)).map(([key]) => key)).toEqual([
          "GIT_CONFIG_VALUE_0",
        ])
    }
    // Never forced: the ref that appeared keeps its value.
    expect(await remoteRef(f)).toBe(f.sourceSha)
  }),
)

test(
  "a git child gets the fixed environment and no variable of the daemon process",
  withFixture(async (f) => {
    const recorder = await recordingGit(f)
    const trace = join(f.root, "trace.log")
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    const daemon = {
      GIT_DIR: join(f.root, "elsewhere.git"),
      GIT_SSH_COMMAND: `touch ${join(f.root, "executed")}`,
      GIT_EXEC_PATH: join(f.root, "exec-path"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(f.work, ".git", "objects"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: join(f.root, "hooks"),
      GIT_TRACE: trace,
      https_proxy: "http://127.0.0.1:9",
    }
    const saved = Object.fromEntries(Object.keys(daemon).map((key) => [key, process.env[key]]))
    try {
      Object.assign(process.env, daemon)
      const exit = await publish(result, options(f, { gitBinary: recorder.path }))
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    const calls = await recorder.calls()
    expect(calls.length).toBeGreaterThan(5)
    for (const call of calls) {
      // PWD is set by the shell of the recording git, not by the daemon.
      expect(Object.keys(call.env).sort()).toEqual([
        "GIT_ALLOW_PROTOCOL",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_VALUE_0",
        "GIT_NO_REPLACE_OBJECTS",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "LC_ALL",
        "PATH",
        "PWD",
      ])
      expect(call.env.GIT_CONFIG_COUNT).toBe("1")
      expect(call.env.GIT_CONFIG_KEY_0).toBe(`http.${f.remote}.extraHeader`)
    }
    expect(await Bun.file(trace).exists()).toBe(false)
    expect(await Bun.file(join(f.root, "executed")).exists()).toBe(false)
  }),
)

test(
  "the push token of the installation is asked for contents only, reaches git as a header, and is revoked after the push",
  withFixture(async (f) => {
    const stub = await githubApiStub(undefined, token)
    try {
      const policy = { repository: "fixture/repo", repositoryId: 12, installationId: 34 }
      const recorder = await recordingGit(f)
      const sealed = await sealWithResultPy(f, async (workspace) => {
        await writeFile(join(workspace, "result.txt"), "content\n")
      })
      const result = await decode(sealed.json, sealed.bundle)
      const publishWithToken = () =>
        Effect.runPromiseExit(
          stub.github.withPushToken(policy, (pushToken) =>
            Effect.scoped(
              Effect.gen(function* () {
                const opts = options(f, { token: pushToken, gitBinary: recorder.path })
                return yield* pushSealedResult(yield* checkSealedResult(result, target, opts))
              }),
            ),
          ),
        )
      expect(Exit.isSuccess(await publishWithToken())).toBe(true)
      const push = (await recorder.calls()).find((call) => call.argv.includes("push"))!
      expect(push.env.GIT_CONFIG_KEY_0).toBe(`http.${f.remote}.extraHeader`)
      expect(push.env.GIT_CONFIG_VALUE_0).toBe(
        `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      )
      // A second publication of the same result fails, and its token is revoked too.
      expect(refusedCheck(await publishWithToken())).toBe("target_exists")
      expect(stub.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        "POST /app/installations/34/access_tokens",
        "DELETE /installation/token",
        "POST /app/installations/34/access_tokens",
        "DELETE /installation/token",
      ])
      expect(stub.minted()).toEqual([
        { repository_ids: [12], permissions: { contents: "write" } },
        { repository_ids: [12], permissions: { contents: "write" } },
      ])
      expect(stub.revoked().map((request) => request.authorization)).toEqual([
        `token ${token}`,
        `token ${token}`,
      ])
    } finally {
      await stub.close()
    }
  }),
)

test(
  "a push with an expected head fast-forwards a target whose head is equal, and refuses one that moved",
  withFixture(async (f) => {
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    const existing = { ref: "refs/heads/agent-run/existing", expectedHead: f.sourceSha }
    await command(["git", "update-ref", existing.ref, f.sourceSha], f.remote)
    const exit = await publish(result, options(f), undefined, existing)
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    expect(exit.value.ref).toBe(existing.ref)
    expect(await remoteRef(f, existing.ref)).toBe(exit.value.sha)
    // The head moves between the check and the push: the push is refused, never forced.
    const moving = { ref: "refs/heads/agent-run/moving", expectedHead: f.sourceSha }
    await command(["git", "update-ref", moving.ref, f.sourceSha], f.remote)
    const moved = await run(
      ["git", "commit-tree", "-m", "moved", `${f.sourceSha}^{tree}`],
      f.remote,
    )
    const refusedPush = await publish(
      result,
      options(f),
      () => command(["git", "update-ref", moving.ref, moved], f.remote).then(() => undefined),
      moving,
    )
    expect(refusedCheck(refusedPush)).toBe("target_moved")
    expect(await remoteRef(f, moving.ref)).toBe(moved)
  }),
)

test(
  "a bundle whose ref names no commit of its pack is refused",
  withFixture(async (f) => {
    const bundle = await handBundle(f, (git, dir) => commitFile(git, dir, "a.txt"))
    const blob = await run(["git", "hash-object", "--stdin"], f.root, "content\n")
    for (const sha of [blob, "f".repeat(40)]) {
      const named = withHeader(bundle, (lines) =>
        lines.map((line) =>
          line.replace(/^[0-9a-f]{40} refs\/workflowd\/result$/, `${sha} refs/workflowd/result`),
        ),
      )
      const exit = await publish(await decode(manifest(f.sourceSha), named), options(f))
      expect(refusedCheck(exit)).toBe("ref")
      expect(refusal(exit).detail).toBe("the ref of the bundle names no commit of its pack")
    }
  }),
)

test(
  "a target ref that exists before the check is refused, and a wrong expected head is refused",
  withFixture(async (f) => {
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    await command(["git", "update-ref", target.ref, f.sourceSha], f.remote)
    expect(refusedCheck(await publish(result, options(f)))).toBe("target_exists")
    const moved = await run(
      ["git", "commit-tree", "-m", "moved", `${f.sourceSha}^{tree}`],
      f.remote,
    )
    await command(["git", "update-ref", "refs/heads/agent-run/run-2", moved], f.remote)
    expect(
      refusedCheck(
        await publish(result, options(f), undefined, {
          ref: "refs/heads/agent-run/run-2",
          expectedHead: f.sourceSha,
        }),
      ),
    ).toBe("target_moved")
    expect(await remoteRef(f)).toBe(f.sourceSha)
  }),
)

/** The git calls a recording git made; none when no git ran. */
const recordedCalls = async (f: Fixture, recorder: Awaited<ReturnType<typeof recordingGit>>) =>
  (await Bun.file(join(f.root, "git-calls.jsonl")).exists()) ? recorder.calls() : []

test(
  "a bundle whose objects declare more than the bound is refused before git unpacks it",
  withFixture(async (f) => {
    const recorder = await recordingGit(f)
    // 80 MiB of zeros compress to well under the 16 MiB bundle bound.
    const bundle = await handBundle(f, async (git, dir) => {
      await writeFile(join(dir, "zeros.bin"), new Uint8Array(80 * 1024 * 1024))
      await git("add", "zeros.bin")
      await git("commit", "-q", "-m", "expands")
    })
    expect(bundle.byteLength).toBeLessThan(sealedResultLimits.bundleBytes)
    const result = await decode(manifest(f.sourceSha), bundle)
    const started = Date.now()
    const exit = await publish(result, options(f, { gitBinary: recorder.path }))
    expect(refusedCheck(exit)).toBe("object_bytes")
    // The walk refuses at the declared size of the object, before any inflation.
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(
      (await recordedCalls(f, recorder)).some((call) => call.argv.includes("index-pack")),
    ).toBe(false)
    expect(await remoteRef(f)).toBe("")
  }),
  60_000,
)

// Packs built byte by byte, as a misbehaving runner could send them.
const MiB = 1024 * 1024
const concat = (...parts: ReadonlyArray<Uint8Array | string>) =>
  Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part)))
const uint32 = (value: number) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}
/** The type and size of a pack object: 4 bits of size in the first byte, then 7 per byte. */
const objectHeader = (type: number, size: number) => {
  const bytes = [(type << 4) | (size & 0x0f)]
  for (let rest = Math.floor(size / 16); rest > 0; rest = Math.floor(rest / 128)) {
    bytes[bytes.length - 1]! |= 0x80
    bytes.push(rest & 0x7f)
  }
  return Uint8Array.from(bytes)
}
/** A size of a delta: 7 bits per byte, low bits first. */
const deltaSize = (size: number) => {
  const bytes: number[] = []
  for (let rest = size; ; rest = Math.floor(rest / 128)) {
    bytes.push((rest & 0x7f) | (rest >= 128 ? 0x80 : 0))
    if (rest < 128) return Uint8Array.from(bytes)
  }
}
const objectTypes = { commit: 1, tree: 2, blob: 3 } as const
const objectId = (type: keyof typeof objectTypes, content: Uint8Array) =>
  createHash("sha1")
    .update(concat(`${type} ${content.byteLength}\0`, content))
    .digest()
const blobId = (content: Uint8Array) => objectId("blob", content)
const objectEntry = (type: keyof typeof objectTypes, content: Uint8Array) =>
  concat(objectHeader(objectTypes[type], content.byteLength), deflateSync(content))
const blobEntry = (content: Uint8Array) => objectEntry("blob", content)
const refDeltaEntry = (base: Uint8Array, delta: Uint8Array) =>
  concat(objectHeader(7, delta.byteLength), base, deflateSync(delta))
const pack = (
  entries: ReadonlyArray<Uint8Array>,
  header: { version?: number; count?: number } = {},
) => {
  const body = concat(
    "PACK",
    uint32(header.version ?? 2),
    uint32(header.count ?? entries.length),
    ...entries,
  )
  return concat(body, createHash("sha1").update(body).digest())
}
const packBundle = (f: Fixture, packBytes: Uint8Array) =>
  concat(
    `# v2 git bundle\n-${f.sourceSha} base\n${"f".repeat(40)} refs/workflowd/result\n\n`,
    packBytes,
  )
/** A zlib stream of `mebibytes` MiB of zeros, from one flushed block repeated. */
const zerosStream = (mebibytes: number) => {
  const block = deflateRawSync(new Uint8Array(MiB), { finishFlush: zlibConstants.Z_FULL_FLUSH })
  const adler = uint32((((mebibytes * MiB) % 65521) * 65536 + 1) >>> 0)
  return concat(
    Uint8Array.from([0x78, 0x01]),
    ...Array.from({ length: mebibytes }, () => block),
    Uint8Array.from([0x03, 0x00]),
    adler,
  )
}
test(
  "a small pack with one delta whose result is above the bound is refused before git unpacks it",
  withFixture(async (f) => {
    const recorder = await recordingGit(f)
    const base = new Uint8Array(64 * 1024)
    // Each 0x80 copies 64 KiB of the base: 1120 of them make a 70 MiB blob.
    const copies = 1120
    const delta = concat(
      deltaSize(base.byteLength),
      deltaSize(copies * base.byteLength),
      new Uint8Array(copies).fill(0x80),
    )
    const bundle = packBundle(f, pack([blobEntry(base), refDeltaEntry(blobId(base), delta)]))
    expect(bundle.byteLength).toBeLessThan(4096)
    const exit = await publish(
      await decode(manifest(f.sourceSha), bundle),
      options(f, { gitBinary: recorder.path }),
    )
    expect(refusedCheck(exit)).toBe("object_bytes")
    expect(
      (await recordedCalls(f, recorder)).some((call) => call.argv.includes("index-pack")),
    ).toBe(false)
  }),
)

test(
  "a pack whose header gives a size below what its stream inflates to is refused, inflating no more than the size",
  withFixture(async (f) => {
    // The header says 10 bytes; the stream holds 256 MiB of zeros.
    const bundle = packBundle(f, pack([concat(objectHeader(3, 10), zerosStream(256))]))
    const result = await decode(manifest(f.sourceSha), bundle)
    const peak = process.resourceUsage().maxRSS
    const exit = await publish(result, options(f))
    expect(refusedCheck(exit)).toBe("bundle_format")
    // The peak memory of the process (KiB) grew by far less than the stream holds.
    expect(process.resourceUsage().maxRSS - peak).toBeLessThan(128 * 1024)
  }),
  30_000,
)

const blob = blobEntry(new TextEncoder().encode("content\n"))
for (const [name, check, packBytes] of [
  [
    "a zlib stream that is cut",
    "bundle_format",
    () => pack([blob.subarray(0, blob.byteLength - 3)]),
  ],
  ["bytes after the trailer of the pack", "bundle_format", () => concat(pack([blob]), "x")],
  [
    "a count of objects above the objects present",
    "bundle_format",
    () => pack([blob], { count: 2 }),
  ],
  [
    "a count of objects below the objects present",
    "bundle_format",
    () => pack([blob, blob], { count: 1 }),
  ],
  ["a pack of version 3", "bundle_format", () => pack([blob], { version: 3 })],
  ["a pack too short for its header and trailer", "bundle_format", () => pack([]).subarray(0, 31)],
  ["a pack that is not a pack", "bundle_format", () => concat("KCAP", pack([blob]).subarray(4))],
  [
    `a header count of ${sealedResultLimits.objects + 1} objects`,
    "object_count",
    () => pack([], { count: sealedResultLimits.objects + 1 }),
  ],
  [
    `a header count of ${sealedResultLimits.objects} objects and none present`,
    "bundle_format",
    () => pack([], { count: sealedResultLimits.objects }),
  ],
] as const)
  test(
    `the walk of the pack refuses ${name}: result_refused: ${check}`,
    withFixture(async (f) => {
      const exit = await publish(
        await decode(manifest(f.sourceSha), packBundle(f, packBytes())),
        options(f),
      )
      expect(refusedCheck(exit)).toBe(check)
    }),
  )

/** A bundle of the result with its header lines changed. */
const withHeader = (bundle: Uint8Array, change: (lines: string[]) => string[]) => {
  const end = Buffer.from(bundle).indexOf("\n\n") + 1
  const lines = new TextDecoder().decode(bundle.subarray(0, end)).split("\n").slice(0, -1)
  return concat(change(lines).join("\n"), "\n", bundle.subarray(end))
}

test(
  "a header line of 4096 bytes is read, and one of 4097 bytes is refused",
  withFixture(async (f) => {
    const bundle = await handBundle(f, (git, dir) => commitFile(git, dir, "a.txt"))
    const prerequisite = (length: number) =>
      withHeader(bundle, ([signature, , ...rest]) => [
        signature!,
        `-${f.sourceSha} ${"x".repeat(length - 42)}`,
        ...rest,
      ])
    const long = await publish(await decode(manifest(f.sourceSha), prerequisite(4097)), options(f))
    expect(refusedCheck(long)).toBe("bundle_format")
    const exit = await publish(await decode(manifest(f.sourceSha), prerequisite(4096)), options(f))
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
  }),
)

test(
  "a header of 16 lines is read, and one of 17 lines is refused",
  withFixture(async (f) => {
    const bundle = await handBundle(f, (git, dir) => commitFile(git, dir, "a.txt"))
    const lines = (count: number) =>
      withHeader(bundle, ([signature, ...rest]) => [
        signature!,
        ...Array.from(
          { length: count - rest.length },
          (_, index) => `-${index.toString(16).padStart(40, "0")}`,
        ),
        ...rest,
      ])
    // Sixteen lines are read; their extra prerequisites are refused by the base rule.
    expect(
      refusedCheck(await publish(await decode(manifest(f.sourceSha), lines(16)), options(f))),
    ).toBe("base")
    expect(
      refusedCheck(await publish(await decode(manifest(f.sourceSha), lines(17)), options(f))),
    ).toBe("bundle_format")
  }),
)

/** A source commit with `mebibytes` MiB of random bytes in big.bin, stored uncompressed in the remote. */
async function bigSource(f: Fixture, mebibytes: number) {
  await writeFile(join(f.work, "big.bin"), randomBytes(mebibytes * MiB))
  await f.git(f.work, "-c", "core.compression=0", "add", "big.bin")
  await f.git(f.work, "commit", "-q", "-m", "big")
  await f.git(f.remote, "config", "receive.unpackLimit", "1")
  await f.git(f.work, "-c", "core.compression=0", "push", "-q", f.remote, "HEAD:refs/heads/main")
  return f.git(f.work, "rev-parse", "HEAD")
}

/**
 * A thin bundle of one commit that adds a 1-byte file as a delta against big.bin of
 * the source: index-pack --fix-thin copies the whole base into the scratch.
 */
async function thinBundle(f: Fixture, sourceSha: string) {
  const big = await readFile(join(f.work, "big.bin"))
  const small = big.subarray(0, 1)
  const entries = (await f.git(f.work, "ls-tree", sourceSha)).split("\n").map((line) => {
    const [meta, name] = line.split("\t")
    const [mode, , sha] = meta!.split(" ")
    return { mode: mode!, name: name!, sha: Buffer.from(sha!, "hex") }
  })
  entries.push({ mode: "100644", name: "small.txt", sha: blobId(small) })
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
  const tree = concat(...entries.map((entry) => concat(`${entry.mode} ${entry.name}\0`, entry.sha)))
  const commit = Buffer.from(
    `tree ${objectId("tree", tree).toString("hex")}\nparent ${sourceSha}\nauthor ${agentLine}\ncommitter ${agentLine}\n\nAdd a small file\n`,
  )
  // Copy one byte at offset 0 of the base.
  const delta = concat(deltaSize(big.byteLength), deltaSize(1), Uint8Array.from([0x90, 0x01]))
  const packBytes = pack([
    objectEntry("commit", commit),
    objectEntry("tree", tree),
    refDeltaEntry(blobId(big), delta),
  ])
  return concat(
    `# v2 git bundle\n-${sourceSha} base\n${objectId("commit", commit).toString("hex")} refs/workflowd/result\n\n`,
    packBytes,
  )
}

/** The bytes below a directory, read again every few milliseconds while `work` runs. */
async function peakBytes<A>(directory: string, work: () => Promise<A>) {
  let peak = 0
  let sampling = true
  const size = async () => {
    let total = 0
    for (const entry of await readdir(directory, { recursive: true }).catch(() => []))
      total += await lstat(join(directory, entry)).then(
        (stat) => stat.size,
        () => 0,
      )
    return total
  }
  const sampler = (async () => {
    while (sampling) {
      peak = Math.max(peak, await size())
      await Bun.sleep(2)
    }
  })()
  try {
    const value = await work()
    return { value, peak }
  } finally {
    sampling = false
    await sampler
  }
}

for (const [name, mebibytes] of [
  ["a source whose pack is above a third of the disk bound", 70],
  ["a thin bundle whose bases fill what the source left of the disk bound", 36],
] as const)
  test(
    `the scratch of a check stays below the disk bound at each moment: ${name}`,
    withFixture(async (f) => {
      const sourceSha = await bigSource(f, mebibytes)
      const result = await decode(manifest(sourceSha), await thinBundle(f, sourceSha))
      const { value: exit, peak } = await peakBytes(f.scratchRoot, () =>
        publish(result, options(f, { sourceSha })),
      )
      expect(peak).toBeGreaterThan(0)
      expect(peak).toBeLessThan(sealedResultLimits.diskBytes)
      expect(refusedCheck(exit)).toBe("disk_limit")
      expect(await remoteRef(f)).toBe("")
    }),
    60_000,
  )

test(
  `at most ${sealedResultLimits.concurrentChecks} checks hold a scratch directory at one time`,
  withFixture(async (f) => {
    const slow = join(f.root, "slow-init-git")
    await writeFile(
      slow,
      '#!/bin/sh\nfor arg; do [ "$arg" = init ] && sleep 1; done\nexec /usr/bin/git "$@"\n',
    )
    await chmod(slow, 0o755)
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    let most = 0
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        most = Math.max(most, (await readdir(f.scratchRoot)).length)
        await Bun.sleep(5)
      }
    })()
    const runs = Array.from({ length: sealedResultLimits.concurrentChecks + 1 }, (_, index) =>
      publish(result, options(f, { gitBinary: slow }), undefined, {
        ref: `refs/heads/agent-run/run-${index}`,
        expectedHead: null,
      }),
    )
    const exits = await Promise.all(runs)
    sampling = false
    await sampler
    for (const exit of exits) expect(Exit.isSuccess(exit)).toBe(true)
    expect(most).toBe(sealedResultLimits.concurrentChecks)
  }),
  30_000,
)

test(
  "the check is ended at its time limit and refuses",
  withFixture(async (f) => {
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    const slow = join(f.root, "slow-git")
    await writeFile(slow, '#!/bin/sh\nsleep 30\nexec /usr/bin/git "$@"\n')
    await chmod(slow, 0o755)
    const started = Date.now()
    const exit = await publish(result, options(f, { gitBinary: slow, timeLimitMs: 500 }))
    expect(refusedCheck(exit)).toBe("time_limit")
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await remoteRef(f)).toBe("")
  }),
)

/** Whether a process runs: it exists and is not a zombie that waits for its parent. */
const alive = async (pid: number) => {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
  return stat !== "" && stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z"
}

/** Whether a process has ended within a second; a killed process needs a moment to be scheduled. */
const ends = async (pid: number) => {
  for (const deadline = Date.now() + 1_000; Date.now() < deadline; await Bun.sleep(10))
    if (!(await alive(pid))) return true
  return false
}

test(
  "an interrupted check kills the process group of its git child at once and removes its scratch directory",
  withFixture(async (f) => {
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    // A git that never ends, with a child of its own in its process group.
    const pids = join(f.root, "pids")
    const endless = join(f.root, "endless-git")
    await writeFile(endless, `#!/bin/sh\nsleep 300 &\necho "$$ $!" > ${pids}\nwait\n`)
    await chmod(endless, 0o755)
    const fiber = Effect.runFork(
      Effect.scoped(checkSealedResult(result, target, options(f, { gitBinary: endless }))),
    )
    while (!(await Bun.file(pids).exists()) || (await Bun.file(pids).text()) === "")
      await Bun.sleep(10)
    const [git, child] = (await Bun.file(pids).text()).trim().split(" ").map(Number)
    expect((await alive(git!)) && (await alive(child!))).toBe(true)
    const started = Date.now()
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(await ends(git!)).toBe(true)
    expect(await ends(child!)).toBe(true)
    expect(await readdir(f.scratchRoot)).toEqual([])
  }),
)

test(
  "what an earlier process left below the scratch root is removed, and a root others can use is a fault",
  withFixture(async (f) => {
    const stale = join(f.scratchRoot, "sealed-result-earlier")
    await mkdir(join(stale, "repository.git"), { recursive: true })
    await writeFile(join(stale, "repository.git", "pack"), "left by a process that ended\n")
    await Effect.runPromise(removeSealedResultScratch(f.scratchRoot))
    expect(await readdir(f.scratchRoot)).toEqual([])
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    await chmod(f.scratchRoot, 0o755)
    try {
      const shared = await publish(result, options(f))
      expect(failure(shared)).toBeInstanceOf(SealedResultFault)
      expect(String(failure(shared))).toContain("Scratch root")
      expect(
        failure(await Effect.runPromiseExit(removeSealedResultScratch(f.scratchRoot))),
      ).toBeInstanceOf(SealedResultFault)
    } finally {
      await chmod(f.scratchRoot, 0o700)
    }
    // A root that does not exist yet is made with mode 0700.
    const fresh = join(f.root, "fresh-root")
    const exit = await publish(result, options(f, { scratchRoot: fresh }))
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    expect((await lstat(fresh)).mode & 0o777).toBe(0o700)
    expect(await readdir(fresh)).toEqual([])
  }),
)

test(
  "a fault of the remote is a fault, not a refusal, and removes the scratch repository",
  withFixture(async (f) => {
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    const exit = await publish(result, options(f, { remote: join(f.root, "missing.git") }))
    expect(failure(exit)).toBeInstanceOf(SealedResultFault)
  }),
)

/** A name in a test title, with each character outside printable ASCII as an escape. */
const shown = (name: string) =>
  JSON.stringify(name).replace(
    /[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )

const refusals: ReadonlyArray<
  readonly [
    string,
    SealedResultCheck,
    (f: Fixture) => Promise<{ bundle: Uint8Array; json?: Uint8Array }>,
    detail?: string,
  ]
> = [
  [
    "a bundle over 16 MiB",
    "bundle_size",
    async () => ({ bundle: new Uint8Array(sealedResultLimits.bundleBytes + 1) }),
  ],
  [
    "a bundle that is not a v2 bundle",
    "bundle_format",
    async () => ({ bundle: new TextEncoder().encode("# v3 git bundle\n\n") }),
  ],
  [
    "a bundle with no prerequisite",
    "base",
    async (f) => ({
      bundle: await handBundle(
        f,
        (git, dir) => commitFile(git, dir, "a.txt"),
        () => ["refs/workflowd/result"],
      ),
    }),
  ],
  [
    "a bundle based on another commit",
    "base",
    async (f) => ({
      bundle: await handBundle(
        f,
        async (git, dir) => {
          await commitFile(git, dir, "a.txt")
          await commitFile(git, dir, "b.txt")
        },
        () => ["refs/workflowd/result", "^HEAD~1"],
      ),
    }),
  ],
  [
    "a result for another source",
    "source",
    async (f) => ({
      bundle: await handBundle(f, (git, dir) => commitFile(git, dir, "a.txt")),
      json: manifest("b".repeat(40)),
    }),
  ],
  [
    "a bundle with two refs",
    "ref",
    async (f) => ({
      bundle: await handBundle(
        f,
        async (git, dir) => {
          await commitFile(git, dir, "a.txt")
          await git("update-ref", "refs/heads/extra", "HEAD")
        },
        () => ["refs/workflowd/result", "refs/heads/extra", `^${f.sourceSha}`],
      ),
    }),
  ],
  [
    "a bundle whose ref is a branch",
    "ref",
    async (f) => ({
      bundle: await handBundle(
        f,
        async (git, dir) => {
          await commitFile(git, dir, "a.txt")
          await git("update-ref", "refs/heads/main", "HEAD")
        },
        () => ["refs/heads/main", `^${f.sourceSha}`],
      ),
    }),
  ],
  [
    "a merge in the history",
    "linear_history",
    async (f) => ({
      bundle: await handBundle(f, async (git, dir) => {
        await git("checkout", "-q", "-b", "side")
        await commitFile(git, dir, "side.txt")
        await git("checkout", "-q", "main")
        await commitFile(git, dir, "main.txt")
        await git("merge", "-q", "--no-ff", "-m", "merge", "side")
      }),
    }),
  ],
  [
    "101 commits",
    "commit_count",
    async (f) => ({
      bundle: await handBundle(f, async (git) => {
        for (let index = 0; index < 101; index++)
          await git("commit", "-q", "--allow-empty", "-m", `empty ${index}`)
      }),
    }),
  ],
  [
    "more than 10 000 objects",
    "object_count",
    async (f) => ({
      bundle: await handBundle(f, async (git, dir) => {
        await mkdir(join(dir, "many"))
        for (let index = 0; index < 10_001; index++)
          await writeFile(join(dir, "many", String(index)), `${index}\n`)
        await git("add", "many")
        await git("commit", "-q", "-m", "many")
      }),
    }),
  ],
  [
    "a blob over 1 MiB",
    "blob_size",
    async (f) => ({
      bundle: await handBundle(f, (git, dir) =>
        commitFile(git, dir, "big.bin", new Uint8Array(1024 * 1024 + 1).fill(7)),
      ),
    }),
  ],
  [
    "101 changed paths",
    "changed_paths",
    async (f) => ({
      bundle: await handBundle(f, async (git, dir) => {
        for (let index = 0; index < 101; index++)
          await writeFile(join(dir, `file-${index}.txt`), `${index}\n`)
        await git("add", ".")
        await git("commit", "-q", "-m", "many paths")
      }),
    }),
  ],
  [
    "a symlink",
    "file_mode",
    async (f) => ({
      bundle: await handBundle(f, async (git, dir) => {
        await symlink("/etc/passwd", join(dir, "link"))
        await git("add", "link")
        await git("commit", "-q", "-m", "link")
      }),
    }),
  ],
  [
    "a submodule",
    "file_mode",
    async (f) => ({
      bundle: await handBundle(f, async (git) => {
        await git("update-index", "--add", "--cacheinfo", `160000,${f.sourceSha},module`)
        await git("commit", "-q", "-m", "module")
      }),
    }),
  ],
  [
    "a mode change",
    "mode_change",
    async (f) => ({
      bundle: await handBundle(f, async (git) => {
        await git("update-index", "--chmod=-x", "run.sh")
        await git("commit", "-q", "-m", "mode")
      }),
    }),
  ],
  // The strict check of git refuses each name a checkout on Windows or macOS maps to .git.
  ...[
    ".GIT",
    ".git.",
    ".git ",
    "git~1",
    "GIT~1",
    ".g\u200cit",
    ".git\ufeff",
    ".git::$INDEX_ALLOCATION",
  ].map(
    (name) =>
      [
        `a tree entry ${shown(name)}`,
        "fsck",
        async (f: Fixture) => ({
          bundle: await handBundle(f, async (git, dir) => {
            const content = await git("hash-object", "-w", "README.md")
            const inner = await mktree(dir, `100644 blob ${content}\tconfig\n`)
            const entries = await git("ls-tree", await git("write-tree"))
            const tree = await mktree(dir, `${entries}\n040000 tree ${inner}\t${name}\n`)
            const commit = await git("commit-tree", tree, "-p", "HEAD", "-m", "dot git")
            await git("reset", "-q", "--soft", commit)
          }),
        }),
      ] as const,
  ),
  // Each first path component a checkout on Windows or macOS maps to .github.
  ...[
    ".GitHub",
    ".github.",
    ".github...",
    ".github ",
    ".github. .",
    "GITHUB~1",
    "github~2",
    "GI3F2A~1",
    ".git\u200chub",
    ".github\u200d",
    "\ufeff.github",
    ".g\u0131thub",
    "\uff0egithub",
    ".github::$INDEX_ALLOCATION",
  ].map(
    (name) =>
      [
        `a path below ${shown(name)}`,
        "github_path",
        async (f: Fixture) => ({
          bundle: await handBundle(f, (git, dir) =>
            commitFile(git, dir, `${name}/workflows/x.yml`, "on: push\n"),
          ),
        }),
      ] as const,
  ),
  [
    "a commit message with terminal control sequences and a blocked co-author",
    "commit_message",
    async (f) => ({
      bundle: await handBundle(f, (_git, dir) =>
        commitObject(
          f,
          dir,
          "",
          "title \u001b[2J \u001b]8;;http://x \u001b\\link\n\nCo-authored-by: Owner <owner@example.invalid>\n",
        ),
      ),
    }),
    "names a blocked address",
  ],
  [
    "a commit message that names a blocked address in other letters",
    "commit_message",
    async (f) => ({
      bundle: await handBundle(f, (_git, dir) =>
        commitObject(f, dir, "", "Change\n\nCo-authored-by: Owner <OWNER@Example.INVALID>\n"),
      ),
    }),
    "names a blocked address",
  ],
  [
    "a commit message with a terminal control sequence",
    "commit_message",
    async (f) => ({
      bundle: await handBundle(f, (_git, dir) => commitObject(f, dir, "", "title \u001b[2J\n")),
    }),
    "the text rules of a commit message",
  ],
  [
    "a commit message over 10 KiB",
    "commit_message",
    async (f) => ({
      bundle: await handBundle(f, (_git, dir) =>
        commitObject(f, dir, "", `${"a".repeat(sealedResultLimits.commitMessageBytes)}\n`),
      ),
    }),
    "the text rules of a commit message",
  ],
  [
    "a commit by a person whose address is not blocked",
    "identity",
    async (f) => ({
      bundle: await handBundle(f, (_git, dir) =>
        commitObject(f, dir, "", "Change\n", "Ada Lovelace <ada@example.invalid>"),
      ),
    }),
  ],
  [
    "a commit whose committer is not the agent",
    "identity",
    async (f) => ({
      bundle: await handBundle(f, (_git, dir) =>
        commitObject(f, dir, "", "Change\n", undefined, "Fixture Agent <other@example.invalid>"),
      ),
    }),
  ],
  [
    "a commit with a signature header",
    "commit_format",
    async (f) => ({
      bundle: await handBundle(f, (_git, dir) =>
        commitObject(
          f,
          dir,
          "gpgsig -----BEGIN PGP SIGNATURE-----\n \n AAAA\n -----END PGP SIGNATURE-----\n",
          "Change\n",
        ),
      ),
    }),
  ],
  [
    "a commit with an encoding header",
    "commit_format",
    async (f) => ({
      bundle: await handBundle(f, (_git, dir) =>
        commitObject(f, dir, "encoding ISO-8859-1\n", "Change\n"),
      ),
    }),
  ],
  [
    "a commit with a merge tag header",
    "commit_format",
    async (f) => ({
      bundle: await handBundle(f, (_git, dir) =>
        commitObject(f, dir, `mergetag object ${f.sourceSha}\n type commit\n`, "Change\n"),
      ),
    }),
  ],
  [
    "a commit with an unknown header",
    "commit_format",
    async (f) => ({
      bundle: await handBundle(f, (_git, dir) =>
        commitObject(f, dir, "x-note anything\n", "Change\n"),
      ),
    }),
  ],
]

const agentLine = `${agentGit.name} <${agentGit.email}> 946684800 +0000`

/** Writes a commit object by hand on top of HEAD, with its tree, and moves HEAD to it. */
async function commitObject(
  f: Fixture,
  dir: string,
  headers: string,
  message: string,
  author = agentLine,
  committer = agentLine,
): Promise<string> {
  await writeFile(join(dir, `${crypto.randomUUID()}.txt`), "change\n")
  await f.git(dir, "add", "-A")
  const tree = await f.git(dir, "write-tree")
  const parent = await f.git(dir, "rev-parse", "HEAD")
  const stamp = (who: string) => (who.includes(" +0000") ? who : `${who} 946684800 +0000`)
  const raw = `tree ${tree}\nparent ${parent}\nauthor ${stamp(author)}\ncommitter ${stamp(committer)}\n${headers}\n${message}`
  const commit = await run(["git", "hash-object", "-t", "commit", "-w", "--stdin"], dir, raw)
  await f.git(dir, "reset", "-q", "--soft", commit)
  return commit
}

test(
  "each commit of the result is checked: a fault in the first of two commits is refused",
  withFixture(async (f) => {
    let first = ""
    const bundle = await handBundle(f, async (git, dir) => {
      first = await commitObject(f, dir, "", "first \u001b[31mred\n")
      await commitFile(git, dir, "second.txt")
    })
    const exit = await publish(await decode(manifest(f.sourceSha), bundle), options(f))
    expect(refusedCheck(exit)).toBe("commit_message")
    expect(refusal(exit).detail).toContain(first)
    expect(await remoteRef(f)).toBe("")
  }),
)

/** `git mktree` in the hand repository, with its input on stdin. */
async function mktree(cwd: string, input: string): Promise<string> {
  const args = ["git", "mktree"]
  const child = Bun.spawn(args, { cwd, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" })
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (status !== 0) throw new Error(`${args.join(" ")} exited ${status}: ${stderr}`)
  return stdout.trim()
}

for (const [name, check, make, detail] of refusals)
  test(
    `the daemon refuses ${name}: result_refused: ${check}`,
    withFixture(async (f) => {
      const made = await make(f)
      const result = await decode(made.json ?? manifest(f.sourceSha), made.bundle)
      const exit = await publish(result, options(f))
      expect(refusedCheck(exit)).toBe(check)
      expect(refusal(exit).message).toStartWith(`result_refused: ${check}`)
      if (detail !== undefined) expect(refusal(exit).detail).toContain(detail)
      expect(await remoteRef(f)).toBe("")
    }),
    30_000,
  )
