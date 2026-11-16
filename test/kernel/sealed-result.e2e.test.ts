import { expect, test } from "bun:test"
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Redacted,
  Scheduler,
  Schema,
  Scope,
} from "effect"
import {
  chmod,
  link,
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
  githubRemote,
  decodeSealedResult,
  makeSealedResultGit,
  pushSealedResult,
  SealedResultFault,
  SealedResultGit,
  SealedResultGitLive,
  SealedResultRefused,
  sealedResultLimits,
  type SealedResult,
  type SealedResultCheck,
  type SealedResultGitPort,
  type SealedResultGitSettings,
  type SealedResultOptions,
} from "../../src/kernel/sealed-result"
import { githubApiStub } from "../sandbox/github-api-stub"
import { command } from "../sandbox/harness"
import {
  hostileValues,
  pathBytes,
  sealedTextCases,
  type SealedTextField,
} from "./sealed-text-cases"

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

/** The options of one check, and the settings of the git runner that a test builds for it. */
type CheckOptions = SealedResultOptions<unknown> & { readonly git: SealedResultGitSettings }

/**
 * The daemon's settings, but a remote on disk: the test runner permits the `file`
 * protocol and any remote, which the daemon's runner does not.
 */
const options = (
  f: Fixture,
  extra: Partial<SealedResultOptions<unknown>> & Partial<SealedResultGitSettings> = {},
): CheckOptions => {
  const { scratchRoot, binary, timeLimitMs, waitLimitMs, protocols, remoteAllowed, ...check } =
    extra
  return {
    remote: f.remote,
    sourceSha: f.sourceSha,
    token: Effect.succeed(Redacted.make(token)),
    agentGit,
    ...check,
    git: {
      scratchRoot: scratchRoot ?? f.scratchRoot,
      binary: binary ?? "/usr/bin/git",
      timeLimitMs: timeLimitMs ?? sealedResultLimits.timeLimitMs,
      waitLimitMs: waitLimitMs ?? sealedResultLimits.waitLimitMs,
      protocols: protocols ?? ["file"],
      remoteAllowed: remoteAllowed ?? (() => true),
    },
  }
}

/** A git runner of the tests, built by the constructor of the daemon's runner. */
const gitLayer = (settings: SealedResultGitSettings) =>
  Layer.effect(SealedResultGit, makeSealedResultGit(settings))

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

/**
 * Check, then optionally act on the remote, then push; one scope holds the scratch
 * repository. A runner of its own for the check, unless one is given.
 */
const publish = (
  result: SealedResult,
  opts: CheckOptions,
  between: () => Promise<void> = async () => {},
  checkedTarget: { ref: string; expectedHead: string | null } = target,
  runner?: SealedResultGitPort,
) => {
  const published = Effect.scoped(
    Effect.gen(function* () {
      const checked = yield* checkSealedResult(result, checkedTarget, opts)
      yield* Effect.promise(between)
      return yield* pushSealedResult(checked)
    }),
  )
  return Effect.runPromiseExit(
    runner === undefined
      ? Effect.provide(published, gitLayer(opts.git))
      : Effect.provideService(published, SealedResultGit, runner),
  )
}

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

// A refusal shows a value of the run quoted, in at most 122 characters, after a fixed text.
const refusalDetailCharacters = 200
const printableAscii = /^[\x20-\x7e]*$/

/** The detail and the message of a refusal are printable ASCII, and the detail is short. */
const expectPrintable = (error: SealedResultRefused) => {
  expect(error.detail).toMatch(printableAscii)
  expect(error.message).toMatch(printableAscii)
  expect(error.detail.length).toBeLessThanOrEqual(refusalDetailCharacters)
}

const remoteRef = (f: Fixture, ref = target.ref) =>
  command(["git", "for-each-ref", "--format=%(objectname)", ref], f.remote)

/** Builds a runner that holds its scratch root until it is closed. */
const openRunner = async (settings: SealedResultGitSettings) => {
  const scope = await Effect.runPromise(Scope.make())
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void))
  try {
    const runner = await Effect.runPromise(Scope.provide(makeSealedResultGit(settings), scope))
    return { runner, close }
  } catch (error) {
    await close()
    throw error
  }
}

/** The exit of a build of a runner, which is closed at once. */
const built = (settings: SealedResultGitSettings) =>
  Effect.runPromiseExit(Effect.scoped(Effect.asVoid(makeSealedResultGit(settings))))

/** The entries below a scratch root but the lock file of its runner, which stays. */
const scratchEntries = async (root: string) =>
  (await readdir(root)).filter((entry) => entry !== ".lock")

const withFixture = (body: (f: Fixture) => Promise<void>) => async () => {
  const f = await fixture()
  try {
    await body(f)
    // The scratch repository is gone on each path: accept, refuse, fault and timeout.
    expect(await scratchEntries(f.scratchRoot)).toEqual([])
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

test("a key of result.json is shown in its refusal as printable ASCII of a bounded length", async () => {
  for (const key of hostileValues) {
    const error = await Effect.runPromise(
      Effect.flip(
        decodeSealedResult(manifest("a".repeat(40), { [key]: "x" }), new Uint8Array([1, 2, 3])),
      ),
    )
    expect(error.check).toBe("unknown_key")
    expectPrintable(error)
  }
  const shownKey = await Effect.runPromise(
    Effect.flip(
      decodeSealedResult(manifest("a".repeat(40), { '\u009b2J\u202e\\"': 1 }), new Uint8Array()),
    ),
  )
  expect(shownKey.detail).toBe('"\\u{9b}2J\\u{202e}\\\\\\""')
})

test("a refusal writes each code point of a value outside printable ASCII as an escape and cuts the value before an escape", async () => {
  const shownKey = async (key: string) =>
    (
      await Effect.runPromise(
        Effect.flip(decodeSealedResult(manifest("a".repeat(40), { [key]: 1 }), new Uint8Array())),
      )
    ).detail
  expect(await shownKey("a\u0000\u{1f600}\ud800z")).toBe('"a\\u{0}\\u{1f600}\\u{d800}z"')
  // The value inside the quotes is at most 120 characters, the last three `...`.
  expect(await shownKey("x".repeat(200))).toBe(`"${"x".repeat(117)}..."`)
  // An escape is not cut: the text ends before it.
  expect(await shownKey(`${"x".repeat(116)}\u009b`)).toBe(`"${"x".repeat(116)}..."`)
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

/** The git subcommand of a recorded call: the first argument after the `-c` options. */
const subcommand = (argv: ReadonlyArray<string>) => {
  let index = 0
  while (argv[index] === "-c") index += 2
  return argv[index]
}

/** The children that speak to the remote; only they get the token header. */
const networkCommands = ["ls-remote", "fetch", "push"]

test(
  "the token reaches git only through the environment; a failed push holds it nowhere",
  withFixture(async (f) => {
    const recorder = await recordingGit(f)
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    const exit = await publish(result, options(f, { binary: recorder.path }), () =>
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
      // The header holds the token in the children that speak to the remote, and no
      // other child holds it.
      expect({
        command: subcommand(call.argv),
        keys: values.filter(([, value]) => value?.includes(encoded)).map(([key]) => key),
      }).toEqual({
        command: subcommand(call.argv),
        keys: networkCommands.includes(subcommand(call.argv)!) ? ["GIT_CONFIG_VALUE_0"] : [],
      })
    }
    expect(new Set(calls.map((call) => subcommand(call.argv)))).toEqual(
      new Set([
        "init",
        "ls-remote",
        "fetch",
        "index-pack",
        "cat-file",
        "rev-list",
        "diff-tree",
        "push",
      ]),
    )
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
    // The daemon is a process of its own that starts with these variables, so the
    // environment of the test process never holds them.
    const input = join(f.root, "daemon-input.json")
    await writeFile(
      input,
      JSON.stringify({
        json: new TextDecoder().decode(sealed.json),
        bundle: Buffer.from(sealed.bundle).toString("base64"),
        target,
        options: { ...options(f, { binary: recorder.path }), token: undefined },
        token,
        settings: options(f, { binary: recorder.path }).git,
      }),
    )
    const daemonProcess = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { Effect, Exit, Layer, Redacted } from "effect"
import { checkSealedResult, decodeSealedResult, makeSealedResultGit, pushSealedResult, SealedResultGit } from "./src/kernel/sealed-result"
const input = JSON.parse(await Bun.file(process.env.SEALED_RESULT_INPUT).text())
const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
  const result = yield* decodeSealedResult(new TextEncoder().encode(input.json), Buffer.from(input.bundle, "base64"))
  const options = { ...input.options, token: Effect.succeed(Redacted.make(input.token)) }
  return yield* pushSealedResult(yield* checkSealedResult(result, input.target, options))
})).pipe(Effect.provide(Layer.effect(SealedResultGit, makeSealedResultGit({ ...input.settings, remoteAllowed: () => true })))))
console.log(Exit.isSuccess(exit) ? "pushed" : String(exit.cause))`,
      ],
      {
        cwd: resolve("."),
        env: { ...process.env, ...daemon, SEALED_RESULT_INPUT: input },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [status, stdout, stderr] = await Promise.all([
      daemonProcess.exited,
      new Response(daemonProcess.stdout).text(),
      new Response(daemonProcess.stderr).text(),
    ])
    expect({ status, stdout: stdout.trim(), stderr }).toEqual({
      status: 0,
      stdout: "pushed",
      stderr: "",
    })
    const calls = await recorder.calls()
    expect(calls.length).toBeGreaterThan(5)
    // PWD is set by the shell of the recording git, not by the daemon.
    const fixed = [
      "GIT_ALLOW_PROTOCOL",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_SYSTEM",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_TERMINAL_PROMPT",
      "HOME",
      "LC_ALL",
      "PATH",
      "PWD",
    ]
    const header = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]
    for (const call of calls) {
      const command = subcommand(call.argv)!
      const network = networkCommands.includes(command)
      expect({ command, keys: Object.keys(call.env).sort() }).toEqual({
        command,
        keys: (network ? [...fixed, ...header] : fixed).sort(),
      })
      expect(call.env.GIT_ALLOW_PROTOCOL).toBe("file")
      if (network) expect(call.env.GIT_CONFIG_KEY_0).toBe(`http.${f.remote}.extraHeader`)
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
        publish(result, options(f, { token: stub.github.pushToken(policy), binary: recorder.path }))
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

const stubPolicy = { repository: "fixture/repo", repositoryId: 12, installationId: 34 }

test(
  "a revocation that fails is logged with no token, and the check and the push keep their result",
  withFixture(async (f) => {
    const stub = await githubApiStub(
      (path, method) =>
        method === "DELETE" && path === "/installation/token"
          ? new Response(null, { status: 500 })
          : undefined,
      token,
    )
    try {
      const sealed = await sealWithResultPy(f, async (workspace) => {
        await writeFile(join(workspace, "result.txt"), "content\n")
      })
      const result = await decode(sealed.json, sealed.bundle)
      const logs: string[] = []
      const logged = Logger.layer([Logger.make((entry) => logs.push(Bun.inspect(entry)))])
      const opts = options(f, { token: stub.github.pushToken(stubPolicy) })
      const step = (checkedTarget: typeof target) =>
        Effect.runPromiseExit(
          Effect.provide(
            Effect.scoped(
              Effect.gen(function* () {
                return yield* pushSealedResult(
                  yield* checkSealedResult(result, checkedTarget, opts),
                )
              }),
            ),
            Layer.mergeAll(gitLayer(opts.git), logged),
          ),
        )
      const pushed = await step(target)
      if (Exit.isFailure(pushed)) throw Cause.squash(pushed.cause)
      expect(pushed.value).toEqual({ ref: target.ref, sha: await remoteRef(f) })
      // A refusal stays the refusal.
      expect(refusedCheck(await step(target))).toBe("target_exists")
      expect(stub.revoked()).toHaveLength(2)
      expect(logs.filter((line) => line.includes("Installation token not revoked"))).toHaveLength(2)
      const encoded = Buffer.from(`x-access-token:${token}`).toString("base64")
      for (const line of logs) {
        expect(line).not.toContain(token)
        expect(line).not.toContain(encoded)
      }
    } finally {
      await stub.close()
    }
  }),
)

test(
  "an interrupt while the token is in use revokes the token",
  withFixture(async (f) => {
    const stub = await githubApiStub(undefined, token)
    try {
      const sealed = await sealWithResultPy(f, async (workspace) => {
        await writeFile(join(workspace, "result.txt"), "content\n")
      })
      const result = await decode(sealed.json, sealed.bundle)
      const started = join(f.root, "started")
      const endless = join(f.root, "endless-git")
      await writeFile(endless, `#!/bin/sh\ntouch ${started}\nexec sleep 300\n`)
      await chmod(endless, 0o755)
      const opts = options(f, { binary: endless, token: stub.github.pushToken(stubPolicy) })
      const fiber = Effect.runFork(
        Effect.provide(Effect.scoped(checkSealedResult(result, target, opts)), gitLayer(opts.git)),
      )
      // The first git child runs once the token is made.
      while (!(await Bun.file(started).exists())) await Bun.sleep(10)
      expect(stub.minted()).toHaveLength(1)
      expect(stub.revoked()).toHaveLength(0)
      await Effect.runPromise(Fiber.interrupt(fiber))
      expect(stub.revoked().map((request) => request.authorization)).toEqual([`token ${token}`])
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
    const exit = await publish(result, options(f, { binary: recorder.path }))
    expect(refusedCheck(exit)).toBe("object_bytes")
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
      options(f, { binary: recorder.path }),
    )
    expect(refusedCheck(exit)).toBe("object_bytes")
    expect(
      (await recordedCalls(f, recorder)).some((call) => call.argv.includes("index-pack")),
    ).toBe(false)
  }),
)

/**
 * Runs the check of a bundle in a process of its own, and gives the refusal and the
 * peak resident memory of that process in bytes, read from Linux's VmHWM: the
 * maxRSS of a process started by the test process keeps the peak of the test
 * process across exec.
 */
async function checkInOwnProcess(f: Fixture, bundle: Uint8Array) {
  const input = join(f.root, `check-${crypto.randomUUID()}.json`)
  await writeFile(
    input,
    JSON.stringify({
      json: new TextDecoder().decode(manifest(f.sourceSha)),
      bundle: Buffer.from(bundle).toString("base64"),
      target,
      options: { ...options(f), token: undefined, git: undefined },
      settings: options(f).git,
    }),
  )
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { Cause, Effect, Exit, Layer, Redacted } from "effect"
import { checkSealedResult, decodeSealedResult, makeSealedResultGit, SealedResultGit } from "./src/kernel/sealed-result"
const input = JSON.parse(await Bun.file(process.env.SEALED_RESULT_INPUT).text())
const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
  const result = yield* decodeSealedResult(new TextEncoder().encode(input.json), Buffer.from(input.bundle, "base64"))
  delete input.bundle
  const options = { ...input.options, token: Effect.succeed(Redacted.make("fixture")) }
  return yield* checkSealedResult(result, input.target, options)
})).pipe(Effect.provide(Layer.effect(SealedResultGit, makeSealedResultGit({ ...input.settings, remoteAllowed: () => true })))))
const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
// VmHWM is the peak of this process since it started; maxRSS would also hold its parent's.
const status = await Bun.file("/proc/self/status").text()
const peak = Number(/^VmHWM:\\s+(\\d+) kB$/m.exec(status)[1]) * 1024
console.log(JSON.stringify({ check: error?.check ?? null, peak }))`,
    ],
    {
      cwd: resolve("."),
      env: { ...process.env, SEALED_RESULT_INPUT: input },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (status !== 0) throw new Error(`the check process exited ${status}: ${stderr}`)
  return Schema.decodeUnknownSync(
    Schema.Struct({ check: Schema.NullOr(Schema.String), peak: Schema.Number }),
  )(JSON.parse(stdout))
}

// What a check process holds at most: the 16 MiB bundle a few times, and the runtime.
const checkPeakBytes = 256 * MiB

test(
  "an object that declares a size above the bound is refused before it is inflated: the peak memory of the check stays below what it declares",
  withFixture(async (f) => {
    // The header declares 512 MiB, and the stream of about 512 KiB inflates to it.
    const bundle = packBundle(f, pack([concat(objectHeader(3, 512 * MiB), zerosStream(512))]))
    expect(bundle.byteLength).toBeLessThan(MiB)
    const { check, peak } = await checkInOwnProcess(f, bundle)
    expect(check).toBe("object_bytes")
    expect(peak).toBeLessThan(checkPeakBytes)
  }),
  30_000,
)

test(
  "a pack whose header gives a size below what its stream inflates to is refused, inflating no more than the size",
  withFixture(async (f) => {
    // The header says 10 bytes; the stream holds 512 MiB of zeros.
    const bundle = packBundle(f, pack([concat(objectHeader(3, 10), zerosStream(512))]))
    const { check, peak } = await checkInOwnProcess(f, bundle)
    expect(check).toBe("bundle_format")
    expect(peak).toBeLessThan(checkPeakBytes)
  }),
  30_000,
)

/**
 * A pack of the deepest delta chain the walk lets through: a blob, then a delta on
 * the blob before it for each object up to the object bound but a tree and a
 * commit, with the inflated sizes inside the bound of object bytes.
 */
function deepChainBundle(f: Fixture) {
  const links = sealedResultLimits.objects - 2
  const size = 6_000
  expect(links * size).toBeLessThan(sealedResultLimits.objectBytes - 64 * 1024)
  const content = (index: number) => {
    const bytes = new Uint8Array(size).fill(0x61)
    bytes.set(Buffer.from(index.toString(16).padStart(8, "0")))
    return bytes
  }
  // Insert the 8 bytes of the index, then copy the rest of the base from offset 8.
  const delta = (index: number) =>
    concat(
      deltaSize(size),
      deltaSize(size),
      Uint8Array.from([8]),
      content(index).subarray(0, 8),
      Uint8Array.from([0x80 | 0x01 | 0x10 | 0x20, 8, (size - 8) & 0xff, (size - 8) >> 8]),
    )
  const entries = [blobEntry(content(0))]
  for (let index = 1; index < links; index++)
    entries.push(refDeltaEntry(blobId(content(index - 1)), delta(index)))
  const tree = concat("100644 deep.txt\0", blobId(content(links - 1)))
  const commit = Buffer.from(
    `tree ${objectId("tree", tree).toString("hex")}\nparent ${f.sourceSha}\nauthor ${agentLine}\ncommitter ${agentLine}\n\nAdd the end of a deep delta chain\n`,
  )
  entries.push(objectEntry("tree", tree), objectEntry("commit", commit))
  expect(entries).toHaveLength(sealedResultLimits.objects)
  return concat(
    `# v2 git bundle\n-${f.sourceSha} base\n${objectId("commit", commit).toString("hex")} refs/workflowd/result\n\n`,
    pack(entries),
  )
}

test(
  "a delta chain as deep as the object bound permits is checked inside the time and memory bounds",
  withFixture(async (f) => {
    const bundle = deepChainBundle(f)
    expect(bundle.byteLength).toBeLessThan(sealedResultLimits.bundleBytes)
    const started = Date.now()
    const { check, peak } = await checkInOwnProcess(f, bundle)
    const elapsed = Date.now() - started
    expect(check).toBeNull()
    expect(peak).toBeLessThan(checkPeakBytes)
    expect(elapsed).toBeLessThan(sealedResultLimits.timeLimitMs)
  }),
  sealedResultLimits.timeLimitMs + 30_000,
)

/**
 * A pack of 100 commits whose root trees are links of one chain of 9 898 tree deltas,
 * as long as the object bound permits: each `diff-tree` of the check, one process per
 * commit, resolves its root tree from the start of the chain. Each tree has the same 64
 * names, each on one of two blobs by a bit of the index of the tree, so the trees
 * differ and the changed paths stay under their bound; the 9 898 trees of 6 592 bytes
 * (62 MiB) stay inside the bound of object bytes, so a longer chain or larger trees do
 * not fit.
 *
 * What it measures: the roots are spread evenly along the chain, so the 100 processes
 * resolve 499 800 links in all (the sum of the depths of the roots). The worst case the
 * bounds permit puts every root on the last 100 links: 984 850 links, 1.97 times as
 * many, each process resolving about 62 MiB. At the CI time of this test (7.2 s), that
 * is about 14 s against the time limit of 120 s (the time scaled by the links). The
 * bound of memory is that of the daemon's process, which resolves no delta of the chain.
 */
function treeChainBundle(f: Fixture) {
  const commits = sealedResultLimits.commits
  const links = sealedResultLimits.objects - commits - 2
  const blobs = [new TextEncoder().encode("a\n"), new TextEncoder().encode("b\n")]
  const names = Array.from({ length: 64 }, (_, index) =>
    `tree-chain-${index.toString().padStart(2, "0")}-`.padEnd(75, "x"),
  )
  const entry = (name: string, bit: number) => concat(`100644 ${name}\0`, blobId(blobs[bit]!))
  const entries = (index: number) => names.map((name, bit) => entry(name, (index >> bit) & 1))
  const size = concat(...entries(0)).byteLength
  expect(links * size).toBeLessThan(sealedResultLimits.objectBytes - 64 * 1024)
  // Copy each entry that is the same as in the tree before, and insert each other.
  const delta = (index: number) => {
    const before = entries(index - 1)
    const ops: Uint8Array[] = [deltaSize(size), deltaSize(size)]
    let offset = 0
    entries(index).forEach((bytes, at) => {
      if (Buffer.compare(bytes, before[at]!) === 0)
        ops.push(
          Uint8Array.from([
            0x80 | 0x01 | 0x02 | 0x10,
            offset & 0xff,
            offset >> 8,
            bytes.byteLength,
          ]),
        )
      else ops.push(Uint8Array.from([bytes.byteLength]), bytes)
      offset += bytes.byteLength
    })
    return concat(...ops)
  }
  const tree = (index: number) => concat(...entries(index))
  const objects: Uint8Array[] = [...blobs.map(blobEntry), objectEntry("tree", tree(0))]
  for (let index = 1; index < links; index++)
    objects.push(refDeltaEntry(objectId("tree", tree(index - 1)), delta(index)))
  let parent = f.sourceSha
  for (let commit = 1; commit <= commits; commit++) {
    const root = Math.floor((commit * links) / commits) - 1
    const content = Buffer.from(
      `tree ${objectId("tree", tree(root)).toString("hex")}\nparent ${parent}\nauthor ${agentLine}\ncommitter ${agentLine}\n\nChange the blobs of tree ${root}\n`,
    )
    objects.push(objectEntry("commit", content))
    parent = objectId("commit", content).toString("hex")
  }
  expect(objects).toHaveLength(sealedResultLimits.objects)
  return concat(
    `# v2 git bundle\n-${f.sourceSha} base\n${parent} refs/workflowd/result\n\n`,
    pack(objects),
  )
}

test(
  "100 commits whose root trees are spread along one chain of tree deltas as long as the object bound permits, half the delta work of the worst case, are checked inside the time and memory bounds",
  withFixture(async (f) => {
    const bundle = treeChainBundle(f)
    expect(bundle.byteLength).toBeLessThan(sealedResultLimits.bundleBytes)
    const started = Date.now()
    const { check, peak } = await checkInOwnProcess(f, bundle)
    const elapsed = Date.now() - started
    expect(check).toBeNull()
    expect(peak).toBeLessThan(checkPeakBytes)
    expect(elapsed).toBeLessThan(sealedResultLimits.timeLimitMs)
  }),
  sealedResultLimits.timeLimitMs + 30_000,
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
        most = Math.max(most, (await scratchEntries(f.scratchRoot)).length)
        await Bun.sleep(5)
      }
    })()
    const opts = options(f, { binary: slow })
    const { runner, close } = await openRunner(opts.git)
    const runs = Array.from({ length: sealedResultLimits.concurrentChecks + 1 }, (_, index) =>
      publish(
        result,
        opts,
        undefined,
        { ref: `refs/heads/agent-run/run-${index}`, expectedHead: null },
        runner,
      ),
    )
    const exits = await Promise.all(runs)
    sampling = false
    await sampler
    await close()
    for (const exit of exits) expect(Exit.isSuccess(exit)).toBe(true)
    expect(most).toBe(sealedResultLimits.concurrentChecks)
  }),
  30_000,
)

/**
 * A runner whose checks stay in their first git child until the gate opens, with a
 * token maker that counts the tokens it makes and revokes, and a latch for a count.
 */
async function gatedRunner(f: Fixture, sealed: SealedResult, waitLimitMs: number) {
  const gate = join(f.root, "gate")
  const gated = join(f.root, "gated-git")
  await writeFile(
    gated,
    `#!/bin/sh\nwhile [ ! -e ${gate} ]; do sleep 0.02; done\nexec /usr/bin/git "$@"\n`,
  )
  await chmod(gated, 0o755)
  const tokens = { minted: 0, revoked: 0 }
  const latches: Array<{ readonly count: number; readonly open: () => void }> = []
  const opts = options(f, {
    binary: gated,
    waitLimitMs,
    token: Effect.acquireRelease(
      Effect.sync(() => {
        tokens.minted += 1
        for (const latch of latches) if (tokens.minted >= latch.count) latch.open()
        return Redacted.make(token)
      }),
      () => Effect.sync(() => (tokens.revoked += 1)),
    ),
  })
  const { runner, close } = await openRunner(opts.git)
  const targetOf = (index: number) => ({
    ref: `refs/heads/agent-run/run-${index}`,
    expectedHead: null,
  })
  return {
    tokens,
    opts,
    runner,
    targetOf,
    /** A check and its push; the call returns when the check waits for a slot or holds one. */
    check: (index: number) => publish(sealed, opts, undefined, targetOf(index), runner),
    /** Resolves once the token maker has made `count` tokens. */
    minted: (count: number) =>
      new Promise<void>((open) => {
        if (tokens.minted >= count) open()
        else latches.push({ count, open })
      }),
    open: () => writeFile(gate, ""),
    close,
  }
}

/** A result sealed by result.py with one new file. */
const sealedResult = async (f: Fixture) => {
  const sealed = await sealWithResultPy(f, async (workspace) => {
    await writeFile(join(workspace, "result.txt"), "content\n")
  })
  return decode(sealed.json, sealed.bundle)
}

test(
  "a check over the bound of waiting checks is refused at once, a check that waits past its limit is refused, and neither makes a token",
  withFixture(async (f) => {
    const gated = await gatedRunner(f, await sealedResult(f), 3_000)
    const { concurrentChecks, waitingChecks } = sealedResultLimits
    const holding = Array.from({ length: concurrentChecks }, (_, index) => gated.check(index))
    // A check makes its token once it holds a slot.
    await gated.minted(concurrentChecks)
    // A check runs from its call to the wait for a slot with no pause, so each of these
    // holds its place among the waiting checks when its call returns. A waiting check
    // makes no token and starts no git child, so no fake can tell it.
    const waiting = Array.from({ length: waitingChecks }, (_, index) =>
      gated.check(concurrentChecks + index),
    )
    const over = refusal(await gated.check(concurrentChecks + waitingChecks))
    expect(over.check).toBe("checks_waiting")
    expect(over.detail).toBe(
      `${waitingChecks} checks wait for a slot; the bound is ${waitingChecks}`,
    )
    const waited = await Promise.all(waiting)
    expect(waited.map((exit) => refusal(exit).check)).toEqual(
      Array.from({ length: waitingChecks }, () => "wait_limit"),
    )
    expect(refusal(waited[0]!).detail).toBe("no slot was free within 3000 ms")
    // Only the checks that got a slot made a token.
    expect(gated.tokens.minted).toBe(concurrentChecks)
    await gated.open()
    for (const exit of await Promise.all(holding)) expect(Exit.isSuccess(exit)).toBe(true)
    expect(gated.tokens).toEqual({ minted: concurrentChecks, revoked: concurrentChecks })
    // The slots are free again, and the waiting count is back to zero.
    const exits = await Promise.all(
      Array.from({ length: concurrentChecks + waitingChecks }, (_, index) =>
        gated.check(100 + index),
      ),
    )
    for (const exit of exits) expect(Exit.isSuccess(exit)).toBe(true)
    await gated.close()
  }),
  30_000,
)

/**
 * Runs a check on a scheduler that makes its fiber yield once, before its operation
 * `at`, and interrupts the fiber at that yield. Returns false when the check suspended
 * by itself (in its wait for a slot, or on its first file operation) before it got to
 * operation `at`; it is then interrupted there.
 */
const interruptedAt = async (
  gated: Awaited<ReturnType<typeof gatedRunner>>,
  result: SealedResult,
  index: number,
  at: number,
) => {
  const base = new Scheduler.MixedScheduler()
  let ops = 0
  let yielded = false
  const once: Scheduler.Scheduler = {
    executionMode: base.executionMode,
    shouldYield: () => {
      ops += 1
      if (ops !== at) return false
      yielded = true
      return true
    },
    makeDispatcher: () => base.makeDispatcher(),
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.scoped(gated.runner.check(result, gated.targetOf(index), gated.opts)).pipe(
          Effect.provideService(Scheduler.Scheduler, once),
        ),
        { startImmediately: true },
      )
      yield* Fiber.interrupt(fiber)
    }),
  )
  return yielded
}

test(
  "a check that is interrupted at any operation before or in its wait for a slot gives its slot and its place among the waiting checks back",
  withFixture(async (f) => {
    const result = await sealedResult(f)
    const gated = await gatedRunner(f, result, 10_000)
    const { concurrentChecks, waitingChecks } = sealedResultLimits
    // A slot is free: the checks are interrupted at each operation up to the first file
    // operation after the slot is taken.
    let taking = 1
    while (await interruptedAt(gated, result, taking, taking)) taking += 1
    // Every slot is held: the checks are interrupted at each operation up to the wait,
    // and in it.
    const minted = gated.tokens.minted
    const holding = Array.from({ length: concurrentChecks }, (_, index) => gated.check(index))
    // A slot that an interrupted check kept leaves a holding check to wait until its
    // wait limit, and its refusal ends the race first.
    await Promise.race([
      gated.minted(minted + concurrentChecks),
      Promise.race(holding).then((exit) => {
        throw new Error(`a holding check ended before each slot was taken: ${refusedCheck(exit)}`)
      }),
    ])
    let waited = 1
    while (await interruptedAt(gated, result, 10_000 + waited, waited)) waited += 1
    // A check runs from its call to its wait with no pause, so each of these holds its
    // place among the waiting checks when its call returns.
    const waiting = Array.from({ length: waitingChecks }, (_, index) =>
      gated.check(concurrentChecks + index),
    )
    expect(refusedCheck(await gated.check(concurrentChecks + waitingChecks))).toBe("checks_waiting")
    await gated.open()
    for (const exit of await Promise.all([...holding, ...waiting]))
      expect(Exit.isSuccess(exit)).toBe(true)
    expect(gated.tokens.revoked).toBe(gated.tokens.minted)
    await gated.close()
    // Each sweep reached its check's own suspension.
    expect({ taking: taking > 10, waited: waited > 10 }).toEqual({ taking: true, waited: true })
  }),
  60_000,
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
    const exit = await publish(result, options(f, { binary: slow, timeLimitMs: 500 }))
    expect(refusedCheck(exit)).toBe("time_limit")
    // The git child sleeps 30 s; the check ends at its limit of 500 ms.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await remoteRef(f)).toBe("")
  }),
  20_000,
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
    const opts = options(f, { binary: endless })
    const fiber = Effect.runFork(
      Effect.provide(Effect.scoped(checkSealedResult(result, target, opts)), gitLayer(opts.git)),
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
    expect(await scratchEntries(f.scratchRoot)).toEqual([])
  }),
)

const scratchRootHeld = (exit: Exit.Exit<unknown, unknown>) => {
  const error = failure(exit)
  if (!(error instanceof SealedResultFault)) throw error
  return error.operation
}

test(
  "a second git runner on a scratch root that a live runner holds is refused scratch_root_held when it is built, and is built once the first is closed",
  withFixture(async (f) => {
    const first = await openRunner(options(f).git)
    const second = await built(options(f).git)
    expect(scratchRootHeld(second)).toBe("scratch_root_held")
    // The refused build removed nothing and holds nothing.
    expect(scratchRootHeld(await built(options(f).git))).toBe("scratch_root_held")
    await first.close()
    expect(Exit.isSuccess(await built(options(f).git))).toBe(true)
  }),
)

test(
  "a git runner is built on a scratch root whose holder was killed",
  withFixture(async (f) => {
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { Effect } from "effect"
import { makeSealedResultGit } from "./src/kernel/sealed-result"
const settings = JSON.parse(process.env.SEALED_RESULT_SETTINGS)
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  yield* makeSealedResultGit(settings)
  console.log("held")
  yield* Effect.never
})))`,
      ],
      {
        cwd: resolve("."),
        env: { ...process.env, SEALED_RESULT_SETTINGS: JSON.stringify(options(f).git) },
        stdout: "pipe",
        stderr: "inherit",
      },
    )
    const reader = holder.stdout.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toBe("held\n")
    expect(scratchRootHeld(await built(options(f).git))).toBe("scratch_root_held")
    holder.kill("SIGKILL")
    expect(await holder.exited).not.toBe(0)
    expect(Exit.isSuccess(await built(options(f).git))).toBe(true)
  }),
  30_000,
)

test(
  "a scratch root spelled with a trailing slash or through a symbolic link reaches the lock of the root",
  withFixture(async (f) => {
    const first = await openRunner(options(f).git)
    try {
      const alias = join(f.root, "alias")
      await symlink(f.root, alias)
      for (const spelling of [`${f.scratchRoot}/`, join(alias, "scratch")]) {
        const second = await built(options(f, { scratchRoot: spelling }).git)
        expect(scratchRootHeld(second)).toBe("scratch_root_held")
      }
    } finally {
      await first.close()
    }
    expect(Exit.isSuccess(await built(options(f, { scratchRoot: `${f.scratchRoot}/` }).git))).toBe(
      true,
    )
  }),
)

/** The fault of a build of a runner that cannot take its lock. */
const lockFault = (exit: Exit.Exit<unknown, unknown>) => {
  const error = failure(exit)
  if (!(error instanceof SealedResultFault)) throw error
  return { operation: error.operation, message: error.message }
}

const lockCauses: ReadonlyArray<readonly [string, string, (f: Fixture) => Promise<void>]> = [
  [
    "a symbolic link",
    "Scratch root lock is not a regular file of one link",
    async (f) => {
      await writeFile(join(f.root, "elsewhere"), "", { mode: 0o600 })
      await symlink(join(f.root, "elsewhere"), join(f.scratchRoot, ".lock"))
    },
  ],
  [
    "a directory",
    "Scratch root lock is not a regular file of one link",
    (f) => mkdir(join(f.scratchRoot, ".lock")),
  ],
  [
    "a file of a second link",
    "Scratch root lock is not a regular file of one link",
    async (f) => {
      await writeFile(join(f.scratchRoot, ".lock"), "", { mode: 0o600 })
      await link(join(f.scratchRoot, ".lock"), join(f.root, "second-link"))
    },
  ],
  [
    "a file of mode 0644",
    "Scratch root lock does not have mode 0600",
    async (f) => {
      await writeFile(join(f.scratchRoot, ".lock"), "")
      await chmod(join(f.scratchRoot, ".lock"), 0o644)
    },
  ],
  [
    "missing in a root that the daemon cannot write",
    "Scratch root lock cannot be opened or locked",
    (f) => chmod(f.scratchRoot, 0o500),
  ],
]

for (const [cause, message, make] of lockCauses)
  test(
    `a git runner whose lock is ${cause} is not built, with a text of its own`,
    withFixture(async (f) => {
      await make(f)
      try {
        expect(lockFault(await built(options(f).git))).toEqual({ operation: "scratch", message })
      } finally {
        await chmod(f.scratchRoot, 0o700)
        await rm(join(f.scratchRoot, ".lock"), { recursive: true, force: true })
      }
    }),
  )

test(
  "a git runner whose lock is a file of another owner is not built, with a text of its own",
  withFixture(async (f) => {
    await writeFile(join(f.scratchRoot, ".lock"), "", { mode: 0o600 })
    // In a user and mount namespace the daemon is uid 0 and owns the root; a file of
    // root, bound over the lock, shows the owner that has no mapping there.
    const child = Bun.spawn(
      [
        "unshare",
        "--user",
        "--map-root-user",
        "--mount",
        "/bin/sh",
        "-c",
        'mount --bind /etc/passwd "$0" && exec "$@"',
        join(f.scratchRoot, ".lock"),
        process.execPath,
        "-e",
        `import { Effect } from "effect"
import { makeSealedResultGit } from "./src/kernel/sealed-result"
const settings = JSON.parse(process.env.SEALED_RESULT_SETTINGS)
const exit = await Effect.runPromiseExit(Effect.scoped(makeSealedResultGit(settings)))
console.log(JSON.stringify(exit._tag === "Failure" ? exit.cause.reasons[0].error : "built"))`,
      ],
      {
        cwd: resolve("."),
        env: { ...process.env, SEALED_RESULT_SETTINGS: JSON.stringify(options(f).git) },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
    expect(JSON.parse(stdout)).toMatchObject({
      operation: "scratch",
      message: "Scratch root lock is not owned by the daemon",
    })
  }),
  30_000,
)

test(
  "the runner removes what an earlier process left below its scratch root when it is built, and only below its own root",
  withFixture(async (f) => {
    const leave = async (root: string) => {
      const stale = join(root, "sealed-result-earlier")
      await mkdir(join(stale, "repository.git"), { recursive: true })
      await writeFile(join(stale, "repository.git", "pack"), "left by a process that ended\n")
    }
    await leave(f.scratchRoot)
    expect(Exit.isSuccess(await built(options(f).git))).toBe(true)
    // The lock file of the runner is inside the root, and the removal keeps it.
    expect(await readdir(f.scratchRoot)).toEqual([".lock"])
    // A second runner of another root, built later, leaves the first root alone.
    await leave(f.scratchRoot)
    const other = join(f.root, "other-root")
    expect(Exit.isSuccess(await built(options(f, { scratchRoot: other }).git))).toBe(true)
    expect(await scratchEntries(f.scratchRoot)).toEqual(["sealed-result-earlier"])
    await rm(join(f.scratchRoot, "sealed-result-earlier"), { recursive: true })
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    // A root other users can use: the runner is not built.
    await chmod(f.scratchRoot, 0o755)
    try {
      const shared = await publish(result, options(f))
      expect(failure(shared)).toBeInstanceOf(SealedResultFault)
      expect(String(failure(shared))).toContain("Scratch root")
    } finally {
      await chmod(f.scratchRoot, 0o700)
    }
    // A root that does not exist yet is made with mode 0700.
    const fresh = join(f.root, "fresh-root")
    const exit = await publish(result, options(f, { scratchRoot: fresh }))
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    expect((await lstat(fresh)).mode & 0o777).toBe(0o700)
    expect(await readdir(fresh)).toEqual([".lock"])
  }),
)

for (const [name, checkedTarget, message] of [
  [
    "a target ref whose name starts with a dash",
    { ref: "refs/heads/-x", expectedHead: null },
    "Invalid target ref",
  ],
  [
    "a target ref with a .. component",
    { ref: "refs/heads/a/../b", expectedHead: null },
    "Invalid target ref",
  ],
  [
    "an expected head that is not a full commit id",
    { ref: "refs/heads/agent-run/run", expectedHead: "abc1234" },
    "Invalid expected head",
  ],
] as const)
  test(
    `the daemon's target is checked before a token or a git child: ${name} is a fault`,
    withFixture(async (f) => {
      const recorder = await recordingGit(f)
      let minted = 0
      const opts = options(f, {
        binary: recorder.path,
        token: Effect.sync(() => {
          minted += 1
          return Redacted.make(token)
        }),
      })
      const error = failure(await publish(await sealedResult(f), opts, undefined, checkedTarget))
      expect(error).toMatchObject({ _tag: "SealedResultFault", operation: "target", message })
      expect(minted).toBe(0)
      expect(await Bun.file(join(f.root, "git-calls.jsonl")).exists()).toBe(false)
    }),
  )

/** Remotes that the daemon's runner refuses: each is not https://github.com/<path>. */
const refusedRemotes = (f: Fixture) => [
  f.remote,
  `file://${f.remote}`,
  "http://github.com/owner/name.git",
  "https://x-access-token@github.com/owner/name.git",
  "https://user:password@github.com/owner/name.git",
  "https://@github.com/owner/name.git",
  "https://github.com:443/owner/name.git",
  "https://github.com:8443/owner/name.git",
  "https://api.github.com/owner/name.git",
  "https://github.com.example.org/owner/name.git",
  "https://example.org/github.com/owner/name.git",
  "https://github.com",
  "ssh://git@github.com/owner/name.git",
  "git@github.com:owner/name.git",
  " https://github.com/owner/name.git",
  "https://github.com/owner/name.git\n",
  "https://github.com/owner/na me.git",
  "https://github.com/owner/name.git\u202e",
]

test(
  "the daemon's runner refuses a remote that is not an https URL of the GitHub host with no user part and no port, before it makes a token or starts a git child",
  withFixture(async (f) => {
    const result = await sealedResult(f)
    const recorder = await recordingGit(f)
    let minted = 0
    const opts = options(f, {
      binary: recorder.path,
      protocols: ["https"],
      remoteAllowed: githubRemote,
      token: Effect.sync(() => {
        minted += 1
        return Redacted.make(token)
      }),
    })
    for (const remote of refusedRemotes(f)) {
      const error = failure(await publish(result, { ...opts, remote }))
      expect({ remote, error }).toMatchObject({
        remote,
        error: { _tag: "SealedResultFault", operation: "remote" },
      })
    }
    expect(minted).toBe(0)
    expect(await Bun.file(join(f.root, "git-calls.jsonl")).exists()).toBe(false)
    expect(githubRemote("https://github.com/owner/name.git")).toBe(true)
    // The daemon's layer has this rule.
    for (const remote of [f.remote, "https://x-access-token@github.com/owner/name.git"]) {
      const exit = await Effect.runPromiseExit(
        Effect.provide(
          Effect.scoped(checkSealedResult(result, target, { ...options(f), remote })),
          SealedResultGitLive(f.scratchRoot),
        ),
      )
      expect(failure(exit)).toMatchObject({ _tag: "SealedResultFault", operation: "remote" })
    }
    expect(await scratchEntries(f.scratchRoot)).toEqual([])
    expect(await remoteRef(f)).toBe("")
  }),
)

test(
  "a git child that speaks to the remote and gets no bytes ends before the time limit of the check",
  withFixture(async (f) => {
    // A server that takes the request of the remote and never answers it.
    const stub = await githubApiStub((path) =>
      path.startsWith("/stalled.git/") ? new Promise<Response>(() => {}) : undefined,
    )
    try {
      const sealed = await sealWithResultPy(f, async (workspace) => {
        await writeFile(join(workspace, "result.txt"), "content\n")
      })
      const result = await decode(sealed.json, sealed.bundle)
      const remote = new URL("/stalled.git", stub.url).toString()
      const timeLimitMs = 60_000
      const started = Date.now()
      const exit = await publish(result, options(f, { remote, protocols: ["http"], timeLimitMs }))
      const elapsed = Date.now() - started
      const error = failure(exit)
      expect(error).toBeInstanceOf(SealedResultFault)
      expect(String(error)).toContain("Operation too slow")
      expect(elapsed).toBeGreaterThanOrEqual(sealedResultLimits.lowSpeedSeconds * 1_000)
      expect(elapsed).toBeLessThan(timeLimitMs)
      expect(stub.requests.map((request) => request.path)).toEqual(["/stalled.git/info/refs"])
    } finally {
      await stub.close()
    }
  }),
  90_000,
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
  // A name that is .github once an invisible code point is dropped: refused by the
  // path rule, before the rule of .github.
  ...[".git\u200chub", ".github\u200d", "\u2060.github"].map(
    (name) =>
      [
        `a path below ${shown(name)}`,
        "path_name",
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
    "a commit object over 16 KiB",
    "commit_format",
    async (f) => ({
      bundle: await handBundle(f, (_git, dir) =>
        commitObject(f, dir, "", `${"a".repeat(sealedResultLimits.commitBytes)}\n`),
      ),
    }),
    `is over ${sealedResultLimits.commitBytes} bytes`,
  ],
  [
    "a commit that is not UTF-8",
    "commit_format",
    async (f) => ({
      bundle: await handBundle(f, (_git, dir) =>
        commitObject(f, dir, "", Uint8Array.from([0x43, 0xff, 0x0a])),
      ),
    }),
    "is not UTF-8",
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
  message: string | Uint8Array,
  author = agentLine,
  committer = agentLine,
): Promise<string> {
  await writeFile(join(dir, `${crypto.randomUUID()}.txt`), "change\n")
  await f.git(dir, "add", "-A")
  const tree = await f.git(dir, "write-tree")
  const parent = await f.git(dir, "rev-parse", "HEAD")
  const stamp = (who: string) => (who.includes(" +0000") ? who : `${who} 946684800 +0000`)
  const raw = concat(
    `tree ${tree}\nparent ${parent}\nauthor ${stamp(author)}\ncommitter ${stamp(committer)}\n${headers}\n`,
    message,
  )
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

/** A commit on HEAD whose tree holds one file at `path`, a path of any bytes. */
async function pathCommit(
  f: Fixture,
  dir: string,
  path: Uint8Array,
  mode = "100644",
  content: Uint8Array = Buffer.from("content\n"),
) {
  const hashed = async (type: string, content: Uint8Array) =>
    run(["git", "hash-object", "-t", type, "-w", "--literally", "--stdin"], dir, content)
  const components = nulFreeSplit(path)
  let entry = concat(
    `${mode} `,
    components.at(-1)!,
    "\0",
    Buffer.from(await hashed("blob", content), "hex"),
  )
  for (const component of components.slice(0, -1).reverse()) {
    const tree = await hashed("tree", entry)
    entry = concat("40000 ", component, "\0", Buffer.from(tree, "hex"))
  }
  const tree = await hashed("tree", entry)
  const parent = await f.git(dir, "rev-parse", "HEAD")
  const commit = await hashed(
    "commit",
    Buffer.from(
      `tree ${tree}\nparent ${parent}\nauthor ${agentLine}\ncommitter ${agentLine}\n\nAdd a file\n`,
    ),
  )
  await f.git(dir, "reset", "-q", "--soft", commit)
}

/** The components of a path, split at each `/` byte. */
const nulFreeSplit = (path: Uint8Array) => {
  const parts: Uint8Array[] = []
  let start = 0
  for (let end = path.indexOf(0x2f); end >= 0; end = path.indexOf(0x2f, start)) {
    parts.push(path.subarray(start, end))
    start = end + 1
  }
  parts.push(path.subarray(start))
  return parts
}

const textChecks: Record<SealedTextField, ReadonlyArray<SealedResultCheck>> = {
  title: ["title"],
  body: ["body"],
  finalMessage: ["final_message"],
  commitMessage: ["commit_message"],
  path: ["path_name", "github_path"],
}

// The daemon's rules for each text and path, run on the cases that the seal runs on too.
for (const item of sealedTextCases)
  test(
    `the daemon gives the ${item.field} ${shown(item.value.slice(0, 40))} of the shared table its expected result`,
    withFixture(async (f) => {
      const manifestText = ["title", "body", "finalMessage"].includes(item.field)
      const json = manifest(f.sourceSha, manifestText ? { [item.field]: item.value } : {})
      const bundle = manifestText
        ? await handBundle(f, (git, dir) => commitFile(git, dir, "a.txt"))
        : await handBundle(f, (_git, dir) =>
            item.field === "path"
              ? pathCommit(f, dir, pathBytes(item))
              : commitObject(f, dir, "", item.value),
          )
      const decoded = await Effect.runPromiseExit(decodeSealedResult(json, bundle))
      const exit: Exit.Exit<unknown, unknown> = Exit.isSuccess(decoded)
        ? await publish(decoded.value, options(f))
        : decoded
      if (item.accepted) {
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
      } else {
        expect(textChecks[item.field]).toContain(refusedCheck(exit))
        expectPrintable(refusal(exit))
      }
    }),
    30_000,
  )

test("the seal's ranges of default-ignorable code points are the property class of the daemon's engine", async () => {
  const child = Bun.spawn(
    [
      "python3",
      "-I",
      "-B",
      "-c",
      `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('result', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps(m.DEFAULT_IGNORABLE))
`,
      script,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
  const seal = Schema.decodeUnknownSync(Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])))(
    JSON.parse(stdout),
  )
  const property = /\p{Default_Ignorable_Code_Point}/u
  const engine: Array<readonly [number, number]> = []
  for (let code = 0; code <= 0x10ffff; code++) {
    if (!property.test(String.fromCodePoint(code))) continue
    const last = engine.at(-1)
    if (last !== undefined && last[1] === code - 1) engine[engine.length - 1] = [last[0], code]
    else engine.push([code, code])
  }
  expect(seal).toEqual(engine)
})

// A long path with characters that the path rule accepts and a refusal escapes.
const longPath = `\u00e9\u96ea${"x".repeat(3000)}.txt`

const pathRefusals: ReadonlyArray<
  readonly [SealedResultCheck, (f: Fixture, dir: string) => Promise<void>]
> = [
  ["github_path", (f, dir) => pathCommit(f, dir, Buffer.from(`.github/${longPath}`))],
  ["file_mode", (f, dir) => pathCommit(f, dir, Buffer.from(longPath), "120000")],
  [
    "mode_change",
    async (f, dir) => {
      await pathCommit(f, dir, Buffer.from(longPath))
      await pathCommit(f, dir, Buffer.from(longPath), "100755")
    },
  ],
  [
    "blob_size",
    (f, dir) =>
      pathCommit(
        f,
        dir,
        Buffer.from(longPath),
        "100644",
        new Uint8Array(sealedResultLimits.blobBytes + 1),
      ),
  ],
]

for (const [check, build] of pathRefusals)
  test(
    `the path in a refusal ${check} is printable ASCII of a bounded length`,
    withFixture(async (f) => {
      const bundle = await handBundle(f, (_git, dir) => build(f, dir))
      const exit = await publish(await decode(manifest(f.sourceSha), bundle), options(f))
      expect(refusedCheck(exit)).toBe(check)
      expectPrintable(refusal(exit))
      expect(refusal(exit).detail).toContain("\\u{e9}\\u{96ea}")
    }),
    30_000,
  )

test(
  "a push that git refuses with no status line is a fault push whose text holds no token and is printable ASCII of a bounded length",
  withFixture(async (f) => {
    const stderr = join(f.root, "stderr")
    await writeFile(stderr, `${token} ${hostileValues.join("")}`)
    const failing = join(f.root, "failing-push-git")
    await writeFile(
      failing,
      `#!/bin/sh\nfor arg; do [ "$arg" = push ] && { cat ${stderr} >&2; exit 1; }; done\nexec /usr/bin/git "$@"\n`,
    )
    await chmod(failing, 0o755)
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const exit = await publish(
      await decode(sealed.json, sealed.bundle),
      options(f, { binary: failing }),
    )
    const error = failure(exit)
    if (!(error instanceof SealedResultFault)) throw error
    expect(error.operation).toBe("push")
    expect(error.message).toStartWith("git push exited 1: ")
    expect(error.message).not.toContain(token)
    expect(error.message).toMatch(printableAscii)
    expect(error.message.length).toBeLessThanOrEqual(2000)
    expect(await remoteRef(f)).toBe("")
  }),
  30_000,
)

test(
  "a git child that cannot be started is a fault of its command, with no token and in printable ASCII",
  withFixture(async (f) => {
    // A git of the test that removes the scratch directory after init: the next child
    // cannot be started, since the size of its scratch cannot be read.
    const removing = join(f.root, "removing-git")
    await writeFile(
      removing,
      `#!/bin/sh\nfor arg; do [ "$arg" = init ] && { /usr/bin/git "$@" && rm -rf "$PWD"; exit; }; done\nexec /usr/bin/git "$@"\n`,
    )
    await chmod(removing, 0o755)
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const exit = await publish(
      await decode(sealed.json, sealed.bundle),
      options(f, { binary: removing }),
    )
    const error = failure(exit)
    if (!(error instanceof SealedResultFault)) throw error
    expect(error.message).toStartWith(`git ${error.operation} failed: `)
    expect(error.message).toContain("ENOENT")
    expect(error.message).not.toContain(token)
    expect(error.message).toMatch(printableAscii)
    expect(await remoteRef(f)).toBe("")
  }),
  30_000,
)

test("a scratch directory that cannot be removed after its check is logged as remaining", async () => {
  const f = await fixture()
  // A git of the test that leaves a directory the daemon cannot read after init.
  const locking = join(f.root, "locking-git")
  await writeFile(
    locking,
    `#!/bin/sh\nfor arg; do [ "$arg" = init ] && { /usr/bin/git "$@" && mkdir -p "$PWD/locked/x" && chmod 000 "$PWD/locked"; exit; }; done\nexec /usr/bin/git "$@"\n`,
  )
  await chmod(locking, 0o755)
  try {
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    const logs: string[] = []
    const logged = Logger.layer([Logger.make((entry) => logs.push(Bun.inspect(entry)))])
    const opts = options(f, { binary: locking })
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.scoped(checkSealedResult(result, target, opts)),
        Layer.mergeAll(gitLayer(opts.git), logged),
      ),
    )
    expect(failure(exit)).toBeInstanceOf(SealedResultFault)
    expect(
      logs.filter((line) => line.includes("Sealed result scratch directory remains")),
    ).toHaveLength(1)
    expect(await scratchEntries(f.scratchRoot)).toHaveLength(1)
  } finally {
    for (const entry of await scratchEntries(f.scratchRoot))
      await chmod(join(f.scratchRoot, entry, "locked"), 0o700)
    await rm(f.root, { recursive: true, force: true })
  }
}, 30_000)

test(
  "a git runner whose scratch of an earlier process cannot be removed is not built",
  withFixture(async (f) => {
    const locked = join(f.scratchRoot, "sealed-result-earlier", "locked")
    await mkdir(join(locked, "x"), { recursive: true })
    await chmod(locked, 0o000)
    try {
      expect(lockFault(await built(options(f).git))).toEqual({
        operation: "scratch",
        message: "Scratch directories of an earlier process remain",
      })
    } finally {
      await chmod(locked, 0o700)
      await rm(join(f.scratchRoot, "sealed-result-earlier"), { recursive: true })
    }
  }),
)

test(
  "a scratch directory that cannot be made below the root is a fault scratch, before a token is made",
  withFixture(async (f) => {
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const result = await decode(sealed.json, sealed.bundle)
    const { runner, close } = await openRunner(options(f).git)
    // The root stays private, but the daemon can no longer write in it.
    await chmod(f.scratchRoot, 0o500)
    let minted = 0
    try {
      const exit = await publish(
        result,
        options(f, {
          token: Effect.sync(() => {
            minted += 1
            return Redacted.make(token)
          }),
        }),
        undefined,
        undefined,
        runner,
      )
      expect(failure(exit)).toMatchObject({
        _tag: "SealedResultFault",
        operation: "scratch",
        message: "Scratch directory unavailable",
      })
    } finally {
      await chmod(f.scratchRoot, 0o700)
      await close()
    }
    expect(minted).toBe(0)
  }),
  30_000,
)

test(
  "the error output of index-pack is shown in a refusal fsck as printable ASCII of a bounded length",
  withFixture(async (f) => {
    const stderr = join(f.root, "stderr")
    await writeFile(stderr, hostileValues.join(""))
    const failing = join(f.root, "failing-index-pack-git")
    await writeFile(
      failing,
      `#!/bin/sh\nfor arg; do [ "$arg" = index-pack ] && { cat ${stderr} >&2; exit 1; }; done\nexec /usr/bin/git "$@"\n`,
    )
    await chmod(failing, 0o755)
    const sealed = await sealWithResultPy(f, async (workspace) => {
      await writeFile(join(workspace, "result.txt"), "content\n")
    })
    const exit = await publish(
      await decode(sealed.json, sealed.bundle),
      options(f, { binary: failing }),
    )
    expect(refusedCheck(exit)).toBe("fsck")
    expectPrintable(refusal(exit))
    expect(refusal(exit).detail).toStartWith('"a\\u{1}b')
  }),
  30_000,
)
