import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { runStoreMigrations } from "../../src/store/migrations"
import { makeSandboxStore } from "../../src/sandbox/store"
import { makePublishStore } from "../../src/sandbox/publish-store"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxPublisher } from "../../src/sandbox/publish"
import { sandboxGithubFixture, sandboxPublicationFixture } from "./harness"

const policy = {
  alias: "workflowd",
  repository: "BNasraoui/workflowd",
  repositoryId: 1306107007,
  installationId: 147573449,
  workflowSha: "a".repeat(40),
  appActorId: 306741873,
  tailscaleClientId: "fixture",
  tailscaleAudience: "fixture",
  publish: {
    baseRef: "main",
    environmentId: 9,
    publisherAppId: 5232172,
    publisherActorId: 339414993,
  },
}
const metadata = {
  sourceSha: "b".repeat(40),
  resultSha: "c".repeat(40),
  branch: "no/name/rules '$()\n雪",
  bundleSha256: "d".repeat(64),
  manifestSha256: "e".repeat(64),
}

test("completion accepts one bare or fenced object and forwards only canonical JSON", async () => {
  const fixture = await sandboxGithubFixture(policy)
  const selected = { environmentId: "arriving-leech", branch: metadata.branch }
  const json = JSON.stringify(selected)
  const fenced = (value: string, language = "json") => `\`\`\`${language}\n${value}\n\`\`\``
  const calls: string[] = []
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runStoreMigrations
        const store = yield* makeSandboxStore
        yield* store.request({
          runId: "run-1",
          leaseId: "lease-1",
          policy,
          sourceSha: metadata.sourceSha,
          now: Date.now(),
        })
        yield* store.beginStart("run-1")
        yield* store.recordRun("run-1", 41, 1)
        yield* store.bind("run-1", 41, 1, {
          leaseId: "lease-1",
          peerId: "peer-1",
          repositoryPath: "/workspace/repository",
          address: "100.64.0.1",
          port: 22,
          knownHostsFile: "/tmp/known_hosts",
          identityFile: "/dev/null",
        })
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const leases = yield* makeSandboxLeaseService(github, undefined, async (args, input) => {
          expect(args.at(-1)).toBe("exec /usr/local/bin/runner-control finish-result")
          calls.push(input)
          return JSON.stringify(metadata)
        })
        for (const completion of [json, fenced(json), fenced(json, "")]) {
          expect(yield* leases.finishResult("run-1", ` \n${completion}\n\t`)).toEqual(metadata)
          expect(calls.at(-1)).toBe(json)
        }
        const count = calls.length
        for (const completion of [
          "",
          `Done: ${json}`,
          `${json}\nDone`,
          `Done:\n${fenced(json)}`,
          `${fenced(json)}\nDone`,
          `${json}\n${json}`,
          fenced(`${json}\n${json}`),
          `${fenced(json)}\n${fenced(json)}`,
          fenced(json, "javascript"),
          `\`\`\`json\n${json}`,
          JSON.stringify({ ...selected, extra: true }),
          fenced(JSON.stringify({ ...selected, extra: true })),
          JSON.stringify({ branch: selected.branch }),
          JSON.stringify({ ...selected, environmentId: "" }),
          JSON.stringify({ ...selected, branch: 7 }),
          `[${json}]`,
          "null",
        ]) {
          const result = yield* Effect.result(leases.finishResult("run-1", completion))
          expect(result._tag).toBe("Failure")
          expect(calls).toHaveLength(count)
        }
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    )
  } finally {
    await fixture.close()
  }
})

for (const fault of [
  "none",
  "lost approval",
  "foreign artifact",
  "rerun",
  "bad job",
  "wrong environment",
  "expired",
  "wrong approval",
  "artifact replaced",
  "lost push",
  "lost PR",
  "saved receipt",
  "foreign PR",
  "unrevoked",
])
  test(`durable publication reconciliation: ${fault}`, async () => {
    const fixture = await sandboxGithubFixture(policy)
    const publication = sandboxPublicationFixture(fixture, policy, "lease-1", fault)
    if (fault === "rerun") fixture.mutateRun({ run_attempt: 2 })
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* runStoreMigrations
          const leases = yield* makeSandboxStore
          yield* leases.request({
            runId: "run-1",
            leaseId: "lease-1",
            policy,
            sourceSha: metadata.sourceSha,
            now: Date.now(),
          })
          yield* leases.beginStart("run-1")
          yield* leases.recordRun("run-1", 41, 1)
          const store = yield* makePublishStore
          yield* store.seal({
            runId: "run-1",
            actionsRunId: 41,
            attempt: 1,
            metadata,
            baseRef: "main",
            deadline: Date.now() + (fault === "expired" ? -1 : 60000),
          })
          const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
          const remote = yield* makeSandboxLeaseService(github)
          const publisher = yield* makeSandboxPublisher(github, remote)
          yield* publisher.poll("run-1").pipe(Effect.result)
          if (["none", "lost approval", "lost PR", "saved receipt"].includes(fault)) {
            // Reopening the service must read the exact approval, never POST again.
            if (fault === "saved receipt")
              yield* store.saveReceipt("run-1", { stage: "creating_pr", pr: null, revoked: true })
            const resumed = yield* makeSandboxPublisher(github, remote)
            yield* resumed.poll("run-1")
            expect(publication.posts).toBe(1)
            expect((yield* store.read("run-1"))?.phase).toBe("published")
            expect(JSON.stringify(publication.reviews)).toContain(metadata.manifestSha256)
            expect(fixture.tokenRequests).toContainEqual({
              repository_ids: [policy.repositoryId],
              permissions: { actions: "read", deployments: "write" },
            })
          } else if (["lost push", "foreign PR", "unrevoked"].includes(fault)) {
            yield* publisher.poll("run-1")
            expect((yield* store.read("run-1"))?.phase).toBe("operator_required")
            expect(publication.posts).toBe(1)
          } else if (["wrong approval", "artifact replaced"].includes(fault)) {
            const resumed = yield* makeSandboxPublisher(github, remote)
            expect((yield* Effect.result(resumed.poll("run-1")))._tag).toBe("Failure")
            expect(publication.posts).toBe(1)
            expect((yield* store.read("run-1"))?.phase).not.toBe("probed")
          } else expect(publication.posts).toBe(0)
          expect(publication.downloads).toBe(0)
          expect((yield* store.read("run-1"))?.metadata.branch).toBe(metadata.branch)
          expect((yield* Effect.result(publisher.poll("unknown")))._tag).toBe("Failure")
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
      )
    } finally {
      await fixture.close()
    }
  })

// The only external substitute is GitHub HTTP. Git itself uses its real smart-HTTP backend.
for (const fault of [
  "none",
  "collision",
  "race",
  "lost push reply",
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
      revokes = 0
    let pull: Record<string, unknown> | undefined
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
    const result = await git("rev-parse", "HEAD")
    await mkdir(join(work, "validated"), { recursive: true })
    await command(["git", "clone", "--bare", join(root, "source"), objects])
    const binding = {
      v: 2,
      run: 41,
      attempt: 1,
      artifact: 52,
      digest: "sha256:" + "f".repeat(64),
      source,
      result,
      manifest: "e".repeat(64),
      base: "main",
    }
    await writeFile(
      join(work, "validated.json"),
      JSON.stringify({
        binding,
        metadata: { sourceSha: source, resultSha: result, branch, bundleSha256: "d".repeat(64) },
      }),
    )
    // The server enforces the same create-only rule required on GitHub, including races.
    await writeFile(
      join(remote, "hooks/pre-receive"),
      '#!/bin/sh\nwhile read old new ref; do test "$old" = 0000000000000000000000000000000000000000 || exit 1; done\n',
      { mode: 0o755 },
    )
    if (fault === "collision") await git("push", remote, `HEAD:refs/heads/${branch}`)
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname.includes("/repo.git/")) {
          if (
            request.headers.get("authorization") !==
            "Basic " + Buffer.from("x-access-token:" + token).toString("base64")
          )
            return new Response(null, {
              status: 401,
              headers: { "WWW-Authenticate": 'Basic realm="fixture"' },
            })
          if (request.method === "POST") pushes++
          const child = Bun.spawn(["/usr/lib/git-core/git-http-backend"], {
            env: {
              PATH: "/usr/bin:/bin",
              GIT_PROJECT_ROOT: root,
              GIT_HTTP_EXPORT_ALL: "1",
              PATH_INFO: url.pathname,
              QUERY_STRING: url.search.slice(1),
              REQUEST_METHOD: request.method,
              CONTENT_TYPE: request.headers.get("content-type") ?? "",
              REMOTE_USER: "publisher",
            },
            stdin: new Blob([await request.arrayBuffer()]),
            stdout: "pipe",
            stderr: "pipe",
          })
          const bytes = Buffer.from(await new Response(child.stdout).arrayBuffer())
          expect(await child.exited).toBe(0)
          const split = bytes.indexOf("\r\n\r\n")
          const headers = new Headers()
          for (const line of bytes.subarray(0, split).toString().split("\r\n")) {
            const at = line.indexOf(":")
            headers.set(line.slice(0, at), line.slice(at + 1).trim())
          }
          if (fault === "lost push reply" && request.method === "POST")
            return new Response(null, { status: 502 })
          return new Response(bytes.subarray(split + 4), { headers })
        }
        expect(request.headers.get("authorization")).toBe("Bearer " + token)
        if (url.pathname === "/installation/token") {
          revokes++
          return new Response(null, { status: 204 })
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
            base: "main",
            draft: true,
            maintainer_can_modify: false,
          })
          if (fault === "PR failure") return new Response(null, { status: 422 })
          pull = {
            ...body,
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
              sha: fault === "wrong head" ? source : result,
              repo: { full_name: "fixture/repo", id: 7 },
            },
            base: { ref: "main", repo: { full_name: "fixture/repo", id: 7 } },
          }
          return fault === "lost PR reply"
            ? new Response(null, { status: 502 })
            : Response.json(pull, { status: 201 })
        }
        if (url.pathname.endsWith("/pulls/17")) return Response.json(pull)
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
      expect(published.code).toBe(fault === "none" || fault === "lost PR reply" ? 0 : 1)
      expect((await invoke("revoke")).code).toBe(0)
      expect(revokes).toBe(1)
      const receipt = JSON.parse(await Bun.file(join(work, "receipt.json")).text())
      expect(receipt).toMatchObject({ binding, repository: "fixture/repo", branch, revoked: true })
      if (fault === "none" || fault === "lost PR reply")
        expect(receipt).toMatchObject({ stage: "published", pr: 17 })
      if (fault === "lost push reply") expect(receipt.stage).toBe("pushing")
      expect(posts).toBe(["collision", "race", "lost push reply"].includes(fault) ? 0 : 1)
      expect(pushes).toBe(fault === "collision" ? 0 : 1)
      const remoteSha = await command(["git", "-C", remote, "rev-parse", `refs/heads/${branch}`])
      expect(remoteSha).toBe(fault === "race" ? source : result)
      expect(await Bun.file(join(root, "touch-pwned")).exists()).toBe(false)
    } finally {
      await server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
}

test("live publication verifier binds submission, approved job, revoked receipt and PR diff endpoints", async () => {
  const { command } = await import("./harness")
  await command([
    process.execPath,
    "--eval",
    `
    import assert from "node:assert/strict"
    import { assertLivePublication, proofTask } from "./scripts/evidence/agent-sandbox.mjs"
    import { approvalComment } from "./src/sandbox/publish.ts"
    const policy = ${JSON.stringify(policy)}
    const metadata = ${JSON.stringify(metadata)}
    const intent = {run_id:"run",actions_run_id:41,attempt:1,metadata,base_ref:"main",phase:"published",artifact_id:52,artifact_digest:"sha256:"+"f".repeat(64),receipt:{stage:"published",pr:17,revoked:true}}
    const binding = JSON.parse(approvalComment(intent))
    const marker = "<!-- workflowd-publication:"+Buffer.from(JSON.stringify(binding)).toString("base64")+" -->"
    const repo = {id:policy.repositoryId,full_name:policy.repository}
    const job = {id:42,name:"agent-publish",run_id:41,run_attempt:1,head_sha:policy.workflowSha,status:"completed",conclusion:"success"}
    const receipt = {...intent.receipt,binding,repository:policy.repository,branch:metadata.branch,marker}
    const valid = {
      policy,intent,sourceSha:metadata.sourceSha,
      submission:{environmentId:"selected",branch:metadata.branch},
      calls:[{name:"bridge.submit_result",owned:true,completed:true,input:{environmentId:"selected",branch:metadata.branch}}],
      actions:{id:41,run_attempt:1,head_sha:policy.workflowSha,status:"completed",conclusion:"success"},
      jobs:[job],
      reviews:[{state:"approved",comment:approvalComment(intent),user:{id:policy.appActorId,type:"Bot"},environments:[{id:9,name:"agent-publish"}]}],
      publisherLog:"2026-10-11T00:00:00Z workflowd.publish.receipt "+Buffer.from(JSON.stringify(receipt)).toString("base64"),
      ref:{ref:"refs/heads/"+metadata.branch,object:{sha:metadata.resultSha}},
      pull:{number:17,html_url:"https://github.com/"+policy.repository+"/pull/17",state:"open",draft:true,maintainer_can_modify:false,body:marker,user:{login:"ghettimonster[bot]",id:339414993,type:"Bot"},head:{ref:metadata.branch,sha:metadata.resultSha,repo},base:{ref:"main",sha:metadata.sourceSha,repo}},
    }
    assertLivePublication(valid)
    for(const mutate of [
      x=>x.intent.phase="probed", x=>x.calls=[], x=>x.submission.branch="different",
      x=>x.intent.receipt.revoked=false, x=>x.publisherLog="",
      x=>x.pull.draft=false, x=>x.pull.state="closed", x=>x.pull.user.id=1,
      x=>x.pull.user.login="foreign[bot]", x=>x.pull.head.sha=metadata.sourceSha,
      x=>x.pull.base.sha=metadata.resultSha, x=>x.pull.base.ref="different",
      x=>x.pull.head.repo.id=1, x=>x.ref.object.sha=metadata.sourceSha,
      x=>x.reviews[0].comment="foreign", x=>x.reviews[0].user.id=1,
      x=>x.jobs[0].conclusion="failure", x=>x.jobs[0].run_attempt=2,
    ]) {const changed=structuredClone(valid); mutate(changed); assert.throws(()=>assertLivePublication(changed))}
    const task = proofTask(policy.repository)
    assert.equal(typeof task.prompt,"string")
    assert.equal(typeof task.testCommand,"string")
    assert.equal(Object.hasOwn(task,"branch"),false)
    assert.throws(()=>proofTask("unknown/repository"))
    `,
  ])
})
