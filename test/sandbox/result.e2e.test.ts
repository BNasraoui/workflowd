import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { command } from "./harness"

const script = resolve("deploy/sandbox/result.py")
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

test("sealing keeps the agent name opaque and sends only digests and commit identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-result-"))
  const repo = join(root, "repo")
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
    const resultSha = await command(["git", "rev-parse", "HEAD"], repo)
    await command(["git", "update-ref", "refs/remotes/container-use/one", resultSha], repo)
    await command(["git", "checkout", "--detach", sourceSha], repo)
    const branch = "a name with ' quotes/$()\n雪"
    const seal = () => {
      const child = Bun.spawn(["python3", script, "seal", repo, output, sourceSha], {
        stdin: new Blob([JSON.stringify({ branch })]),
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
      sourceSha,
      resultSha,
      branch,
      bundleSha256: digest(bundle),
      manifestSha256: digest(manifest),
    })
    expect(text).not.toContain("runner-only-result")
    expect(JSON.parse(new TextDecoder().decode(manifest))).toEqual({
      sourceSha,
      resultSha,
      branch,
      bundleSha256: digest(bundle),
    })
    expect((await seal())[1]).toBe(text)
    await command(["git", "update-ref", "refs/remotes/container-use/two", resultSha], repo)
    expect((await seal())[0]).not.toBe(0)
    await command(["git", "update-ref", "-d", "refs/remotes/container-use/two"], repo)
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
  "hidden history",
  "symlink",
  "mode",
  "extra head",
  "archive traversal",
  "swapped archive",
])
  test(`publisher validates actual Git objects and bounded ZIP: ${mutation}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-bundle-"))
    const repo = join(root, "repo")
    const output = join(root, "result")
    await mkdir(repo)
    const git = (...args: string[]) => command(["git", ...args], repo)
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
      await writeFile(join(repo, "result"), "accepted bytes\n")
      if (mutation === "symlink") await command(["ln", "-s", "base", "link"], repo)
      await git("add", "-A")
      if (mutation === "mode") await git("update-index", "--chmod=+x", "base")
      await git("commit", "-m", "result")
      const resultSha = await git("rev-parse", "HEAD")
      await git("update-ref", "refs/remotes/container-use/one", resultSha)
      const child = Bun.spawn(["python3", script, "seal", repo, output, sourceSha], {
        stdin: new Blob([JSON.stringify({ branch: "chosen/by/agent" })]),
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
      const archive = join(root, "artifact.zip")
      await command(["zip", "-q", archive, "result.bundle", "result.json"], output)
      if (mutation === "archive traversal")
        await command([
          "python3",
          "-c",
          "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'a'); z.writestr('../bad','bad'); z.close()",
          archive,
        ])
      const binding = {
        source: sourceSha,
        result: resultSha,
        manifest: metadata.manifestSha256,
        digest: "sha256:" + digest(new Uint8Array(await Bun.file(archive).arrayBuffer())),
      }
      if (mutation === "swapped archive") binding.digest = "sha256:" + "0".repeat(64)
      const validated = Bun.spawn(
        ["python3", script, "validate", archive, repo, join(root, "validated")],
        { stdin: new Blob([JSON.stringify(binding)]), stdout: "pipe", stderr: "pipe" },
      )
      const [status, stdout] = await Promise.all([
        validated.exited,
        new Response(validated.stdout).text(),
        new Response(validated.stderr).text(),
      ])
      if (mutation === "ordinary") {
        expect(status).toBe(0)
        expect(JSON.parse(stdout).resultSha).toBe(resultSha)
        // Exercise the exact hosted entrypoint; only GitHub is an HTTP fixture.
        await mkdir(join(root, "fixture"))
        await symlink(repo, join(root, "fixture", "repo.git"))
        const approved = { v: 1, run: 41, attempt: 1, artifact: 52, ...binding }
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
          PATH: process.env.PATH,
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
        const invoke = async (mode: string, secret = "") => {
          const process = Bun.spawn(["node", resolve("deploy/sandbox/publish.mjs"), mode], {
            env: { ...env, PUBLISH_PROBE_CANARY: secret, GHETTIMONSTER_APP_ID: "5232172" },
            stdout: "pipe",
            stderr: "pipe",
          })
          return Promise.all([
            process.exited,
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
          ])
        }
        try {
          expect((await invoke("validate"))[0]).toBe(0)
          expect((await invoke("canary"))[0]).toBe(1)
          const receipt = await invoke("canary", "canary-value-never-logged")
          expect(receipt[0]).toBe(0)
          expect(receipt[1]).toContain("no write token minted")
          expect(receipt.join()).not.toContain("canary-value-never-logged")
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
      } else expect(status).not.toBe(0)
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
        stdin: new Blob([JSON.stringify({ branch: "free choice/$() 雪" })]),
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
