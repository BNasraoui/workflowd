import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentRunSummary } from "../../src/mcp/queries"
import { AgentRunStore, AgentRunStoreLive } from "../../src/kernel/agent-run-store"
import { callTool } from "../../src/mcp/tools"
import { clientValidator, firstText, mcpLayer } from "./harness"

const layer = AgentRunStoreLive.pipe(Layer.provideMerge(mcpLayer))
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))
const authorized = { writesConfigured: true, writesAuthorized: true, now: () => new Date() }
const at = new Date("2026-10-13T00:00:00.000Z")

const seed = Effect.gen(function* () {
  const store = yield* AgentRunStore
  for (let i = 0; i < 23; i++) {
    yield* store.create({
      runId: `run-${i.toString().padStart(2, "0")}`,
      route: "implement",
      providerId: "codex-cli",
      modelId: "gpt-test",
      executorKind: "codex",
      repository: i % 2 === 0 ? "owner/repo" : "owner/other",
      agent: "worker",
      directory: "/tmp/worker",
      prompt: "private prompt",
      promptSha256: "a".repeat(64),
      parentSessionId: null,
      resumePrompt: null,
      maxAttempts: 1,
      createdAt: new Date(at.getTime() + i * 1000),
    })
  }
  yield* store.fail({
    runId: "run-00",
    now: new Date(at.getTime() + 60_000),
    diagnostic: "launch_failed",
  })
  yield* store.cancel({ runId: "run-22", now: new Date(at.getTime() + 30_000) })
})

test("lists safe run summaries newest first, defaults to 20, and filters before limiting", async () => {
  await run(
    Effect.gen(function* () {
      yield* seed
      const listed = yield* callTool("list_agent_runs", {}, authorized)
      expect(listed.isError).toBeUndefined()
      expect(clientValidator("list_agent_runs")(listed.structuredContent).valid).toBe(true)
      const runs = Schema.decodeUnknownSync(Schema.Array(AgentRunSummary))(
        listed.structuredContent!.runs,
      )
      expect(runs).toHaveLength(20)
      expect(runs[0]).toEqual({
        run_id: "run-22",
        repository: "owner/repo",
        route: "implement",
        model: "gpt-test",
        executor: "codex",
        idempotency_key: null,
        status: "cancelled",
        end_reason: "cancelled",
        started_at: "2026-10-13T00:00:22.000Z",
        ended_at: "2026-10-13T00:00:30.000Z",
        worktree: null,
        worktree_detail: null,
      })
      expect(runs[1]).toMatchObject({
        run_id: "run-21",
        status: "accepted",
        end_reason: null,
        ended_at: null,
      })
      const filtered = yield* callTool(
        "list_agent_runs",
        { repository: "owner/repo", status: "failed", limit: 1 },
        authorized,
      )
      expect(filtered.structuredContent).toMatchObject({
        runs: [
          { run_id: "run-00", end_reason: "launch_failed", ended_at: "2026-10-13T00:01:00.000Z" },
        ],
      })
      const repository = yield* callTool(
        "list_agent_runs",
        { repository: "owner/other", limit: 1 },
        authorized,
      )
      expect(repository.structuredContent).toMatchObject({ runs: [{ run_id: "run-21" }] })
      const missing = yield* callTool("list_agent_runs", { repository: "' OR 1=1 --" }, authorized)
      expect(missing.structuredContent).toEqual({ runs: [] })
      const all = yield* callTool("list_agent_runs", { limit: 100 }, authorized)
      expect(all.structuredContent!.runs).toHaveLength(23)
    }),
  )
})

test("requires the same configured bearer authorization as the mailbox", async () => {
  for (const auth of [
    { writesConfigured: false, writesAuthorized: true },
    { writesConfigured: true, writesAuthorized: false },
  ]) {
    const result = await run(callTool("list_agent_runs", {}, { ...authorized, ...auth }))
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain("unauthorized")
  }
})

test("rejects invalid filters and limits in-band", async () => {
  for (const args of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: "1" },
    { status: "running" },
    { repository: "" },
    { extra: true },
  ]) {
    const result = await run(callTool("list_agent_runs", args, authorized))
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain("invalid arguments")
  }
})
