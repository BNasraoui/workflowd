import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"
import { Effect, Layer, Schema } from "effect"
import {
  AGENT_WAKE_CONTRACT,
  AgentWakeResult,
  agentWakePrompt,
} from "../../src/kernel/agent-wait-ingress"
import { runClaudeResumeIteration } from "../../src/kernel/claude-resume-worker"
import {
  ClaudeCli,
  claudeEndpointIdentity,
  claudeSessionCustodyId,
  encodeClaudeProjectDir,
  makeClaudeCli,
  type ClaudeCliPort,
} from "../../src/kernel/claude-session"
import { KernelEventStoreLive } from "../../src/kernel/event-store"
import { KernelJobStore, KernelJobStoreLive } from "../../src/kernel/job-store"
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { ClaudeResumeRemoteProducerLive } from "../../src/remote/claude-resume-producer"
import { toJsonSchemaObject } from "../../src/json"
import { WorkflowStoreLive } from "../../src/store"

const at = new Date("2026-08-31T09:00:00.000Z")
const native = "0c0ffee0-cafe-4dad-b0ba-000000000001"
const directory = "/home/ben/Documents/repos/workflowd"

const storesLayer = (() => {
  const bootstrap = WorkflowStoreLive.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  )
  const kernel = Layer.mergeAll(
    KernelSessionStoreLive,
    KernelEventStoreLive,
    KernelJobStoreLive,
  ).pipe(Layer.provideMerge(bootstrap))
  return ClaudeResumeRemoteProducerLive.pipe(Layer.provideMerge(kernel))
})()

const contract = {
  name: AGENT_WAKE_CONTRACT.name,
  version: AGENT_WAKE_CONTRACT.version,
  schema: AgentWakeResult as Schema.Codec<unknown, unknown>,
  jsonSchema: toJsonSchemaObject(AgentWakeResult),
  maxOutputBytes: 16_384,
}

const options = {
  owningHostId: "mint",
  workerId: "test:claude-resume",
  leaseDurationMs: 60_000,
  heartbeatIntervalMs: 20_000,
  resumeTimeoutMs: 5_000,
  retryDelayMs: 1_000,
  claudeHosts: ["ben-arch"],
  remoteTurnTimeoutMs: 120_000,
  now: () => at,
  contracts: [contract],
}

const wake = agentWakePrompt("Your child finished; acknowledge.")

const seed = Effect.gen(function* () {
  const store = yield* KernelSessionStore
  yield* store.registerResource({
    resourceId: "claude-parent-resource",
    owningHostId: "mint",
    absolutePath: directory,
    kind: "checkout",
    createdAt: at,
  })
  yield* store.registerSession({
    sessionId: claudeSessionCustodyId(native),
    providerKind: "claude",
    providerVersion: 1,
    providerId: "claude-cli",
    serverId: "mint",
    owningHostId: "mint",
    endpointAlias: "local-cli",
    endpointIdentity: claudeEndpointIdentity("mint"),
    nativeSessionId: native,
    resourceId: "claude-parent-resource",
    createdAt: at,
  })
  yield* store.registerResumeRequest({
    requestId: "claude-resume-1",
    sessionId: claudeSessionCustodyId(native),
    owningHostId: "mint",
    prompt: wake.resumePrompt,
    promptText: wake.resumePromptText,
    promptSha256: createHash("sha256").update(wake.resumePromptText, "utf8").digest("hex"),
    outputContract: AGENT_WAKE_CONTRACT.name,
    outputContractVersion: AGENT_WAKE_CONTRACT.version,
    maxAttempts: 3,
    runAt: at,
    createdAt: at,
  })
})

const remoteNative = "0c0ffee0-cafe-4dad-b0ba-000000000002"
const remoteDirectory = "/home/ben/Documents/repos/workflowd"

/** A parent session owned by ben-arch: its wake must ride the remote plane. */
const seedRemote = (promptOverride?: { prompt: unknown; promptText: string }) =>
  Effect.gen(function* () {
    const store = yield* KernelSessionStore
    yield* store.registerResource({
      resourceId: "claude-remote-resource",
      owningHostId: "mint",
      absolutePath: remoteDirectory,
      kind: "checkout",
      createdAt: at,
    })
    yield* store.registerSession({
      sessionId: claudeSessionCustodyId(remoteNative),
      providerKind: "claude",
      providerVersion: 1,
      providerId: "claude-cli",
      serverId: "ben-arch",
      owningHostId: "mint",
      endpointAlias: "local-cli",
      endpointIdentity: claudeEndpointIdentity("ben-arch"),
      nativeSessionId: remoteNative,
      resourceId: "claude-remote-resource",
      createdAt: at,
    })
    const document = promptOverride ?? {
      prompt: wake.resumePrompt,
      promptText: wake.resumePromptText,
    }
    yield* store.registerResumeRequest({
      requestId: "claude-remote-1",
      sessionId: claudeSessionCustodyId(remoteNative),
      owningHostId: "mint",
      prompt: document.prompt,
      promptText: document.promptText,
      promptSha256: createHash("sha256").update(document.promptText, "utf8").digest("hex"),
      outputContract: AGENT_WAKE_CONTRACT.name,
      outputContractVersion: AGENT_WAKE_CONTRACT.version,
      maxAttempts: 3,
      runAt: at,
      createdAt: at,
    })
  })

const cliOf = (
  prompts: Array<string>,
  answers: ReadonlyArray<string>,
  exists = true,
): ClaudeCliPort => ({
  sessionExists: () => Effect.succeed(exists),
  resume: (input) =>
    Effect.sync(() => {
      prompts.push(input.prompt)
      const index = Math.min(prompts.length - 1, answers.length - 1)
      return JSON.stringify({ result: answers[index] })
    }),
})

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof storesLayer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(storesLayer)))

describe("claude resume worker", () => {
  test("delivers the wake through the claude CLI and records the structured ack", async () => {
    const prompts: Array<string> = []
    const ack = JSON.stringify({ acknowledged: true, summary: "woken by workflowd" })
    const result = await run(
      Effect.gen(function* () {
        yield* seed
        const iteration = yield* runClaudeResumeIteration(options).pipe(
          Effect.provideService(ClaudeCli, cliOf(prompts, ["ACK line", ack])),
        )
        const store = yield* KernelSessionStore
        return {
          iteration,
          request: yield* store.readResumeRequest("claude-resume-1"),
          result: yield* store.readResumeResult("claude-resume-1"),
          session: yield* store.readSession(claudeSessionCustodyId(native)),
        }
      }),
    )
    expect(result.iteration).toMatchObject({ status: "completed", requestId: "claude-resume-1" })
    // First turn carries the canonical wake document verbatim; the second is
    // the schema-bearing extraction request.
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toBe(wake.resumePromptText)
    expect(prompts[1]).toContain("JSON Schema")
    expect(result.request).toMatchObject({ state: "completed" })
    expect(result.result).toMatchObject({
      result_json: '{"acknowledged":true,"summary":"woken by workflowd"}',
    })
    // The delivered wake leaves the parent wakeable again.
    expect(result.session).toMatchObject({ state: "ready" })
  })

  test("retries extraction once with feedback, then escalates without re-sending the wake", async () => {
    const recovered = JSON.stringify({ acknowledged: true, summary: "second try" })
    const promptsRecovered: Array<string> = []
    const promptsBroken: Array<string> = []
    const result = await run(
      Effect.gen(function* () {
        yield* seed
        const recoveredIteration = yield* runClaudeResumeIteration(options).pipe(
          Effect.provideService(
            ClaudeCli,
            cliOf(promptsRecovered, ["ACK", "not json at all", recovered]),
          ),
        )
        return { recoveredIteration }
      }),
    )
    expect(result.recoveredIteration).toMatchObject({ status: "completed" })
    expect(promptsRecovered).toHaveLength(3)
    expect(promptsRecovered[2]).toContain("failed validation")

    const escalated = await run(
      Effect.gen(function* () {
        yield* seed
        const iteration = yield* runClaudeResumeIteration(options).pipe(
          Effect.provideService(
            ClaudeCli,
            cliOf(promptsBroken, ["ACK", "still not json", "still not json"]),
          ),
        )
        const store = yield* KernelSessionStore
        return { iteration, request: yield* store.readResumeRequest("claude-resume-1") }
      }),
    )
    // The wake was sent exactly once; only the extraction was retried.
    expect(promptsBroken.filter((prompt) => prompt === wake.resumePromptText)).toHaveLength(1)
    expect(escalated.iteration).toMatchObject({ status: "operator_required" })
    expect(escalated.request).toMatchObject({ state: "operator_required" })
  })

  test("escalates to operator_required when the session transcript is gone", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed
        const iteration = yield* runClaudeResumeIteration(options).pipe(
          Effect.provideService(ClaudeCli, cliOf([], ["unused"], false)),
        )
        const store = yield* KernelSessionStore
        return { iteration, request: yield* store.readResumeRequest("claude-resume-1") }
      }),
    )
    expect(result.iteration).toMatchObject({ status: "operator_required" })
    expect(result.request).toMatchObject({ state: "operator_required" })
  })

  test("encodes claude project directories the way the CLI stores them", () => {
    expect(encodeClaudeProjectDir("/home/ben/Documents/repos/workflowd")).toBe(
      "-home-ben-Documents-repos-workflowd",
    )
  })

  test("dispatches a cross-host wake as a single-attempt remote job and parks the resume", async () => {
    const prompts: Array<string> = []
    const result = await run(
      Effect.gen(function* () {
        yield* seedRemote()
        const iteration = yield* runClaudeResumeIteration(options).pipe(
          Effect.provideService(ClaudeCli, cliOf(prompts, ["unused"])),
        )
        const store = yield* KernelSessionStore
        const jobs = yield* KernelJobStore
        const sql = yield* SqlClient.SqlClient
        const job = yield* jobs.readJob("claude-resume-remote-claude-remote-1-a1")
        const jobRow = yield* sql<{
          readonly input_json: string
        }>`SELECT input_json FROM kernel_workflow_jobs
          WHERE job_id = 'claude-resume-remote-claude-remote-1-a1'`
        const checkpoint = yield* sql<{
          readonly checkpoint_json: string
        }>`SELECT checkpoint_json FROM kernel_resume_checkpoints
          WHERE request_id = 'claude-remote-1' AND checkpoint_version = 2`
        const input = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )(jobRow[0]!.input_json)
        return {
          iteration,
          job,
          input,
          checkpoint,
          request: yield* store.readResumeRequest("claude-remote-1"),
        }
      }),
    )
    expect(result.iteration).toMatchObject({
      status: "remote_dispatched",
      requestId: "claude-remote-1",
    })
    // No CLI turn ever runs on the daemon for a remote parent.
    expect(prompts).toHaveLength(0)
    expect(result.job).toMatchObject({ state: "ready", maxAttempts: 1 })
    expect(result.input).toMatchObject({
      kind: "claude_resume",
      hostId: "ben-arch",
      nativeSessionId: remoteNative,
      directory: remoteDirectory,
      prompt: wake.resumePromptText,
      turnTimeoutMs: 120_000,
    })
    expect(result.checkpoint).toHaveLength(1)
    expect(JSON.parse(result.checkpoint[0]!.checkpoint_json)).toMatchObject({
      remoteJobId: "claude-resume-remote-claude-remote-1-a1",
    })
    expect(result.request).toMatchObject({ state: "observation_required" })
  })

  test("completes the parked resume when the remote job succeeds with a valid ack", async () => {
    const ack = JSON.stringify({ acknowledged: true, summary: "woken across hosts" })
    const result = await run(
      Effect.gen(function* () {
        yield* seedRemote()
        const cli = cliOf([], ["unused"])
        yield* runClaudeResumeIteration(options).pipe(Effect.provideService(ClaudeCli, cli))
        const jobs = yield* KernelJobStore
        const claimed = yield* jobs.claimRemote({
          workerId: "test:remote",
          now: at,
          leaseDurationMs: 60_000,
        })
        if (claimed === null) return yield* Effect.die(new Error("expected a remote claim"))
        yield* jobs.complete({
          jobId: claimed.jobId,
          workerId: claimed.workerId,
          attempt: claimed.attempt,
          claimToken: claimed.claimToken,
          expectedLeaseUntil: claimed.leaseUntil,
          now: at,
          resultId: `${claimed.jobId}:result`,
          resultVersion: 1,
          result: { kind: "claude_resume", hostId: "ben-arch", status: "succeeded", output: ack },
        })
        const observed = yield* runClaudeResumeIteration(options).pipe(
          Effect.provideService(ClaudeCli, cli),
        )
        const store = yield* KernelSessionStore
        return {
          observed,
          request: yield* store.readResumeRequest("claude-remote-1"),
          result: yield* store.readResumeResult("claude-remote-1"),
          session: yield* store.readSession(claudeSessionCustodyId(remoteNative)),
        }
      }),
    )
    expect(result.observed).toMatchObject({ status: "completed", requestId: "claude-remote-1" })
    expect(result.request).toMatchObject({ state: "completed" })
    expect(result.result).toMatchObject({
      result_json: '{"acknowledged":true,"summary":"woken across hosts"}',
    })
    // The delivered wake leaves the remote parent wakeable again.
    expect(result.session).toMatchObject({ state: "ready" })
  })

  test("waits while the remote job is in flight and escalates on failed delivery", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seedRemote()
        const cli = cliOf([], ["unused"])
        yield* runClaudeResumeIteration(options).pipe(Effect.provideService(ClaudeCli, cli))
        // Job untouched (ready): the observer must not decide anything yet.
        const waiting = yield* runClaudeResumeIteration(options).pipe(
          Effect.provideService(ClaudeCli, cli),
        )
        const store = yield* KernelSessionStore
        const parked = yield* store.readResumeRequest("claude-remote-1")
        const jobs = yield* KernelJobStore
        const claimed = yield* jobs.claimRemote({
          workerId: "test:remote",
          now: at,
          leaseDurationMs: 60_000,
        })
        if (claimed === null) return yield* Effect.die(new Error("expected a remote claim"))
        yield* jobs.complete({
          jobId: claimed.jobId,
          workerId: claimed.workerId,
          attempt: claimed.attempt,
          claimToken: claimed.claimToken,
          expectedLeaseUntil: claimed.leaseUntil,
          now: at,
          resultId: `${claimed.jobId}:result`,
          resultVersion: 1,
          result: {
            kind: "claude_resume",
            hostId: "ben-arch",
            status: "failed",
            failureReason: "transcript_missing",
          },
        })
        const escalated = yield* runClaudeResumeIteration(options).pipe(
          Effect.provideService(ClaudeCli, cli),
        )
        return {
          waiting,
          parked,
          escalated,
          request: yield* store.readResumeRequest("claude-remote-1"),
          observation: yield* store.readLatestObservation("claude-remote-1"),
        }
      }),
    )
    expect(result.waiting).toMatchObject({ status: "idle" })
    expect(result.parked).toMatchObject({ state: "observation_required" })
    expect(result.escalated).toMatchObject({ status: "operator_required" })
    expect(result.request).toMatchObject({ state: "operator_required" })
    expect(result.observation).toMatchObject({ disposition: "operator_required" })
    expect(String(result.observation?.evidence_json)).toContain("transcript_missing")
  })

  test("refuses a wake document that exceeds the remote wire budget", async () => {
    const oversized = agentWakePrompt("x".repeat(9_000))
    const result = await run(
      Effect.gen(function* () {
        yield* seedRemote({
          prompt: oversized.resumePrompt,
          promptText: oversized.resumePromptText,
        })
        const iteration = yield* runClaudeResumeIteration(options).pipe(
          Effect.provideService(ClaudeCli, cliOf([], ["unused"])),
        )
        const store = yield* KernelSessionStore
        return { iteration, request: yield* store.readResumeRequest("claude-remote-1") }
      }),
    )
    expect(result.iteration).toMatchObject({
      status: "operator_required",
      reason: "prompt_exceeds_remote_budget",
    })
    expect(result.request).toMatchObject({ state: "operator_required" })
  })

  test("the live CLI port spawns argv-vector and probes real transcripts", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const home = await mkdtemp(join(tmpdir(), "claude-cli-port-"))
    try {
      const port = makeClaudeCli({ binary: "/bin/echo", home })
      const projectDir = join(home, "work")
      await mkdir(join(home, ".claude", "projects", encodeClaudeProjectDir(projectDir)), {
        recursive: true,
      })
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(home, ".claude", "projects", encodeClaudeProjectDir(projectDir), "abc-123.jsonl"),
        "{}\n",
      )
      const exists = await Effect.runPromise(
        port.sessionExists({ nativeSessionId: "abc-123", directory: projectDir }),
      )
      const missing = await Effect.runPromise(
        port.sessionExists({ nativeSessionId: "nope", directory: projectDir }),
      )
      const hostile = await Effect.runPromise(
        port.sessionExists({ nativeSessionId: "../escape", directory: projectDir }),
      )
      // /bin/echo prints the argv back: the flags are present and the
      // prompt is ABSENT — it rides stdin, never the command line.
      const echoed = await Effect.runPromise(
        port.resume({
          nativeSessionId: "abc-123",
          directory: projectDir,
          prompt: "hello; rm -rf $HOME",
          timeoutMs: 5_000,
        }),
      )
      expect(exists).toBe(true)
      expect(missing).toBe(false)
      expect(hostile).toBe(false)
      expect(echoed).toContain("-p --resume abc-123 --output-format json")
      expect(echoed).not.toContain("rm -rf")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
