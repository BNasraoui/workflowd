import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { makeSandboxLeaseService } from "../../src/sandbox/lease"
import { makeSandboxGithub } from "../../src/sandbox/github"
import { makeNativeExecutionStore } from "../../src/sandbox/native-execution"
import { makeNativeResultStore } from "../../src/sandbox/native-result"
import { makeCapabilityStore, capabilityDigest } from "../../src/capability-gateway/store"
import { seedCapabilityRun, transport } from "../capability-gateway/fixture"
import { sandboxGithubFixture } from "./harness"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

test("native capture requires frozen current result and checks exact source/metadata receipts", async () => {
  const evidence = await mkdtemp(join(tmpdir(), "native-evidence-"))
  const policy = {
    alias: "fixture",
    repository: "fixture/repo",
    repositoryId: 12,
    installationId: 1,
    workflowSha: "a".repeat(40),
    appActorId: 56,
    agentImage: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "b".repeat(64),
    tailscaleClientId: "fixture",
    tailscaleAudience: "fixture",
  }
  const fixture = await sandboxGithubFixture(policy)
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { leases } = yield* seedCapabilityRun(Date.now(), true)
        const capabilities = yield* makeCapabilityStore
        const job = yield* capabilities.challenge("run", transport, Date.now())
        const binding = yield* capabilities.bind(
          job,
          "jti",
          capabilityDigest("fixture"),
          Date.now() + 60000,
          Date.now(),
        )
        yield* leases.bind("run", 78, 1, transport)
        const native = yield* makeNativeExecutionStore
        const invocation = yield* native.reserve("run")
        yield* native.acknowledge("run", invocation.nonce)
        const results = yield* makeNativeResultStore
        const completion = {
          branch: "arbitrary/branch",
          title: "Native result",
          body: "Useful result",
          commitMessage: "Result",
        }
        yield* results.submit(binding, { revision: 0, completion })
        const lease = (yield* leases.read("run"))!
        const github = yield* makeSandboxGithub(fixture.github, fixture.OctokitClass)
        const calls: string[] = []
        let swapped = false
        const service = yield* makeSandboxLeaseService(github, "/fixture", async (args, input) => {
          calls.push(args.at(-1)!)
          if (args.at(-1)!.endsWith("native-evidence"))
            return JSON.stringify({
              nonce: invocation.nonce,
              session: invocation.session_id,
              pty: Buffer.from("::error::private fixture trace").toString("base64"),
            })
          if (args.at(-1)!.endsWith("native-result")) {
            expect(JSON.parse(input)).toEqual({
              nonce: invocation.nonce,
              session: invocation.session_id,
              completion,
            })
            return JSON.stringify({
              ...completion,
              title: swapped ? "Foreign" : completion.title,
              sourceSha: lease.source_sha,
              resultSha: "e".repeat(40),
              treeSha: "f".repeat(40),
              bundleSha256: "b".repeat(64),
              manifestSha256: "c".repeat(64),
            })
          }
          return lease.source_sha
        })
        expect((yield* service.finishResult("run", "ignored prose").pipe(Effect.result))._tag).toBe(
          "Failure",
        )
        expect(calls).toHaveLength(0)
        yield* native.closed("run", invocation.nonce, "completed", 1)
        expect(yield* service.finishResult("run", "ignored prose")).toMatchObject(completion)
        expect(calls).toEqual(["exec /usr/local/bin/runner-control native-result"])
        yield* service.audit("run", join(evidence, "run"))
        expect(
          yield* Effect.promise(() =>
            Bun.file(join(evidence, "run.sandbox/native-evidence.json")).json(),
          ),
        ).toEqual({
          nonce: invocation.nonce,
          session: invocation.session_id,
          pty: Buffer.from("::error::private fixture trace").toString("base64"),
        })
        swapped = true
        expect((yield* service.finishResult("run", "ignored prose").pipe(Effect.result))._tag).toBe(
          "Failure",
        )
      }).pipe(
        Effect.provide(AgentRunStoreLive),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.scoped,
      ),
    )
  } finally {
    await fixture.close()
    await rm(evidence, { recursive: true, force: true })
  }
})
