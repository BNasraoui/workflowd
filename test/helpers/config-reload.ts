import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schedule } from "effect"
import { AgentRunDispatchSettings, startConfigReload } from "../../src/config-reload"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { requiredEnvironment } from "./config"
import {
  defaultState,
  makeCodexCli,
  makeLayer,
  makeProvider,
  worktrees,
} from "../kernel/agent-run-ingress-harness"

export async function withReload(
  run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  options: Parameters<typeof setup>[0] = {},
) {
  const fixture = await setup(options)
  try {
    await run(fixture)
  } finally {
    await fixture.reload.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
}

async function setup(
  options: {
    env?: Record<string, string | undefined>
    content?: string
    log?: (line: string) => void
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-reload-"))
  const base = join(directory, "base.env")
  const override = join(directory, "override.env")
  const logs: string[] = []
  await writeFile(base, "")
  await writeFile(override, options.content ?? "")
  try {
    const reload = await startConfigReload(
      {
        ...requiredEnvironment,
        WORKFLOWD_AGENT_RUN_TOKEN: "dispatch-secret",
        WORKFLOWD_AGENT_RUN_REPOSITORIES: "workflowd=/tmp/original",
        WORKFLOWD_AGENT_RUN_ROUTES: "implement=zai-coding-plan/glm-5.3-flash",
        WORKFLOWD_CONFIG_RELOAD_FILES: JSON.stringify([base, override]),
        ...options.env,
      },
      (line) => {
        options.log?.(line)
        logs.push(line)
      },
    )
    const provide = Layer.provide(Layer.succeed(AgentRunDispatchSettings, reload.dispatchSettings))
    const layer = makeLayer(
      makeProvider(defaultState()),
      worktrees([]),
      undefined,
      reload.config.agentRuns,
      makeCodexCli(
        [
          { type: "agent_message", text: "done" },
          { type: "turn.completed", outputTokens: 4 },
        ],
        0,
        undefined,
        "01a09976-e799-7c52-9759-8b76d692b756",
      ).port,
    ).pipe(provide)
    const signal = async () => {
      process.emit("SIGHUP")
      await reload.settled()
    }
    return { directory, base, override, reload, logs, layer, provide, signal }
  } catch (cause) {
    await rm(directory, { recursive: true, force: true })
    throw cause
  }
}

export const completed = (runId: string) =>
  Effect.gen(function* () {
    const store = yield* AgentRunStore
    yield* store
      .read(runId)
      .pipe(
        Effect.repeat({
          until: (row) => row?.state === "completed",
          schedule: Schedule.spaced("5 millis"),
        }),
        Effect.timeout("2 seconds"),
      )
  })
