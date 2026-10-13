import { expect, test } from "bun:test"
import { Effect, Logger } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { runStoreMigrations } from "../../src/store/migrations"
import { makeSandboxStore } from "../../src/sandbox/store"
import { makePublishStore } from "../../src/sandbox/publish-store"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeSandboxGithub } from "../../src/sandbox/github"
import {
  parseSandboxRepositories,
  publicationBody,
  publicationCommitMessage,
} from "../../src/sandbox/config"
import { makeSandboxPublisher } from "../../src/sandbox/publish"
import { sandboxGithubFixture, sandboxPublicationFixture } from "./harness"

const policy = {
  alias: "workflowd",
  repository: "BNasraoui/workflowd",
  repositoryId: 1306107007,
  installationId: 147573449,
  workflowSha: "a".repeat(40),
  appActorId: 306741873,
  agentImage: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "f".repeat(64),
  tailscaleClientId: "fixture",
  tailscaleAudience: "fixture",
  publish: {
    baseRef: "main",
    environmentId: 9,
    publisherAppId: 5232172,
    publisherActorId: 339414993,
    coAuthor: "Ben Nasraoui <81005232+BNasraoui@users.noreply.github.com>",
  },
}
const metadata = {
  sourceSha: "b".repeat(40),
  resultSha: "c".repeat(40),
  treeSha: "1".repeat(40),
  title: "Agent title",
  commitMessage: "Agent message\n\nDetails",
  body: "## Result\n\nReadable agent description.",
  branch: "no/name/rules '$()\n雪",
  bundleSha256: "d".repeat(64),
  manifestSha256: "e".repeat(64),
}

test("publication policy requires one operator-set co-author identity", () => {
  expect(parseSandboxRepositories(JSON.stringify([policy]))).toEqual([policy])
  for (const coAuthor of [
    undefined,
    "",
    " <x@y>",
    "Name <bad>",
    "Name <x@y>\n",
    "Name\rInjected <x@y>",
    "Name\u2028Injected <x@y>",
    "Name <x@y>\nOther <z@y>",
  ]) {
    expect(() =>
      parseSandboxRepositories(
        JSON.stringify([{ ...policy, publish: { ...policy.publish, coAuthor } }]),
      ),
    ).toThrow()
  }
})

test("controller recovery expects exact Markdown and only the configured co-author", () => {
  const message =
    "Details\n`````\n@someone Closes #1\n<!-- hidden -->\nCo-authored-by: Other <other@example.invalid>\n co-AUTHORED-by : Forged <forged@example.invalid>\n"
  expect(publicationBody("marker", metadata.body)).toBe(`marker\n\n${metadata.body}`)
  expect(publicationCommitMessage(message, policy.publish.coAuthor)).toBe(
    "Details\n`````\n@someone Closes #1\n<!-- hidden -->\n\nCo-authored-by: " +
      policy.publish.coAuthor,
  )
})

test("completion accepts one bare or fenced object and forwards only canonical JSON", async () => {
  const fixture = await sandboxGithubFixture(policy)
  const selected = {
    environmentId: "arriving-leech",
    branch: metadata.branch,
    title: metadata.title,
    commitMessage: metadata.commitMessage,
    body: "## Result\n\nReadable agent description.",
  }
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
          JSON.stringify({ ...selected, title: undefined }),
          JSON.stringify({ ...selected, commitMessage: undefined }),
          JSON.stringify({ ...selected, title: "bad\nline" }),
          JSON.stringify({ ...selected, commitMessage: "bad\tcontrol" }),
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
  "rejected approval",
  "oversized binding",
  "foreign artifact",
  "rerun",
  "bad job",
  "wrong environment",
  "expired",
  "wrong approval",
  "artifact replaced",
  "closing references",
  "closing query malformed",
  "unchecked PR",
  "killed publisher",
  "lost push",
  "lost PR",
  "saved receipt",
  "foreign PR",
  "unrevoked",
  "wrong title",
  "wrong body",
  "wrong tree",
  "wrong parent",
  "wrong message",
  "missing co-author",
])
  test(`durable publication reconciliation: ${fault}`, async () => {
    const configured = {
      ...policy,
      publish: {
        ...policy.publish,
        baseRef: fault === "oversized binding" ? "b".repeat(900) : "main",
      },
    }
    const fixture = await sandboxGithubFixture(configured)
    const publication = sandboxPublicationFixture(fixture, configured, "lease-1", fault)
    if (fault === "rerun") fixture.mutateRun({ run_attempt: 2 })
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* runStoreMigrations
          const leases = yield* makeSandboxStore
          yield* leases.request({
            runId: "run-1",
            leaseId: "lease-1",
            policy: configured,
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
            baseRef: configured.publish.baseRef,
            deadline: Date.now() + (fault === "expired" ? -1 : 60000),
          })
          const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
          const remote = yield* makeSandboxLeaseService(github)
          const publisher = yield* makeSandboxPublisher(github, remote)
          const first = yield* publisher.poll("run-1").pipe(Effect.result)
          if (fault === "oversized binding") {
            expect(first._tag).toBe("Failure")
            expect(JSON.stringify(first)).toContain("Approval binding exceeds 900 bytes")
            expect((yield* store.read("run-1"))?.phase).toBe("operator_required")
            expect(yield* publisher.poll("run-1")).toBe("operator_required")
            expect(publication.posts).toBe(0)
            return
          }
          if (fault === "rejected approval") {
            expect(first._tag).toBe("Failure")
            expect(JSON.stringify(first)).toContain('"httpStatus":422')
            expect((yield* store.read("run-1"))?.phase).toBe("operator_required")
            const resumed = yield* makeSandboxPublisher(github, remote)
            expect(yield* resumed.poll("run-1")).toBe("operator_required")
            expect(publication.posts).toBe(1)
            expect(publication.reviews).toEqual([])
            yield* remote.release("run-1")
            expect(fixture.cancellations).toContain(41)
            return
          }
          if (fault === "killed publisher") {
            const errors: unknown[] = []
            expect(
              yield* publisher
                .poll("run-1")
                .pipe(
                  Effect.provide(
                    Logger.layer([Logger.make(({ message }) => errors.push(message))]),
                  ),
                ),
            ).toBe("operator_required")
            expect(errors).toEqual([])
            expect((yield* store.read("run-1"))?.phase).toBe("operator_required")
          } else if (["none", "lost approval", "lost PR", "saved receipt"].includes(fault)) {
            // Reopening the service must read the exact approval, never POST again.
            if (fault === "saved receipt")
              yield* store.saveReceipt("run-1", {
                stage: "creating_pr",
                closingIssuesVerified: true,
                pr: null,
                revoked: true,
                commitSha: "2".repeat(40),
              })
            const resumed = yield* makeSandboxPublisher(github, remote)
            yield* resumed.poll("run-1")
            expect(publication.posts).toBe(1)
            expect((yield* store.read("run-1"))?.phase).toBe("published")
            expect(JSON.stringify(publication.reviews)).toContain(metadata.manifestSha256)
            expect(fixture.tokenRequests).toContainEqual({
              repository_ids: [policy.repositoryId],
              permissions: { actions: "read", deployments: "write" },
            })
          } else if (
            [
              "closing references",
              "closing query malformed",
              "unchecked PR",
              "lost push",
              "foreign PR",
              "unrevoked",
              "wrong title",
              "wrong body",
              "wrong tree",
              "wrong parent",
              "wrong message",
              "missing co-author",
            ].includes(fault)
          ) {
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
    const intent = {run_id:"run",actions_run_id:41,attempt:1,metadata,base_ref:"main",phase:"published",artifact_id:52,artifact_digest:"sha256:"+"f".repeat(64),receipt:{stage:"published",pr:17,revoked:true,closingIssuesVerified:true,commitSha:"2".repeat(40)}}
    const binding = JSON.parse(approvalComment(intent))
    const marker = "<!-- workflowd-publication:"+Buffer.from(JSON.stringify(binding)).toString("base64")+" -->"
    const repo = {id:policy.repositoryId,full_name:policy.repository}
    const job = {id:42,name:"agent-publish",run_id:41,run_attempt:1,head_sha:policy.workflowSha,status:"completed",conclusion:"success"}
    const receipt = {...intent.receipt,binding,repository:policy.repository,branch:metadata.branch,marker}
    const valid = {
      policy,intent,sourceSha:metadata.sourceSha,
      commit:{sha:"2".repeat(40),tree:{sha:metadata.treeSha},parents:[{sha:metadata.sourceSha}],message:metadata.commitMessage+"\\n\\nCo-authored-by: "+policy.publish.coAuthor,verification:{verified:true}},
      submission:{environmentId:"selected",branch:metadata.branch,title:metadata.title,commitMessage:metadata.commitMessage,body:metadata.body},
      calls:[{name:"bridge.submit_result",owned:true,completed:true,input:{environmentId:"selected",branch:metadata.branch,title:metadata.title,commitMessage:metadata.commitMessage,body:metadata.body}}],
      actions:{id:41,run_attempt:1,head_sha:policy.workflowSha,status:"completed",conclusion:"success"},
      jobs:[job],
      reviews:[{state:"approved",comment:approvalComment(intent),user:{id:policy.appActorId,type:"Bot"},environments:[{id:9,name:"agent-publish"}]}],
      publisherLog:"2026-10-11T00:00:00Z workflowd.publish.receipt "+Buffer.from(JSON.stringify(receipt)).toString("base64"),
      ref:{ref:"refs/heads/"+metadata.branch,object:{sha:"2".repeat(40)}},
      pull:{number:17,html_url:"https://github.com/"+policy.repository+"/pull/17",state:"open",draft:true,maintainer_can_modify:false,title:metadata.title,body:marker+"\\n\\n"+metadata.body,user:{login:"ghettimonster[bot]",id:339414993,type:"Bot"},head:{ref:metadata.branch,sha:"2".repeat(40),repo},base:{ref:"main",sha:metadata.sourceSha,repo}},
    }
    assertLivePublication(valid)
    for(const mutate of [
      x=>x.pull.title="changed", x=>x.pull.body+="changed", x=>x.submission.body="changed", x=>x.calls[0].input.body="changed", x=>x.commit.tree.sha=metadata.sourceSha, x=>x.commit.parents.push({sha:metadata.resultSha}), x=>x.commit.message="changed", x=>x.commit.message=metadata.commitMessage,
      x=>x.intent.phase="probed", x=>x.calls=[], x=>x.submission.branch="different",
      x=>x.intent.receipt.closingIssuesVerified=false, x=>x.intent.receipt.revoked=false, x=>x.publisherLog="",
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

for (const outcome of ["published", "expired", "cancelled"] as const) {
  test(`expired lease lets approved publication settle before cleanup: ${outcome}`, async () => {
    const fixture = await sandboxGithubFixture(policy)
    const publication = sandboxPublicationFixture(fixture, policy)
    publication.wait(true)
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
            now: Date.now() - 286 * 60000,
          })
          yield* store.beginStart("run-1")
          yield* store.recordRun("run-1", 41, 1)
          const intents = yield* makePublishStore
          yield* intents.seal({
            runId: "run-1",
            actionsRunId: 41,
            attempt: 1,
            metadata,
            baseRef: "main",
            deadline: Date.now() + 60000,
          })
          const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
          const remote = yield* makeSandboxLeaseService(github)
          const publisher = yield* makeSandboxPublisher(github, remote)
          expect(yield* publisher.poll("run-1")).toBe("approved")
          // Reconstructed lease service models a coordinator restart at the lease deadline.
          const recovered = yield* makeSandboxLeaseService(github)
          yield* recovered.reconcile([policy])
          expect(fixture.cancellations).toEqual([])
          expect(fixture.refDeletes).toBe(0)
          expect((yield* store.read("run-1"))?.state).toBe("starting")
          if (outcome === "expired") {
            // Deadlines are immutable; model elapsed time through the clock, not a DB edit.
            const { spyOn } = yield* Effect.promise(() => import("bun:test"))
            const now = Date.now()
            const clock = spyOn(Date, "now").mockReturnValue(now + 61000)
            try {
              yield* recovered.reconcile([policy])
            } finally {
              clock.mockRestore()
            }
            expect(fixture.cancellations).toContain(41)
          } else if (outcome === "cancelled") {
            yield* recovered.release("run-1")
            expect(fixture.cancellations).toContain(41)
          } else {
            publication.wait(false)
            expect(yield* publisher.poll("run-1")).toBe("published")
          }
          fixture.mutateRun({
            status: "completed",
            conclusion: outcome === "published" ? "success" : "cancelled",
          })
          yield* recovered.reconcile([policy])
          expect((yield* store.read("run-1"))?.state).toBe("released")
          expect(fixture.refDeletes).toBe(1)
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
      )
    } finally {
      await fixture.close()
    }
  })
}
