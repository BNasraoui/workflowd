import { expect, test } from "bun:test"
import { Schema } from "effect"
import { publicationBody, publicationCommitMessage } from "../../src/sandbox/config"

const coAuthor = "Ben Nasraoui <81005232+BNasraoui@users.noreply.github.com>"

// Only GitHub HTTP is substituted; fixture API writes real Git objects and create-only refs.
for (const fault of [
  "none",
  "closing references",
  "closing references recovered",
  "closing delayed references",
  "closing delayed query failed",
  "closing query failed",
  "closing query malformed",
  "closing close failed",
  "maximum metadata",
  "existing co-authors",
  "duplicate co-author",
  "invalid co-author",
  "format title",
  "bidi message",
  "fenced mention",
  "collision",
  "race",
  "lost ref reply",
  "wrong tree",
  "wrong parent",
  "wrong message",
  "missing co-author",
  "wrong title",
  "wrong body",
  "binding mismatch",
  "body binding mismatch",
  "unsafe body",
  "lost PR reply",
  "wrong author",
  "wrong head",
  "PR failure",
]) {
  test(`real publisher create-only Git/HTTP receipt: ${fault}`, async () => {
    const { mkdtemp, mkdir, writeFile, copyFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join, resolve } = await import("node:path")
    const { command } = await import("./harness")
    const root = await mkdtemp(join(tmpdir(), "publisher-http-"))
    const node = Bun.which("node")
    if (node === null) throw new Error("Publisher fixture requires Node on PATH")
    const runtime = join(root, "trusted node's runtime")
    await copyFile(node, runtime)
    const remote = join(root, "fixture/repo.git")
    const work = join(root, "workflowd-publish")
    const objects = join(work, "validated/objects.git")
    const branch = "chosen/雪'$(touch-pwned);&"
    const token = "fixture-publisher-token-never-logged"
    let pushes = 0,
      posts = 0,
      revokes = 0,
      closingQueries = 0
    let pull: Record<string, unknown> | undefined
    let publishedSha = ""
    const title =
      fault === "maximum metadata"
        ? "雪".repeat(200)
        : fault === "format title"
          ? "hidden\u200btitle"
          : "Agent title 雪"
    const trailer = `Co-authored-by: ${coAuthor}`
    const body =
      fault === "maximum metadata"
        ? "m".repeat(10239)
        : fault === "bidi message"
          ? "bidi\u202emessage"
          : fault === "fenced mention"
            ? "Agent message\n\n```ts\nimport X from '@effect/sql'\n```"
            : "Agent message\n\n雪 prose\n\n```ts\nconst value = 1\n```"
    const other =
      "Co-authored-by: Another Person <another@example.invalid>\n co-AUTHORED-by : Forged <forged@example.invalid>"
    const commitMessage =
      fault === "existing co-authors"
        ? `${body}\n\n\`\`\`text\n${other}\n\`\`\`\n`
        : fault === "duplicate co-author"
          ? `${body}\n\n\`\`\`text\n${trailer}\n${trailer}\n${other}\n\`\`\`\n`
          : `${body}\n`
    const expectedMessage = publicationCommitMessage(commitMessage, coAuthor)
    await mkdir(join(root, "fixture"), { recursive: true })
    await command(["git", "init", "--bare", remote])
    await command(["git", "-C", remote, "config", "http.receivepack", "true"])
    await mkdir(join(root, "source"))
    const git = (...args: string[]) => command(["git", ...args], join(root, "source"))
    await git("init", "-b", "main")
    await git("config", "user.name", "Fixture")
    await git("config", "user.email", "fixture@example.invalid")
    await writeFile(join(root, "source/base"), "base")
    await git("add", ".")
    await git("commit", "-m", "base")
    const source = await git("rev-parse", "HEAD")
    await git("push", remote, "HEAD:refs/heads/main")
    await writeFile(join(root, "source/result"), "exact validated bytes")
    await git("add", ".")
    await git("commit", "-m", "result")
    await writeFile(join(root, "source/binary"), Buffer.from([0, 255, 1, 128]))
    await git("rm", "base")
    await git("add", ".")
    await git("commit", "-m", "second result")
    const treeSha = await git("rev-parse", "HEAD^{tree}")
    const result = await git("rev-parse", "HEAD")
    await mkdir(join(work, "validated"), { recursive: true })
    await command(["git", "clone", "--bare", join(root, "source"), objects])
    const manifest = {
      sourceSha: source,
      resultSha: result,
      treeSha,
      title,
      commitMessage,
      body:
        fault === "unsafe body"
          ? "<!-- hidden -->"
          : fault === "maximum metadata"
            ? "é".repeat(16384)
            : "## Result\n\nReadable agent description.",
      branch,
      bundleSha256: "d".repeat(64),
    }
    const rawManifest = JSON.stringify(manifest)
    const { createHash } = await import("node:crypto")
    const binding = {
      v: 4,
      tree: treeSha,
      run: 41,
      attempt: 1,
      artifact: 52,
      digest: "sha256:" + "f".repeat(64),
      source,
      result,
      manifest: createHash("sha256").update(rawManifest).digest("hex"),
      base: "main",
    }
    await writeFile(
      join(work, "validated/result.json"),
      fault === "binding mismatch"
        ? JSON.stringify({ ...manifest, title: "changed" })
        : fault === "body binding mismatch"
          ? JSON.stringify({ ...manifest, body: "Changed" })
          : rawManifest,
    )
    await writeFile(
      join(work, "validated.json"),
      JSON.stringify({
        binding,
        metadata: {
          sourceSha: source,
          resultSha: result,
          treeSha,
          title: fault === "binding mismatch" ? "changed" : title,
          commitMessage,
          body: "## Result\n\nReadable agent description.",
          branch,
          bundleSha256: "d".repeat(64),
        },
      }),
    )
    // The server enforces the same create-only rule required on GitHub, including races.
    await writeFile(
      join(remote, "hooks/pre-receive"),
      '#!/bin/sh\nwhile read old new ref; do test "$old" = 0000000000000000000000000000000000000000 || exit 1; done\n',
      { mode: 0o755 },
    )
    if (fault === "collision") await git("push", remote, `HEAD:refs/heads/${branch}`)
    const objectGit = async (args: string[], input = new Uint8Array()) => {
      const child = Bun.spawn(["git", "-C", remote, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "ghettimonster[bot]",
          GIT_AUTHOR_EMAIL: "339414993+ghettimonster[bot]@users.noreply.github.com",
          GIT_COMMITTER_NAME: "ghettimonster[bot]",
          GIT_COMMITTER_EMAIL: "339414993+ghettimonster[bot]@users.noreply.github.com",
        },
        stdin: new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(err)
      return out.trim()
    }
    const commitObject = async (readback = false) => ({
      sha: publishedSha,
      tree: { sha: fault === "wrong tree" ? source : treeSha },
      parents: [{ sha: readback && fault === "wrong parent" ? result : source }],
      message:
        fault === "wrong message"
          ? "changed"
          : readback && fault === "missing co-author"
            ? commitMessage
            : expectedMessage,
      verification: { verified: true },
    })
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        expect(request.headers.get("authorization")).toBe("Bearer " + token)
        if (url.pathname === "/graphql") {
          closingQueries++
          if (fault === "closing delayed query failed" && closingQueries === 2)
            return new Response(null, { status: 502 })
          const query = Schema.decodeUnknownSync(
            Schema.Struct({ query: Schema.String, variables: Schema.Json }),
          )(await request.json())
          expect(query.query).toContain("closingIssuesReferences")
          expect(query.variables).toEqual({ owner: "fixture", name: "repo", number: 17 })
          if (fault === "closing query failed") return new Response(null, { status: 502 })
          if (fault === "closing query malformed")
            return Response.json({ errors: [{ message: "unavailable" }] })
          return Response.json({
            data: {
              repository: {
                pullRequest: {
                  closingIssuesReferences: {
                    totalCount:
                      fault.startsWith("closing references") ||
                      fault === "closing close failed" ||
                      (fault === "closing delayed references" && closingQueries === 2)
                        ? 1
                        : 0,
                  },
                },
              },
            },
          })
        }
        if (url.pathname === "/installation/token") {
          revokes++
          return new Response(null, { status: 204 })
        }
        if (url.pathname.endsWith("/git/blobs")) {
          const body = Schema.decodeUnknownSync(
            Schema.Struct({ content: Schema.String, encoding: Schema.Literal("base64") }),
          )(await request.json())
          return Response.json(
            {
              sha: await objectGit(
                ["hash-object", "-w", "--stdin"],
                Buffer.from(body.content, "base64"),
              ),
            },
            { status: 201 },
          )
        }
        if (url.pathname.endsWith("/git/trees")) {
          const body = Schema.decodeUnknownSync(
            Schema.Struct({
              base_tree: Schema.String,
              tree: Schema.Array(
                Schema.Struct({
                  path: Schema.String,
                  mode: Schema.String,
                  type: Schema.Literal("blob"),
                  sha: Schema.NullOr(Schema.String),
                }),
              ),
            }),
          )(await request.json())
          await objectGit(["read-tree", body.base_tree])
          for (const entry of body.tree)
            await objectGit(
              ["update-index", "--index-info"],
              Buffer.from(
                `${entry.sha === null ? "0" : entry.mode} ${entry.sha ?? "0".repeat(40)}\t${entry.path}\n`,
              ),
            )
          return Response.json({ sha: await objectGit(["write-tree"]) }, { status: 201 })
        }
        if (url.pathname.endsWith("/git/commits") && request.method === "POST") {
          const body = Schema.decodeUnknownSync(
            Schema.Struct({
              tree: Schema.String,
              parents: Schema.Array(Schema.String),
              message: Schema.String,
            }),
          )(await request.json(), { onExcessProperty: "error" })
          expect(body).toEqual({ tree: treeSha, parents: [source], message: expectedMessage })
          publishedSha = await objectGit(
            ["commit-tree", body.tree, "-p", source],
            Buffer.from(body.message),
          )
          return Response.json(await commitObject(), { status: 201 })
        }
        if (url.pathname.includes("/git/commits/")) return Response.json(await commitObject(true))
        if (url.pathname.endsWith("/git/refs")) {
          pushes++
          const body = Schema.decodeUnknownSync(
            Schema.Struct({ ref: Schema.String, sha: Schema.String }),
          )(await request.json())
          expect(body).toEqual({ ref: `refs/heads/${branch}`, sha: publishedSha })
          try {
            await objectGit(["update-ref", body.ref, body.sha, "0".repeat(40)])
          } catch {
            return Response.json({ message: `Authorization: Bearer ${token}` }, { status: 422 })
          }
          return fault === "lost ref reply"
            ? new Response(null, { status: 502 })
            : Response.json({ ref: body.ref, object: { sha: body.sha } }, { status: 201 })
        }
        if (url.pathname.includes("/git/ref/heads/")) {
          expect(decodeURIComponent(url.pathname.split("/git/ref/heads/")[1]!)).toBe(branch)
          const sha = await command([
            "git",
            "-C",
            remote,
            "rev-parse",
            "--verify",
            `refs/heads/${branch}`,
          ]).catch(() => null)
          if (fault === "race" && sha === null)
            await git("push", remote, `${source}:refs/heads/${branch}`)
          return sha === null
            ? new Response(null, { status: 404 })
            : Response.json({ ref: `refs/heads/${branch}`, object: { sha } })
        }
        if (url.pathname.endsWith("/pulls") && request.method === "POST") {
          posts++
          const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
            await request.json(),
          )
          expect(body).toMatchObject({
            head: branch,
            title,
            body: publicationBody(
              `<!-- workflowd-publication:${Buffer.from(JSON.stringify(binding)).toString("base64")} -->`,
              manifest.body,
            ),
            base: "main",
            draft: true,
            maintainer_can_modify: false,
          })
          if (fault === "PR failure")
            return Response.json({ message: `Authorization: Bearer ${token}` }, { status: 422 })
          pull = {
            ...body,
            body: fault === "wrong body" ? "Changed" : body.body,
            title: fault === "wrong title" ? "changed" : title,
            number: 17,
            html_url: "https://github.com/fixture/repo/pull/17",
            state: "open",
            user: {
              login: fault === "wrong author" ? "foreign[bot]" : "ghettimonster[bot]",
              id: 339414993,
              type: "Bot",
            },
            head: {
              ref: branch,
              sha: fault === "wrong head" ? source : publishedSha,
              repo: { full_name: "fixture/repo", id: 7 },
            },
            base: { ref: "main", repo: { full_name: "fixture/repo", id: 7 } },
          }
          return ["lost PR reply", "closing references recovered"].includes(fault)
            ? new Response(null, { status: 502 })
            : Response.json(pull, { status: 201 })
        }
        if (url.pathname.endsWith("/pulls/17")) {
          if (request.method === "PATCH") {
            expect(await request.json()).toEqual({ state: "closed" })
            if (fault === "closing close failed") return new Response(null, { status: 502 })
            pull!.state = "closed"
          }
          return Response.json(pull)
        }
        if (url.pathname.endsWith("/pulls"))
          return Response.json(pull ? [{ number: pull.number }] : [])
        return new Response(null, { status: 404 })
      },
    })
    const invoke = async (operation: string) => {
      const child = Bun.spawn([runtime, resolve("deploy/sandbox/publish.mjs"), operation], {
        cwd: root,
        env: {
          PATH: "/usr/bin:/bin",
          RUNNER_TEMP: root,
          GITHUB_API_URL: server.url.toString().replace(/\/$/, ""),
          GITHUB_SERVER_URL: server.url.toString().replace(/\/$/, ""),
          GITHUB_REPOSITORY: "fixture/repo",
          GITHUB_REPOSITORY_ID: "7",
          GITHUB_RUN_ID: "41",
          GITHUB_RUN_ATTEMPT: "1",
          PUBLISH_TOKEN: token,
          PUBLISH_CO_AUTHOR: fault === "invalid co-author" ? "Injected\nName <x@y>" : coAuthor,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(out + err).not.toContain(token)
      return { code, out, err }
    }
    try {
      const published = await invoke("publish")
      expect(published.code).toBe(
        ["none", "maximum metadata", "lost PR reply"].includes(fault) ? 0 : 1,
      )
      expect((await invoke("revoke")).code).toBe(0)
      expect(revokes).toBe(1)
      if (
        [
          "binding mismatch",
          "body binding mismatch",
          "unsafe body",
          "invalid co-author",
          "format title",
          "bidi message",
          "fenced mention",
          "existing co-authors",
          "duplicate co-author",
        ].includes(fault)
      ) {
        expect(published.err).toContain("manifest validation failed")
        expect(published.out).toContain("workflowd.publish.failure ")
        expect(pushes).toBe(0)
        expect(posts).toBe(0)
        expect(await Bun.file(join(work, "receipt.json")).exists()).toBe(false)
        return
      }
      if (fault.startsWith("closing")) {
        expect(pull?.state).toBe(fault === "closing close failed" ? "open" : "closed")
        expect(published.err).toContain("closing issue references")
        expect(published.out).toContain("workflowd.publish.failure ")
      }
      const receipt = JSON.parse(await Bun.file(join(work, "receipt.json")).text())
      expect(receipt).toMatchObject({ binding, repository: "fixture/repo", branch, revoked: true })
      if (fault.startsWith("closing")) {
        expect(receipt.closingIssuesVerified).toBe(false)
        expect(receipt.cause).toContain("closing issue references")
        expect(receipt.stage).toBe("creating_pr")
      }
      const expectedCause =
        fault === "collision"
          ? "branch already exists (HTTP 200)"
          : fault === "race"
            ? "branch creation failed (HTTP 422)"
            : fault === "PR failure"
              ? "PR creation failed (HTTP 422)"
              : undefined
      if (expectedCause !== undefined) {
        expect(receipt.cause).toBe(expectedCause)
        expect(published.err).toContain(expectedCause)
      }
      if (fault === "wrong tree") expect(receipt.cause).toBe("commit validation failed")
      if (["none", "maximum metadata", "lost PR reply"].includes(fault)) {
        expect(closingQueries).toBe(3)
        expect(receipt).toMatchObject({
          stage: "published",
          pr: 17,
          commitSha: publishedSha,
          closingIssuesVerified: true,
        })
        expect(publishedSha).not.toBe(result)
        expect(await objectGit(["rev-parse", publishedSha + "^{tree}"])).toBe(treeSha)
        expect(await objectGit(["rev-list", "--parents", "-n", "1", publishedSha])).toBe(
          `${publishedSha} ${source}`,
        )
        expect(await objectGit(["log", "-1", "--format=%B", publishedSha])).toBe(expectedMessage)
      }
      if (fault === "lost ref reply") expect(receipt.stage).toBe("pushing")
      const beforeRef = ["collision", "wrong tree", "wrong message"].includes(fault)
      expect(posts).toBe(beforeRef || ["race", "lost ref reply"].includes(fault) ? 0 : 1)
      expect(pushes).toBe(beforeRef ? 0 : 1)
      if (!["wrong tree", "wrong message"].includes(fault)) {
        const remoteSha = await objectGit(["rev-parse", `refs/heads/${branch}`])
        expect(remoteSha).toBe(
          fault === "race" ? source : fault === "collision" ? result : publishedSha,
        )
      }
      expect(await Bun.file(join(root, "touch-pwned")).exists()).toBe(false)
    } finally {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
}
