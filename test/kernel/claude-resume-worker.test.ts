import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { SqliteClient } from "@effect/sql-sqlite-bun"
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
import { KernelSessionStore, KernelSessionStoreLive } from "../../src/kernel/session-store"
import { toJsonSchemaObject } from "../../src/json"
import { WorkflowStoreLive } from "../../src/store"

const at = new Date("2026-08-31T09:00:00.000Z")
const native = "0c0ffee0-cafe-4dad-b0ba-000000000001"
const directory = "/home/ben/Documents/repos/workflowd"

const storesLayer = KernelSessionStoreLive.pipe(
  Layer.provideMerge(
    WorkflowStoreLive.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))),
  ),
)

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
