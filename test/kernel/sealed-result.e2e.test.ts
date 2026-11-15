import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Redacted, Schema } from "effect"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  checkSealedResult,
  decodeSealedResult,
  pushSealedResult,
  SealedResultFault,
  SealedResultRefused,
  sealedResultLimits,
  type SealedResult,
  type SealedResultCheck,
  type SealedResultOptions,
} from "../../src/kernel/sealed-result"
import { command } from "../sandbox/harness"

// The real sealing script of the runner, and a daemon check that pushes into a bare
// fixture remote on disk. Nothing here reaches GitHub.
const script = resolve("deploy/sandbox/result.py")
const target = { ref: "refs/heads/agent-run/run-1", expectedHead: null }
const token = "ghs_FixtureInstallationToken0123456789"
const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"]
const wording = {
  title: "Add the result file",
  commitMessage: "Add the result file\n\nThe run wrote one file.\n",
  body: "## Result\n\nOne file.",
  finalMessage: "Done: one file added.",
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
  await mkdir(scratchRoot)
  const git = (cwd: string, ...args: string[]) => command(["git", ...identity, ...args], cwd)
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
  blockedEmails: ["owner@example.invalid"],
  scratchRoot: f.scratchRoot,
  ...extra,
})

const manifest = (sourceSha: string, fields: Record<string, unknown> = {}) =>
  new TextEncoder().encode(JSON.stringify({ sourceSha, ...wording, ...fields }))

/** Seals a workspace with the real result.py: export of a workspace archive, then seal. */
async function sealWithResultPy(
  f: Fixture,
  change: (workspace: string) => Promise<void>,
  completion: Record<string, unknown> = wording,
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
    stdin: new Blob([JSON.stringify({ completion, sensitiveValues: [] })]),
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
  build: (git: (...args: string[]) => Promise<string>, dir: string) => Promise<void>,
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
  await git("commit", "-q", "-m", `add ${path}`)
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
      wording.commitMessage.trim(),
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
    expect(result).toMatchObject(dashed)
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
  ["a NUL in the commit message", { commitMessage: "one\u0000two" }, "commit_message"],
  ["a NUL in the body", { body: "one\u0000two" }, "body"],
  ["a NUL in the final message", { finalMessage: "one\u0000two" }, "final_message"],
  ["an empty title", { title: "" }, "title"],
  ["a title that is not text", { title: 7 }, "title"],
  ["a source that is not a commit id", { sourceSha: "--upload-pack=touch" }, "source"],
] as const)
  test(`result.json with ${name} is refused`, async () => {
    const error = await Effect.runPromise(
      Effect.flip(decodeSealedResult(manifest("a".repeat(40), fields), new Uint8Array([1, 2, 3]))),
    )
    expect(error).toBeInstanceOf(SealedResultRefused)
    expect(error.check).toBe(check)
  })

test("result.json with a key outside SealedResult is refused by the name of the key", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      decodeSealedResult(manifest("a".repeat(40), { branch: "main" }), new Uint8Array([1, 2, 3])),
    ),
  )
  expect(error.check).toBe("unknown_key")
  expect(error.message).toBe('result_refused: unknown_key "branch"')
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
  "the push token of the installation is asked for contents only, and reaches git as a header",
  withFixture(async (f) => {
    const { generateKeyPairSync } = await import("node:crypto")
    const { Octokit } = await import("@octokit/rest")
    const { makeSandboxGithub } = await import("../../src/sandbox/github")
    const privateKeyPath = join(f.root, "app.pem")
    await writeFile(
      privateKeyPath,
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
      { mode: 0o600 },
    )
    const requests: unknown[] = []
    // A GitHub API stub; nothing here reaches GitHub.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({ path: new URL(request.url).pathname, body: await request.json() })
        return Response.json({ token }, { status: 201 })
      },
    })
    try {
      const github = await Effect.runPromise(
        makeSandboxGithub(
          { appId: 1, privateKeyPath },
          Octokit.defaults({ baseUrl: server.url.toString().replace(/\/$/, "") }),
        ),
      )
      const pushToken = await Effect.runPromise(
        github.pushToken({ repository: "fixture/repo", repositoryId: 12, installationId: 34 }),
      )
      expect(requests).toEqual([
        {
          path: "/app/installations/34/access_tokens",
          body: { repository_ids: [12], permissions: { contents: "write" } },
        },
      ])
      const recorder = await recordingGit(f)
      const sealed = await sealWithResultPy(f, async (workspace) => {
        await writeFile(join(workspace, "result.txt"), "content\n")
      })
      const result = await decode(sealed.json, sealed.bundle)
      const exit = await publish(result, options(f, { token: pushToken, gitBinary: recorder.path }))
      expect(Exit.isSuccess(exit)).toBe(true)
      const push = (await recorder.calls()).find((call) => call.argv.includes("push"))!
      expect(push.env.GIT_CONFIG_KEY_0).toBe(`http.${f.remote}.extraHeader`)
      expect(push.env.GIT_CONFIG_VALUE_0).toBe(
        `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      )
    } finally {
      await server.stop(true)
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
    const moved = await command(
      ["git", ...identity, "commit-tree", "-m", "moved", `${f.sourceSha}^{tree}`],
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

test(
  "a bundle that expands past the bounds is refused inside the time and disk limits, before git unpacks it",
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
    expect(Date.now() - started).toBeLessThan(sealedResultLimits.timeLimitMs)
    // No git child ever read the bundle: the bound held during the unpack.
    const calls = await Bun.file(join(f.root, "git-calls.jsonl"))
      .exists()
      .then((exists) => (exists ? recorder.calls() : []))
    expect(calls.some((call) => call.argv.includes("index-pack"))).toBe(false)
    expect(await remoteRef(f)).toBe("")
  }),
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

const refusals: ReadonlyArray<
  readonly [
    string,
    SealedResultCheck,
    (f: Fixture) => Promise<{ bundle: Uint8Array; json?: Uint8Array }>,
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
  [
    "a .git path",
    "fsck",
    async (f) => ({
      bundle: await handBundle(f, async (git, dir) => {
        const content = await git("hash-object", "-w", "README.md")
        const inner = await mktree(dir, `100644 blob ${content}\tconfig\n`)
        const entries = await git("ls-tree", await git("write-tree"))
        const tree = await mktree(dir, `${entries}\n040000 tree ${inner}\t.GIT\n`)
        const commit = await git("commit-tree", tree, "-p", "HEAD", "-m", "dot git")
        await git("reset", "-q", "--soft", commit)
      }),
    }),
  ],
  [
    "a path below .GitHub/",
    "github_path",
    async (f) => ({
      bundle: await handBundle(f, (git, dir) =>
        commitFile(git, dir, ".GitHub/workflows/x.yml", "on: push\n"),
      ),
    }),
  ],
  [
    "a blocked author address",
    "identity",
    async (f) => ({
      bundle: await handBundle(f, async (git, dir) => {
        await writeFile(join(dir, "a.txt"), "a\n")
        await git("add", "a.txt")
        await git("commit", "-q", "--author=Owner <Owner@Example.invalid>", "-m", "blocked")
      }),
    }),
  ],
  [
    "a blocked committer address",
    "identity",
    async (f) => ({
      bundle: await handBundle(f, async (git, dir) => {
        await writeFile(join(dir, "a.txt"), "a\n")
        await git("add", "a.txt")
        // The committer comes from the environment, which wins over any config.
        const child = Bun.spawn(["git", "commit", "-q", "-m", "blocked"], {
          cwd: dir,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "Owner",
            GIT_COMMITTER_EMAIL: "owner@example.invalid",
          },
        })
        expect(await child.exited).toBe(0)
      }),
    }),
  ],
]

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

for (const [name, check, make] of refusals)
  test(
    `the daemon refuses ${name}: result_refused: ${check}`,
    withFixture(async (f) => {
      const made = await make(f)
      const result = await decode(made.json ?? manifest(f.sourceSha), made.bundle)
      const exit = await publish(result, options(f))
      expect(refusedCheck(exit)).toBe(check)
      expect(refusal(exit).message).toStartWith(`result_refused: ${check}`)
      expect(await remoteRef(f)).toBe("")
    }),
    30_000,
  )
