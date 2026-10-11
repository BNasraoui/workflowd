import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { WorkflowStoreLive } from "../../src/store"
import { makeSandboxStore } from "../../src/sandbox/store"
import { makePublishStore } from "../../src/sandbox/publish-store"
import { makeSandboxPublisher } from "../../src/sandbox/publish"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { bindingDirectory, saveSandboxFile, writeSandboxBinding } from "../../src/sandbox/binding"
import { sandboxGithubFixture } from "./harness"

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

for (const kind of ["opencode", "codex", "claude"] as const) {
  for (const mismatch of [false, true]) {
    test(`${kind} publication uses the durable lease identity; mismatch=${mismatch}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "submission-publish-"))
      const fixture = await sandboxGithubFixture(policy)
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const runs = yield* AgentRunStore
            yield* runs.create({
              runId: "run-1",
              executorKind: kind,
              route: "sandbox",
              providerId: kind,
              modelId: "fixture",
              agent: "sandbox",
              repository: policy.alias,
              directory,
              prompt: "Task",
              promptSha256: "a".repeat(64),
              parentSessionId: null,
              resumePrompt: null,
              maxAttempts: 1,
              createdAt: new Date(),
            })
            const stored = (yield* runs.read("run-1"))!
            const nativeSessionId = kind === "opencode" ? "ses_fixture" : "conversation-uuid"
            const identity =
              kind === "opencode"
                ? nativeSessionId
                : `workflowd-sandbox-${kind}-${"e".repeat(24)}.service`
            const store = yield* makeSandboxStore
            yield* store.request({
              runId: stored.runId,
              leaseId: "lease-1",
              policy,
              sourceSha: "b".repeat(40),
              now: Date.now(),
            })
            yield* store.beginStart(stored.runId)
            yield* store.recordRun(stored.runId, 41, 1)
            yield* store.attachSession(stored.runId, identity)
            const lease = (yield* store.read(stored.runId))!
            const binding = {
              runId: stored.runId,
              leaseId: lease.lease_id,
              sessionId: mismatch ? "ses_foreign" : identity,
              executorId: `${kind}:local`,
              endpointIdentity: "http://127.0.0.1:1234",
              directory,
              locationIdentity: directory,
              bridgeServerName: "wfdlease_lease_1",
              repositoryId: policy.repositoryId,
              sourceSha: lease.source_sha,
              policyHash: "a".repeat(64),
              transportHash: "c".repeat(64),
              deadline: lease.deadline,
              state: "active" as const,
            }
            const completion = { environmentId: "selected", branch: "agent-choice" }
            yield* Effect.tryPromise(async () => {
              await writeSandboxBinding(binding, true)
              await saveSandboxFile(
                bindingDirectory(directory),
                "submission.json",
                JSON.stringify({ binding, completion }),
                true,
              )
              await writeSandboxBinding({ ...binding, state: "revoked" })
            })
            const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
            const remote = yield* makeSandboxLeaseService(github)
            let seals = 0
            const publisher = yield* makeSandboxPublisher(github, {
              ...remote,
              finishResult: (_runId, input) => {
                expect(JSON.parse(input)).toEqual(completion)
                seals++
                return Effect.succeed({
                  sourceSha: lease.source_sha,
                  resultSha: "c".repeat(40),
                  branch: completion.branch,
                  bundleSha256: "d".repeat(64),
                  manifestSha256: "e".repeat(64),
                })
              },
            })
            yield* publisher.saveTerminal(
              { ...stored, nativeSessionId },
              {
                state: "completed",
                sessionId: nativeSessionId,
                finalMessage: "Submitted with the tool",
                diagnostic: "Sandbox session succeeded",
              },
            )
            const publication = yield* makePublishStore
            expect((yield* publication.read(stored.runId)) !== null).toBe(!mismatch)
            expect(seals).toBe(mismatch ? 0 : 1)
            const terminal = yield* Effect.tryPromise(() =>
              Bun.file(join(directory, "terminal.json")).json(),
            )
            expect(terminal.state).toBe(mismatch ? "operator_required" : "completed")
          }).pipe(
            Effect.provide(
              AgentRunStoreLive.pipe(
                Layer.provideMerge(
                  WorkflowStoreLive.pipe(
                    Layer.provideMerge(
                      SqliteClient.layer({ filename: join(directory, "custody.sqlite") }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        )
      } finally {
        await fixture.close()
        await rm(directory, { recursive: true, force: true })
        await rm(bindingDirectory(directory), { recursive: true, force: true })
      }
    })
  }
}
