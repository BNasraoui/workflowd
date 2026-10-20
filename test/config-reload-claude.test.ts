import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { ExecutionDiscovery } from "../src/execution-capabilities"
import { makeDiscoveryLayer } from "../src/layers-execution"
import { completed, withReload } from "./helpers/config-reload"
import {
  defaultState,
  makeCodexCli,
  makeLayer,
  makeProvider,
  register,
  submission,
  worktrees,
} from "./kernel/agent-run-ingress-harness"

test("Claude discovery exists before routes and reload dispatch checks readiness lazily", async () => {
  await withReload(
    async ({ reload, override, signal, provide }) => {
      let checks = 0
      const cli = makeCodexCli([
        { type: "agent_message", text: "done" },
        { type: "turn.completed", outputTokens: 4 },
      ]).port
      const layer = makeLayer(
        makeProvider(defaultState()),
        worktrees([]),
        undefined,
        { ...reload.config.agentRuns, claudeHosts: [] },
        {
          ...cli,
          preflight: Effect.sync(() => {
            checks++
          }),
        },
      ).pipe(Layer.provideMerge(makeDiscoveryLayer(reload.config)), provide)
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(override, "WORKFLOWD_AGENT_RUN_CLAUDE_ROUTES=review=claude-opus-5\n"),
          )
          yield* Effect.promise(signal)
          const discovery = yield* ExecutionDiscovery
          expect((yield* discovery.list()).sources).toMatchObject([
            { executor: "claude:local", kind: "claude", status: "unsupported" },
          ])
          expect(checks).toBe(0)
          const receipt = yield* register({ ...submission, route: "review" })
          expect(receipt.modelId).toBe("claude-opus-5")
          yield* completed(receipt.runId)
          expect(checks).toBe(1)
        }).pipe(Effect.provide(layer), Effect.scoped),
      )
    },
    { env: { WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "false" } },
  )
})
