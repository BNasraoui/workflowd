import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { agentFragments, RemoteAgentLaunch } from "../../src/remote/agent-contract"
import { initAgentTransfers, receiveAgentFragment } from "../../src/remote/agent-transfer"
import { encodeRemoteCommand } from "../../src/remote/codec"

test("remote launch identities cannot escape the runner's workspace root", async () => {
  const launch = {
    runId: "agent-run-../../escape",
    route: "selection-fixture",
    submission: { family: "sol", host: "runner-b", repository: "repo", prompt: "Task" },
    selection: {
      host: "runner-b",
      executor: "codex:local",
      executorKind: "codex",
      provider: "openai",
      model: "gpt-6.10-sol",
      selectionModel: "gpt-6.10-sol",
      thinking: {},
      availability: "available",
      evidence: "advertised",
    },
    createdAt: new Date().toISOString(),
  }
  expect(
    (
      await Effect.runPromise(
        Schema.decodeUnknownEffect(RemoteAgentLaunch)(launch).pipe(Effect.result),
      )
    )._tag,
  ).toBe("Failure")
})

test("32 KiB control-character prompts survive bounded JSON/base64 transfer and out-of-order duplicates", async () => {
  const prompt = "\u0000".repeat(32768)
  const fragments = agentFragments("launch", { prompt })
  for (const fragment of fragments) {
    const command = {
      version: 1 as const,
      kind: "agent_launch" as const,
      commandId: `command-${fragment.index}`,
      jobId: "run",
      hostId: "runner-b",
      attempt: 1,
      generation: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      fragment,
    }
    expect((await Effect.runPromise(encodeRemoteCommand(command))).byteLength).toBeLessThanOrEqual(
      16384,
    )
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* initAgentTransfers
      const schema = Schema.Struct({ prompt: Schema.String })
      const order = [...fragments].reverse()
      for (const fragment of order.slice(0, -1)) {
        expect(yield* receiveAgentFragment(fragment, schema)).toBeNull()
        expect(yield* receiveAgentFragment(fragment, schema)).toBeNull()
      }
      expect(yield* receiveAgentFragment(order.at(-1)!, schema)).toEqual({ prompt })
      expect(yield* receiveAgentFragment(order.at(-1)!, schema)).toEqual({ prompt })
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  )
})

test("fragment conflicts, index overflow, digest corruption and invalid documents cannot advance durable transfer", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* initAgentTransfers
      const sql = yield* SqlClient.SqlClient
      const schema = Schema.Struct({ prompt: Schema.String })
      const fragment = agentFragments("good", { prompt: "ok" })[0]!
      expect(yield* receiveAgentFragment(fragment, schema)).toEqual({ prompt: "ok" })
      for (const changed of [
        { ...fragment, index: 1 },
        { ...fragment, count: 2 },
        { ...fragment, digest: "f".repeat(64) },
        { ...fragment, data: "bm8=" },
      ]) {
        const result = yield* receiveAgentFragment(changed, schema).pipe(
          sql.withTransaction,
          Effect.result,
        )
        expect(result._tag).toBe("Failure")
      }
      const corrupt = { ...fragment, transferId: "corrupt", digest: "f".repeat(64) }
      expect(
        (yield* receiveAgentFragment(corrupt, schema).pipe(sql.withTransaction, Effect.result))
          ._tag,
      ).toBe("Failure")
      expect(
        (yield* receiveAgentFragment(
          { ...fragment, transferId: "invalid", data: Buffer.from("null").toString("base64") },
          schema,
        ).pipe(sql.withTransaction, Effect.result))._tag,
      ).toBe("Failure")
      expect(yield* sql`SELECT transfer_id FROM remote_agent_fragments`).toEqual([
        { transfer_id: "good" },
      ])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  )
  expect(() => agentFragments("overflow", "a".repeat(786433))).toThrow("768 KiB")
})
