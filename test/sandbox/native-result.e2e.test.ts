import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { command } from "./harness"

const script = resolve("deploy/sandbox/result.py")
const completion = {
  branch: "arbitrary/agent-name",
  title: "Native result",
  commitMessage: "Native change",
  body: "## Result\n\nNative change.",
}
const secret = "fixture-sensitive-value-93b28a5d"

test("native source/export keeps Git custody private and restores only bounded regular workspace files", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-archive-"))
  const source = join(root, "source.git")
  await mkdir(source)
  try {
    await command(["git", "init", "-b", "main"], source)
    await writeFile(join(source, "file.txt"), "source\n")
    await command(["git", "add", "."], source)
    await command(["git", "commit", "-m", "source"], source)
    const sha = await command(["git", "rev-parse", "HEAD"], source)
    await command(["python3", "-I", script, "native-source", sha], root)
    const entries = await command(["tar", "-tvf", "source.tar"], root)
    expect(entries).toContain("1000/1000")
    expect(entries).toContain(".git/HEAD")
    expect(entries).toContain("file.txt")
    await command(["python3", "-I", script, "native-export", "source.tar"], root)
    expect(await Bun.file(join(root, "repository/file.txt")).text()).toBe("source\n")
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

for (const variant of ["ignored", "selected", "tracked despite ignore", "negative size"] as const) {
  test(`native archive selection never materializes agent links: ${variant}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-archive-ignore-"))
    const source = join(root, "source.git")
    await mkdir(source)
    try {
      await command(["git", "init", "-b", "main"], source)
      await writeFile(join(source, ".gitignore"), "cache/\n")
      await writeFile(join(source, "file.txt"), "source\n")
      await mkdir(join(source, "cache"))
      if (variant === "tracked despite ignore") {
        await writeFile(join(source, "cache/link"), "tracked source\n")
        await command(["git", "add", "-f", "cache/link"], source)
      }
      await command(["git", "add", "."], source)
      await command(["git", "commit", "-m", "source"], source)
      const sha = await command(["git", "rev-parse", "HEAD"], source)
      await writeFile(join(root, "outside"), "untouched\n")
      if (variant === "tracked despite ignore") await rm(join(source, "cache/link"))
      await symlink(
        join(root, "outside"),
        join(source, variant === "selected" ? "link" : "cache/link"),
      )
      await command([
        "tar",
        "--exclude=.git",
        "-cf",
        join(root, "workspace.tar"),
        "-C",
        source,
        ".",
      ])
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
      const exported = command(
        [
          "python3",
          "-I",
          script,
          "native-export",
          variant === "negative size" ? "malformed.tar" : "workspace.tar",
          sha,
        ],
        root,
      )
      if (variant === "ignored") {
        await exported
        expect(await Bun.file(join(root, "repository/file.txt")).text()).toBe("source\n")
        expect(await Bun.file(join(root, "repository/cache/link")).exists()).toBe(false)
      } else await expect(exported).rejects.toThrow()
      expect(await Bun.file(join(root, "outside")).text()).toBe("untouched\n")
      expect(await Bun.file(join(root, "result/result.bundle")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const variant of [
  "ordinary",
  "encoded canary",
  "metadata canary",
  "UUID filename",
  "nested UUID filename",
  "base64 filename",
  "hex filename",
  "URL filename",
  "symlink",
  "forbidden path",
] as const) {
  test(`native capture excludes agent history and validates before creating artifacts: ${variant}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-result-"))
    const repo = join(root, "repository")
    await mkdir(repo)
    const git = (...args: string[]) => command(["git", ...args], repo)
    try {
      await git("init", "-b", "main")
      await writeFile(join(repo, "base.txt"), "base\n")
      await writeFile(join(repo, ".gitignore"), "/build-cache/\n")
      await git("add", ".")
      await git("commit", "-m", "source")
      const source = await git("rev-parse", "HEAD")
      await command(["git", "clone", "--bare", repo, join(root, "source.git")])
      // Hidden history and local Git configuration must never enter the public result or execute.
      await writeFile(join(repo, "removed.txt"), secret)
      await git("add", ".")
      await git("commit", "-m", secret)
      await rm(join(repo, "removed.txt"))
      await git("config", "core.fsmonitor", `touch ${join(root, "executed")}`)
      await writeFile(
        join(repo, "result.txt"),
        variant === "encoded canary"
          ? Buffer.from(secret).toString("base64")
          : "intended public content\n",
      )
      const session = "4e203617-9ef1-413a-932b-559b68637ff1"
      const urlSecret = "fixture-sensitive/value:93b28a5d"
      const filenames: Record<string, string> = {
        "UUID filename": session,
        "nested UUID filename": `nested/${session}/result.txt`,
        "base64 filename": Buffer.from(session).toString("base64"),
        "hex filename": Buffer.from(session).toString("hex"),
        "URL filename": encodeURIComponent(urlSecret),
      }
      const filename = filenames[variant]
      if (filename) {
        await mkdir(join(repo, filename, ".."), { recursive: true })
        await writeFile(join(repo, filename), "intended public content\n")
      }
      if (variant === "ordinary") {
        await mkdir(join(repo, "build-cache"))
        await writeFile(join(repo, "build-cache/private.txt"), secret)
        await symlink("/etc/passwd", join(repo, "build-cache/generated-link"))
      }
      if (variant === "symlink") await symlink("/etc/passwd", join(repo, "link"))
      if (variant === "forbidden path") {
        await mkdir(join(repo, ".github"))
        await writeFile(join(repo, ".github", "bad.yml"), "bad")
      }
      const child = Bun.spawn(["python3", script, "native-seal", source], {
        cwd: root,
        stdin: new Blob([
          JSON.stringify({
            completion:
              variant === "metadata canary" ? { ...completion, body: secret } : completion,
            sensitiveValues: [secret, session, urlSecret],
          }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exit, output] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(await Bun.file(join(root, "executed")).exists()).toBe(false)
      if (variant !== "ordinary") {
        expect(exit).not.toBe(0)
        expect(await Bun.file(join(root, "result/result.bundle")).exists()).toBe(false)
        expect(await Bun.file(join(root, "result/result.json")).exists()).toBe(false)
        return
      }
      expect(exit).toBe(0)
      const metadata = JSON.parse(output)
      expect(metadata).toMatchObject({ ...completion, sourceSha: source })
      const result = join(root, "result")
      await command(["zip", "-q", join(root, "result.zip"), "result.bundle", "result.json"], result)
      const digest = createHash("sha256")
        .update(await Bun.file(join(root, "result.zip")).bytes())
        .digest("hex")
      const checked = Bun.spawn(["python3", script, "validate", join(root, "source.git")], {
        cwd: root,
        stdin: new Blob([
          JSON.stringify({
            source,
            result: metadata.resultSha,
            tree: metadata.treeSha,
            manifest: metadata.manifestSha256,
            digest: "sha256:" + digest,
          }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [status, manifest] = await Promise.all([
        checked.exited,
        new Response(checked.stdout).text(),
        new Response(checked.stderr).text(),
      ])
      expect(status).toBe(0)
      expect(JSON.parse(manifest).treeSha).toBe(metadata.treeSha)
      const clean = join(root, "validated/objects.git")
      expect(
        await command(["git", "rev-list", "--count", source + ".." + metadata.resultSha], clean),
      ).toBe("1")
      expect(
        await command(["git", "show", "-s", "--format=%an <%ae>", metadata.resultSha], clean),
      ).toBe("Workflowd Agent <agent@workflowd.invalid>")
      expect(
        await command(["git", "log", "--format=%B", source + ".." + metadata.resultSha], clean),
      ).not.toContain(secret)
      expect(await command(["git", "show", metadata.resultSha + ":result.txt"], clean)).toBe(
        "intended public content",
      )
      expect(
        await command(["git", "ls-tree", "-r", "--name-only", metadata.resultSha], clean),
      ).not.toContain("build-cache")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
