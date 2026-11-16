import { expect, test } from "bun:test"
import { Schema } from "effect"
import { chmod, mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { command } from "./harness"
import { pathBytes, sealedTextCases } from "../kernel/sealed-text-cases"

const wording = {
  body: "## Result\n\nReadable agent description.",
  title: "Title 雪",
  commitMessage: "Message 雪\n\n```sh\necho value\n```\n",
}
const script = resolve("deploy/sandbox/result.py")
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

test("sealing keeps the agent name opaque and sends only digests and commit identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-result-"))
  const repo = join(root, "repository")
  const output = join(root, "result")
  await mkdir(repo)
  try {
    await command(["git", "init", "-b", "main"], repo)
    await command(["git", "config", "user.name", "Fixture"], repo)
    await command(["git", "config", "user.email", "fixture@example.invalid"], repo)
    await writeFile(join(repo, "base"), "base\n")
    await command(["git", "add", "."], repo)
    await command(["git", "commit", "-m", "base"], repo)
    const sourceSha = await command(["git", "rev-parse", "HEAD"], repo)
    await writeFile(join(repo, "result"), "runner-only-result\n")
    await command(["git", "add", "."], repo)
    await command(["git", "commit", "-m", "result"], repo)
    const treeSha = await command(["git", "rev-parse", "HEAD^{tree}"], repo)
    const resultSha = await command(["git", "rev-parse", "HEAD"], repo)
    await command(["git", "update-ref", "refs/remotes/container-use/one", resultSha], repo)
    await command(["git", "update-ref", "refs/remotes/container-use/two", sourceSha], repo)
    await command(["git", "checkout", "--detach", sourceSha], repo)
    const branch = "a name with ' quotes/$()\n雪"
    const seal = (completion: unknown = { ...wording, branch, environmentId: "one" }) => {
      const child = Bun.spawn(["python3", script, "seal", sourceSha], {
        cwd: root,
        stdin: new Blob([JSON.stringify(completion)]),
        stdout: "pipe",
        stderr: "pipe",
      })
      return Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
    }
    const [status, text] = await seal()
    expect(status).toBe(0)
    const metadata = JSON.parse(text)
    const bundle = new Uint8Array(await Bun.file(join(output, "result.bundle")).arrayBuffer())
    const manifest = new Uint8Array(await Bun.file(join(output, "result.json")).arrayBuffer())
    expect(metadata).toEqual({
      ...wording,
      treeSha,
      sourceSha,
      resultSha,
      branch,
      bundleSha256: digest(bundle),
      manifestSha256: digest(manifest),
    })
    expect(text).not.toContain("runner-only-result")
    expect(JSON.parse(new TextDecoder().decode(manifest))).toEqual({
      ...wording,
      treeSha,
      sourceSha,
      resultSha,
      branch,
      bundleSha256: digest(bundle),
    })
    expect((await seal())[1]).toBe(text)
    const changed = await seal({
      ...wording,
      branch,
      environmentId: "one",
      body: "Changed description",
    })
    expect(changed[0]).toBe(0)
    expect(JSON.parse(changed[1]).manifestSha256).not.toBe(metadata.manifestSha256)
    const other = await seal({ ...wording, branch, environmentId: "two" })
    expect(other[0]).toBe(0)
    expect(JSON.parse(other[1])).toEqual({ empty: true, sourceSha })
    for (const fields of [
      { body: "<!-- hidden -->" },
      { body: "@org/team" },
      { body: "Closes #1" },
      { body: "é".repeat(16385) },
      { body: "\ud800" },
      { body: "bad\u200dtext" },
      { body: "bad\ttext" },
      { title: "bad\nline" },
      { title: "x".repeat(201) },
      { commitMessage: "bad\tcontrol" },
      { branch: "x".repeat(262145) },
      { title: "hidden\u200btitle" },
      { commitMessage: "bidi\u202emessage" },
      { commitMessage: "é".repeat(5121) },
      { title: "\ud800" },
      { commitMessage: "\udfff" },
    ]) {
      expect((await seal({ ...wording, branch, environmentId: "one", ...fields }))[0]).not.toBe(0)
    }
    for (const completion of [
      { branch },
      { ...wording, branch, environmentId: "missing" },
      { ...wording, branch, environmentId: "one^{commit}" },
    ]) {
      const rejected = await seal(completion)
      expect(rejected[0]).not.toBe(0)
      expect(rejected[2]).toContain("container-use result")
    }
    await command(["git", "update-ref", "-d", "refs/remotes/container-use/two"], repo)
    expect((await seal({ branch }))[0]).not.toBe(0)
    await command(["git", "commit", "--allow-empty", "-m", "empty result"], repo)
    await command(["git", "update-ref", "refs/remotes/container-use/one", "HEAD"], repo)
    const empty = await seal()
    expect(empty[0]).toBe(0)
    expect(JSON.parse(empty[1])).toEqual({ empty: true, sourceSha })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const mutation of [
  "ordinary",
  "maximum metadata",
  "hidden history",
  "credential blob",
  "credential title",
  "symlink",
  "mode",
  "extra head",
  "archive traversal",
  "swapped archive",
  "source option",
  "result option",
  "source helper",
  "title mismatch",
  "message mismatch",
  "body mismatch",
  "tree mismatch",
])
  test(`publisher validates actual Git objects and bounded ZIP: ${mutation}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-bundle-"))
    const repo = join(root, "repository")
    const output = join(root, "result")
    await mkdir(repo)
    const git = (...args: string[]) => command(["git", ...args], repo)
    const text =
      mutation === "maximum metadata"
        ? { title: "雪".repeat(200), commitMessage: "m".repeat(10240), body: "é".repeat(16384) }
        : mutation === "credential title"
          ? { ...wording, title: "ghp_" + "a".repeat(32) }
          : wording
    try {
      await git("init", "-b", "main")
      await git("config", "user.name", "Fixture")
      await git("config", "user.email", "fixture@example.invalid")
      await writeFile(join(repo, "base"), "source\n")
      await git("add", ".")
      await git("commit", "-m", "base")
      const sourceSha = await git("rev-parse", "HEAD")
      if (mutation === "hidden history") {
        await mkdir(join(repo, ".github"))
        await writeFile(join(repo, ".github", "bad"), "forbidden")
        await git("add", ".")
        await git("commit", "-m", "hidden bad change")
        await rm(join(repo, ".github"), { recursive: true })
      }
      await writeFile(
        join(repo, "result"),
        mutation === "credential blob" ? "ghp_" + "a".repeat(32) : "accepted bytes\n",
      )
      if (mutation === "symlink") await command(["ln", "-s", "base", "link"], repo)
      await git("add", "-A")
      if (mutation === "mode") await git("update-index", "--chmod=+x", "base")
      await git("commit", "-m", "result")
      const resultSha = await git("rev-parse", "HEAD")
      await git("update-ref", "refs/remotes/container-use/one", resultSha)
      const child = Bun.spawn(["python3", script, "seal", sourceSha], {
        cwd: root,
        stdin: new Blob([
          JSON.stringify({ ...text, branch: "chosen/by/agent", environmentId: "one" }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const metadata = JSON.parse(await new Response(child.stdout).text())
      expect(await child.exited).toBe(0)
      if (mutation === "extra head") {
        await git(
          "bundle",
          "create",
          join(output, "result.bundle"),
          "HEAD",
          "refs/workflowd/result",
          "^" + sourceSha,
        )
        const manifest = JSON.parse(await Bun.file(join(output, "result.json")).text())
        manifest.bundleSha256 = digest(
          new Uint8Array(await Bun.file(join(output, "result.bundle")).arrayBuffer()),
        )
        await writeFile(join(output, "result.json"), JSON.stringify(manifest))
        metadata.manifestSha256 = digest(
          new Uint8Array(await Bun.file(join(output, "result.json")).arrayBuffer()),
        )
      }
      if (
        mutation === "title mismatch" ||
        mutation === "message mismatch" ||
        mutation === "body mismatch"
      ) {
        const manifest = JSON.parse(await Bun.file(join(output, "result.json")).text())
        manifest[
          mutation === "title mismatch"
            ? "title"
            : mutation === "body mismatch"
              ? "body"
              : "commitMessage"
        ] = "changed"
        await writeFile(join(output, "result.json"), JSON.stringify(manifest))
      }
      const archive = join(root, "result.zip")
      await command(["zip", "-q", archive, "result.bundle", "result.json"], output)
      if (mutation === "archive traversal")
        await command([
          "python3",
          "-c",
          "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'a'); z.writestr('../bad','bad'); z.close()",
          archive,
        ])
      const binding = {
        tree: metadata.treeSha,
        source: sourceSha,
        result: resultSha,
        manifest: metadata.manifestSha256,
        digest: "sha256:" + digest(new Uint8Array(await Bun.file(archive).arrayBuffer())),
      }
      if (mutation === "tree mismatch") binding.tree = sourceSha
      if (mutation === "swapped archive") binding.digest = "sha256:" + "0".repeat(64)
      if (mutation === "source option") binding.source = "--help"
      if (mutation === "result option") binding.result = "--all"
      const source = mutation === "source helper" ? "ext::sh -c touch% helper-executed" : repo
      const validated = Bun.spawn(["python3", script, "validate", source], {
        cwd: root,
        stdin: new Blob([JSON.stringify(binding)]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [status, stdout] = await Promise.all([
        validated.exited,
        new Response(validated.stdout).text(),
        new Response(validated.stderr).text(),
      ])
      if (mutation === "ordinary" || mutation === "maximum metadata") {
        expect(status).toBe(0)
        expect(JSON.parse(stdout).resultSha).toBe(resultSha)
        // Exercise the exact hosted entrypoint; only GitHub is an HTTP fixture.
        const hostilePath = join(root, "bin")
        await mkdir(hostilePath)
        await writeFile(join(hostilePath, "python3"), "#!/bin/sh\nexit 99\n")
        await chmod(join(hostilePath, "python3"), 0o755)
        await mkdir(join(root, "fixture"))
        await symlink(repo, join(root, "fixture", "repo.git"))
        const approved = { v: 4, run: 41, attempt: 1, artifact: 52, ...binding, base: "main" }
        const api = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            expect(request.headers.get("Authorization")).toBe("Bearer read-only-fixture")
            const path = new URL(request.url).pathname
            if (path.endsWith("/approvals"))
              return Response.json([
                {
                  state: "approved",
                  user: { id: 306741873, type: "Bot" },
                  environments: [{ id: 9, name: "agent-publish" }],
                  comment: JSON.stringify(approved),
                },
              ])
            if (path.endsWith("/artifacts/52"))
              return Response.json({
                id: 52,
                name: "sandbox-result-41-1",
                digest: binding.digest,
                expired: false,
                size_in_bytes: 100,
                workflow_run: {
                  id: 41,
                  repository_id: 7,
                  head_repository_id: 7,
                  head_sha: sourceSha,
                  head_branch: "workflowd/leases/one",
                },
              })
            if (path.endsWith("/zip")) return new Response(Bun.file(archive))
            return new Response(null, { status: 404 })
          },
        })
        const env = {
          PATH: hostilePath + ":" + process.env.PATH,
          RUNNER_TEMP: root,
          GITHUB_API_URL: api.url.toString().replace(/\/$/, ""),
          GITHUB_SERVER_URL: "file://" + root,
          GITHUB_REPOSITORY: "fixture/repo",
          GITHUB_REPOSITORY_ID: "7",
          GITHUB_RUN_ID: "41",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SHA: sourceSha,
          GITHUB_REF_NAME: "workflowd/leases/one",
          GATE_ACTOR_ID: "306741873",
          GITHUB_TOKEN: "read-only-fixture",
        }
        const actionPath = resolve(".github/actions/agent-publish")
        const action = Schema.decodeUnknownSync(
          Schema.Struct({
            runs: Schema.Struct({
              steps: Schema.Array(Schema.Struct({ run: Schema.optionalKey(Schema.String) })),
            }),
          }),
        )(Bun.YAML.parse(await Bun.file(join(actionPath, "action.yml")).text()))
        const invoke = async () => {
          const process = Bun.spawn(
            [
              "bash",
              "--noprofile",
              "--norc",
              "-e",
              "-o",
              "pipefail",
              "-c",
              action.runs.steps[0]!.run!,
            ],
            {
              cwd: root,
              env: {
                ...env,
                GITHUB_ACTION_PATH: actionPath,
                GHETTIMONSTER_APP_ID: "5232172",
                PUBLISH_CO_AUTHOR: "Ben Nasraoui <81005232+BNasraoui@users.noreply.github.com>",
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          return Promise.all([
            process.exited,
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
          ])
        }
        try {
          expect((await invoke())[0]).toBe(0)
          const validated = JSON.parse(
            await Bun.file(join(root, "workflowd-publish/validated.json")).text(),
          )
          expect(validated.binding.base).toBe("main")
          expect(validated.metadata.resultSha).toBe(resultSha)
          expect(validated.metadata.title).toBe(text.title)
          expect(validated.metadata.commitMessage).toBe(text.commitMessage)
        } finally {
          await api.stop(true)
        }
        expect(
          await command([
            "git",
            "--git-dir=" + join(root, "validated", "objects.git"),
            "show",
            resultSha + ":result",
          ]),
        ).toBe("accepted bytes")
      } else {
        expect(status).not.toBe(0)
        expect(
          await Bun.file(join(root, "validated", "objects.git", "helper-executed")).exists(),
        ).toBe(false)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

test("real SSH completion seals on the container-use runner and ends hold without code transfer", async () => {
  const { dispatchRunnerFixture, bridgeClient } = await import("./harness")
  const { sandboxSshArguments } = await import("../../src/sandbox/transport")
  const { readSandboxBinding, writeSandboxBinding } = await import("../../src/sandbox/binding")
  const { Schema } = await import("effect")
  const runner = await dispatchRunnerFixture()
  const client = bridgeClient(runner.transport)
  try {
    const base = await runner.docker("exec", `${runner.name}-runner`, "git", "rev-parse", "HEAD")
    await runner.docker(
      "exec",
      `${runner.name}-runner`,
      "sh",
      "-c",
      'printf "%s" "$1" > /run/workflowd-sandbox/source.sha',
      "_",
      base,
    )
    await client.initialize()
    await client.request("tools/list")
    const created = Schema.decodeUnknownSync(
      Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
    )(
      await client.request("tools/call", {
        name: "environment_create",
        arguments: { environment_source: "/workspace/repository", title: "Sealed result" },
      }),
    )
    const env = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      JSON.parse(created.content[0]!.text),
    )
    const result = await client.request("tools/call", {
      name: "environment_run_cmd",
      arguments: {
        environment_source: "/workspace/repository",
        environment_id: env.id,
        command: "printf runner-only-publication > published.txt",
      },
    })
    expect(JSON.stringify(result)).not.toContain('"isError":true')
    const binding = await readSandboxBinding(join(runner.root, "bridge-session"))
    await writeSandboxBinding({ ...binding, state: "revoked" })
    await client.close()
    const child = Bun.spawn(
      [
        ...sandboxSshArguments(runner.transport).slice(0, -1),
        "exec /usr/local/bin/runner-control finish-result",
      ],
      {
        stdin: new Blob([
          JSON.stringify({ ...wording, branch: "free choice/$() 雪", environmentId: env.id }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [status, text, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
    const metadata = JSON.parse(text)
    expect(metadata.sourceSha).toBe(base)
    expect(metadata.branch).toBe("free choice/$() 雪")
    expect(metadata).toMatchObject(wording)
    expect(text).not.toContain("runner-only-publication")
    expect(await Bun.file(join(runner.root, "result.bundle")).exists()).toBe(false)
    expect(
      await runner.docker(
        "exec",
        `${runner.name}-runner`,
        "git",
        "show",
        metadata.resultSha + ":published.txt",
      ),
    ).toBe("runner-only-publication")
    await command([
      ...sandboxSshArguments(runner.transport).slice(0, -1),
      "exec /usr/local/bin/runner-control finish",
    ])
    expect(
      await runner.docker(
        "exec",
        `${runner.name}-runner`,
        "test",
        "-e",
        "/run/workflowd-sandbox/finished",
      ),
    ).toBe("")
  } finally {
    await client.close()
    await runner.close()
  }
}, 300000)

// Native seal and export: the runner's workspace becomes one bundle and a result.json
// with exactly the SealedResult keys. The run names no branch.
const native = {
  title: "Native result",
  commitMessage: "Native change\n\nOne file.",
  body: "## Result\n\nNative change.",
  finalMessage: "Done.\n\tA tab and a newline stay.",
}
const secret = "fixture-sensitive-value-93b28a5d"
// The identity the daemon gives agent runs; the seal commits with it.
const identity = { name: "Fixture Agent", email: "agent@example.invalid" }

async function nativeSource(root: string) {
  const work = join(root, "work")
  await mkdir(work)
  const git = (...args: string[]) =>
    command(
      ["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
      work,
    )
  await git("init", "-q", "-b", "main")
  await writeFile(join(work, ".gitignore"), "/build-cache/\n")
  await writeFile(join(work, "base.txt"), "base\n")
  await git("add", ".")
  await git("commit", "-q", "-m", "source")
  const source = await git("rev-parse", "HEAD")
  await command(["git", "clone", "-q", "--bare", work, join(root, "source.git")])
  return { work, git, source }
}

const nativeSeal = async (root: string, source: string, request: unknown) => {
  const child = Bun.spawn(["python3", "-I", script, "native-seal", source], {
    cwd: root,
    stdin: new Blob([JSON.stringify(request)]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { status, stdout, stderr: stderr.trim() }
}

test("native export restores only bounded regular files and drops .git", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-export-"))
  try {
    const { work } = await nativeSource(root)
    await command(["tar", "-cf", join(root, "workspace.tar"), "-C", work, "."])
    await command(["python3", "-I", script, "native-export", "workspace.tar"], root)
    expect(await Bun.file(join(root, "repository/base.txt")).text()).toBe("base\n")
    expect(await Bun.file(join(root, "repository/.git/HEAD")).exists()).toBe(false)
    await rm(join(root, "repository"), { recursive: true, force: true })
    await command(
      [
        "python3",
        "-I",
        "-c",
        "import tarfile; f=tarfile.open('bad.tar','w'); i=tarfile.TarInfo('../escaped'); i.size=0; f.addfile(i); f.close()",
      ],
      root,
    )
    await expect(
      command(["python3", "-I", script, "native-export", "bad.tar"], root),
    ).rejects.toThrow()
    expect(await Bun.file(join(root, "escaped")).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const variant of ["ignored", "selected", "negative size"] as const)
  test(`native export never materializes a workspace link: ${variant}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-export-link-"))
    try {
      const { work, source } = await nativeSource(root)
      await mkdir(join(work, "build-cache"))
      await writeFile(join(root, "outside"), "untouched\n")
      await symlink(
        join(root, "outside"),
        join(work, variant === "selected" ? "link" : "build-cache/link"),
      )
      await command(["tar", "--exclude=.git", "-cf", join(root, "workspace.tar"), "-C", work, "."])
      if (variant === "negative size")
        await command(
          [
            "python3",
            "-I",
            "-c",
            "import tarfile\nwith tarfile.open('workspace.tar') as source, tarfile.open('malformed.tar','w',format=tarfile.GNU_FORMAT) as target:\n for item in source:\n  if item.issym(): item.size=-1\n  target.addfile(item,source.extractfile(item) if item.isfile() else None)\n",
          ],
          root,
        )
      const archive = variant === "negative size" ? "malformed.tar" : "workspace.tar"
      const exported = command(["python3", "-I", script, "native-export", archive, source], root)
      if (variant === "ignored") {
        await exported
        expect(await Bun.file(join(root, "repository/base.txt")).text()).toBe("base\n")
        expect(await Bun.file(join(root, "repository/build-cache/link")).exists()).toBe(false)
      } else await expect(exported).rejects.toThrow()
      expect(await Bun.file(join(root, "outside")).text()).toBe("untouched\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

// Each refused variant and the reason the seal gives for it.
const refusedSeals = new Map([
  ["encoded canary", "Sensitive public content"],
  ["metadata canary", "Sensitive public content"],
  ["symlink", "Selected export link"],
  ["forbidden path", "Unsafe path component"],
  ["branch key", "Invalid native metadata"],
  ["missing final message", "Invalid native metadata"],
  ["NUL in the final message", "Invalid final message"],
  ["terminal control sequence in the final message", "Invalid final message"],
  ["bidirectional control in the final message", "Invalid final message"],
  ["newline in the title", "Invalid publication text"],
  ["an identity with an angle bracket", "Invalid identity"],
  ["an identity with an invisible character", "Invalid identity"],
  ["no identity", "Invalid native request"],
])
const sealVariants = ["ordinary", ...refusedSeals.keys()]

for (const variant of sealVariants)
  test(`native seal checks before it writes a result: ${variant}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-seal-"))
    try {
      const { work, git, source } = await nativeSource(root)
      // History and local Git configuration of the workspace never enter the result or run.
      await writeFile(join(work, "removed.txt"), secret)
      await git("add", ".")
      await git("commit", "-q", "-m", secret)
      await rm(join(work, "removed.txt"))
      await git("config", "core.fsmonitor", `touch ${join(root, "executed")}`)
      await writeFile(
        join(work, "result.txt"),
        variant === "encoded canary"
          ? Buffer.from(secret).toString("base64")
          : "intended public content\n",
      )
      await mkdir(join(work, "build-cache"))
      await writeFile(join(work, "build-cache/private.txt"), secret)
      if (variant === "symlink") await symlink("/etc/passwd", join(work, "link"))
      if (variant === "forbidden path") {
        await mkdir(join(work, ".github"))
        await writeFile(join(work, ".github", "bad.yml"), "bad")
      }
      await command(["tar", "--exclude=.git", "-cf", join(root, "workspace.tar"), "-C", work, "."])
      const exported = command(
        ["python3", "-I", script, "native-export", "workspace.tar", source],
        root,
      )
      if (variant === "symlink") {
        // A selected link is refused at export, before any seal.
        await expect(exported).rejects.toThrow(
          `Sandbox result sealing failed: ${refusedSeals.get("symlink")}`,
        )
        expect(await Bun.file(join(root, "result")).exists()).toBe(false)
        return
      }
      await exported
      const completions: Record<string, Record<string, unknown>> = {
        "metadata canary": { ...native, body: secret },
        "branch key": { ...native, branch: "main" },
        "missing final message": {
          title: native.title,
          commitMessage: native.commitMessage,
          body: native.body,
        },
        "NUL in the final message": { ...native, finalMessage: "a\u0000b" },
        "terminal control sequence in the final message": {
          ...native,
          finalMessage: "a \u001b[2J b",
        },
        "bidirectional control in the final message": { ...native, finalMessage: "abc\u202edef" },
        "newline in the title": { ...native, title: "one\ntwo" },
      }
      const identities: Record<string, unknown> = {
        "an identity with an angle bracket": { name: "Fixture <Agent>", email: identity.email },
        "an identity with an invisible character": {
          name: "Fixture\u200bAgent",
          email: identity.email,
        },
      }
      const sealed = await nativeSeal(root, source, {
        completion: completions[variant] ?? native,
        sensitiveValues: [secret],
        ...(variant === "no identity" ? {} : { identity: identities[variant] ?? identity }),
      })
      expect(await Bun.file(join(root, "executed")).exists()).toBe(false)
      if (variant !== "ordinary") {
        expect(sealed.status).not.toBe(0)
        expect(sealed.stderr).toBe(`Sandbox result sealing failed: ${refusedSeals.get(variant)}`)
        expect(await Bun.file(join(root, "result/result.bundle")).exists()).toBe(false)
        expect(await Bun.file(join(root, "result/result.json")).exists()).toBe(false)
        return
      }
      expect(sealed.status).toBe(0)
      const json = await Bun.file(join(root, "result/result.json")).bytes()
      const bundle = await Bun.file(join(root, "result/result.bundle")).bytes()
      // The commit message is in the commit object only.
      const { commitMessage: _commitMessage, ...wording } = native
      expect(JSON.parse(new TextDecoder().decode(json))).toEqual({ sourceSha: source, ...wording })
      const metadata = Schema.decodeUnknownSync(
        Schema.Struct({
          sourceSha: Schema.String,
          resultSha: Schema.String,
          bundleSha256: Schema.String,
          manifestSha256: Schema.String,
        }),
      )(JSON.parse(sealed.stdout))
      expect(metadata).toEqual({
        sourceSha: source,
        resultSha: metadata.resultSha,
        bundleSha256: digest(bundle),
        manifestSha256: digest(json),
      })
      const clean = join(root, "clean.git")
      await command(["git", "clone", "-q", "--bare", join(root, "source.git"), clean])
      await command(
        [
          "git",
          "fetch",
          "-q",
          join(root, "result/result.bundle"),
          "refs/workflowd/result:refs/heads/result",
        ],
        clean,
      )
      expect(await command(["git", "rev-parse", "result"], clean)).toBe(metadata.resultSha)
      expect(await command(["git", "rev-list", "--count", `${source}..result`], clean)).toBe("1")
      expect(await command(["git", "log", "-1", "--format=%B", "result"], clean)).toBe(
        native.commitMessage,
      )
      expect(
        await command(["git", "show", "-s", "--format=%an <%ae>%n%cn <%ce>", "result"], clean),
      ).toBe(`${identity.name} <${identity.email}>\n${identity.name} <${identity.email}>`)
      expect(await command(["git", "show", "result:result.txt"], clean)).toBe(
        "intended public content",
      )
      expect(await command(["git", "ls-tree", "-r", "--name-only", "result"], clean)).not.toContain(
        "build-cache",
      )
      expect(await command(["git", "ls-tree", "-r", "--name-only", "result"], clean)).not.toContain(
        "removed.txt",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

// The seal's rules for each text and path, run on the cases that the daemon's check
// runs on too.
test("the seal gives each text and path of the shared table its expected result", async () => {
  const child = Bun.spawn(
    [
      "python3",
      "-I",
      "-B",
      "-c",
      `
import base64, importlib.util, json, sys
spec = importlib.util.spec_from_file_location('result', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
rules = {
    'title': lambda value: m.publication_text(value),
    'commitMessage': m.commit_message,
    'body': m.publication_body,
    'finalMessage': m.final_message,
    'path': lambda value: m.safe_path(base64.b64decode(value)),
}
results = []
for item in json.load(sys.stdin):
    try:
        rules[item['field']](item['value'])
        results.append(True)
    except ValueError:
        results.append(False)
print(json.dumps(results))
`,
      script,
    ],
    {
      stdin: new Blob([
        JSON.stringify(
          sealedTextCases.map((item) => ({
            field: item.field,
            value: item.field === "path" ? pathBytes(item).toString("base64") : item.value,
          })),
        ),
      ]),
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
  const results = Schema.decodeUnknownSync(Schema.Array(Schema.Boolean))(JSON.parse(stdout))
  expect(sealedTextCases.map((item, index) => ({ ...item, accepted: results[index] }))).toEqual([
    ...sealedTextCases,
  ])
})
