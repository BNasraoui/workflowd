import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { startConfigReload, AgentRunDispatchSettings } from "../src/config-reload"
import { requiredEnvironment } from "./helpers/config"
import {
  defaultState,
  makeLayer,
  makeProvider,
  register,
  submission,
  worktrees,
} from "./kernel/agent-run-ingress-harness"

const route = "implement=zai-coding-plan/glm-5.3-flash"

test("SIGHUP changes dispatch admission and routes without changing the listener or leaking secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-reload-"))
  const base = join(directory, "base.env")
  const override = join(directory, "override.env")
  const logs: string[] = []
  const env = {
    ...requiredEnvironment,
    WORKFLOWD_AGENT_RUN_TOKEN: "dispatch-secret",
    WORKFLOWD_AGENT_RUN_REPOSITORIES: "workflowd=/tmp/original",
    WORKFLOWD_AGENT_RUN_ROUTES: route,
    WORKFLOWD_CONFIG_RELOAD_FILES: JSON.stringify([base, override]),
  }
  await writeFile(base, `WORKFLOWD_AGENT_RUN_REPOSITORIES=other=/tmp/other\n`)
  await writeFile(override, "")
  const reload = await startConfigReload(env, (line) => logs.push(line))
  try {
    const layer = makeLayer(makeProvider(defaultState()), worktrees([]), undefined, {
      repositories: reload.config.agentRuns!.repositories,
      routes: reload.config.agentRuns!.routes,
    }).pipe(Layer.provide(Layer.succeed(AgentRunDispatchSettings, reload.dispatchSettings)))
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(
          (yield* register({ ...submission, repository: "added" }).pipe(Effect.result))._tag,
        ).toBe("Failure")
        yield* Effect.promise(() =>
          writeFile(
            override,
            `WORKFLOWD_AGENT_RUN_REPOSITORIES=added=/tmp/added\nWORKFLOWD_AGENT_RUN_ROUTES=new=zai-coding-plan/glm-5.3-flash\nWORKFLOWD_PORT=9999\nOPENCODE_SERVER_PASSWORD='secret-do-not-log'\n`,
          ),
        )
        process.emit("SIGHUP")
        yield* Effect.promise(() => reload.settled())
        const accepted = yield* register({ ...submission, route: "new", repository: "added" })
        expect(accepted.status).toBe("dispatched")
        const removed = yield* register({ ...submission, route: "new" }).pipe(Effect.result)
        expect(removed).toMatchObject({
          _tag: "Failure",
          failure: { reason: "unknown_repository" },
        })
        expect(reload.config.http.port).toBe(8787)
        expect(logs.at(-1)).toContain("WORKFLOWD_PORT")
        expect(logs.at(-1)).toContain("restart_required=")
        expect(logs.at(-1)).toContain("WORKFLOWD_AGENT_RUN_REPOSITORIES")
        expect(logs.join("\n")).not.toContain("secret-do-not-log")
        expect(logs.join("\n")).not.toContain("/tmp/added")
        yield* Effect.promise(() =>
          writeFile(override, `WORKFLOWD_AGENT_RUN_REPOSITORIES=broken-secret-value\n`),
        )
        process.emit("SIGHUP")
        yield* Effect.promise(() => reload.settled())
        expect(logs.at(-1)).toContain("error=invalid_configuration")
        expect(logs.join("\n")).not.toContain("broken-secret-value")
        expect((yield* register({ ...submission, route: "new", repository: "added" })).status).toBe(
          "duplicate",
        )
      }).pipe(Effect.provide(layer)),
    )
    expect(logs).toHaveLength(2)
  } finally {
    await reload.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("an in-flight dispatch keeps its repository and model snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-reload-flight-"))
  const file = join(directory, "env")
  await writeFile(file, "")
  const reload = await startConfigReload(
    {
      ...requiredEnvironment,
      WORKFLOWD_AGENT_RUN_TOKEN: "dispatch-secret",
      WORKFLOWD_AGENT_RUN_REPOSITORIES: "workflowd=/tmp/original",
      WORKFLOWD_AGENT_RUN_ROUTES: route,
      WORKFLOWD_CONFIG_RELOAD_FILES: JSON.stringify([file]),
    },
    () => {},
  )
  const { Deferred, Fiber } = await import("effect")
  const started = await Effect.runPromise(Deferred.make<void>())
  const resume = await Effect.runPromise(Deferred.make<void>())
  const provider = makeProvider(defaultState())
  const created: Array<{ repository: string; directory: string; branch: string }> = []
  const layer = makeLayer(
    {
      ...provider,
      listProviders: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(resume)
          return yield* provider.listProviders({})
        }),
    },
    worktrees(created),
  ).pipe(Layer.provide(Layer.succeed(AgentRunDispatchSettings, reload.dispatchSettings)))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const flight = yield* register(submission).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Effect.promise(() =>
          writeFile(
            file,
            "WORKFLOWD_AGENT_RUN_REPOSITORIES=added=/tmp/added\nWORKFLOWD_AGENT_RUN_ROUTES=implement=anthropic/claude-fable-5\n",
          ),
        )
        process.emit("SIGHUP")
        yield* Effect.promise(() => reload.settled())
        yield* Deferred.succeed(resume, undefined)
        expect((yield* Fiber.join(flight)).modelId).toBe("glm-5.3-flash")
        expect(created[0]?.repository).toBe("/tmp/original")
        const removed = yield* register({ ...submission, prompt: "new dispatch" }).pipe(
          Effect.result,
        )
        expect(removed).toMatchObject({
          _tag: "Failure",
          failure: { reason: "unknown_repository" },
        })
      }).pipe(Effect.provide(layer)),
    )
  } finally {
    await reload.close()
    await rm(directory, { recursive: true, force: true })
  }
})
