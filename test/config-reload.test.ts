import { expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import { Deferred, Effect, Fiber } from "effect"
import { completed, withReload } from "./helpers/config-reload"
import {
  defaultState,
  makeLayer,
  makeProvider,
  register,
  submission,
  worktrees,
} from "./kernel/agent-run-ingress-harness"

const unchanged =
  "Configuration reload: changed=none restart_required=none restart_required_groups=none"

test("SIGHUP changes dispatch admission and routes and reports exact restart fields without secrets", async () => {
  await withReload(async ({ base, override, logs, signal, layer }) => {
    await writeFile(base, "WORKFLOWD_AGENT_RUN_REPOSITORIES=other=/tmp/other\n")
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(
          (yield* register({ ...submission, repository: "added" }).pipe(Effect.result))._tag,
        ).toBe("Failure")
        yield* Effect.promise(() =>
          writeFile(
            override,
            "WORKFLOWD_AGENT_RUN_REPOSITORIES=added=/tmp/added\nWORKFLOWD_AGENT_RUN_ROUTES=new=zai-coding-plan/glm-5.3-flash\nWORKFLOWD_PORT=9999\nOPENCODE_SERVER_PASSWORD='secret-do-not-log'\n",
          ),
        )
        yield* Effect.promise(signal)
        expect((yield* register({ ...submission, route: "new", repository: "added" })).status).toBe(
          "dispatched",
        )
        expect(yield* register({ ...submission, route: "new" }).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "unknown_repository" },
        })
        expect(logs).toEqual([
          "Configuration reload: changed=WORKFLOWD_AGENT_RUN_REPOSITORIES,WORKFLOWD_AGENT_RUN_ROUTES restart_required=OPENCODE_SERVER_PASSWORD,WORKFLOWD_PORT restart_required_groups=http,openCode",
        ])
        expect(logs.join("\n")).not.toContain("secret-do-not-log")
        expect(logs.join("\n")).not.toContain("/tmp/added")
      }).pipe(Effect.provide(layer)),
    )
  })
})

test("an in-flight dispatch keeps its repository and model snapshot", async () => {
  await withReload(async ({ override, signal, provide }) => {
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
    ).pipe(provide)
    await Effect.runPromise(
      Effect.gen(function* () {
        const flight = yield* register(submission).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Effect.promise(() =>
          writeFile(
            override,
            "WORKFLOWD_AGENT_RUN_REPOSITORIES=added=/tmp/added\nWORKFLOWD_AGENT_RUN_ROUTES=implement=anthropic/claude-fable-5\n",
          ),
        )
        yield* Effect.promise(signal)
        yield* Deferred.succeed(resume, undefined)
        expect((yield* Fiber.join(flight)).modelId).toBe("glm-5.3-flash")
        expect(created[0]?.repository).toBe("/tmp/original")
        expect(
          yield* register({ ...submission, prompt: "new dispatch" }).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { reason: "unknown_repository" } })
      }).pipe(Effect.provide(layer)),
    )
  })
})

test("malformed or missing files keep dispatch unchanged and later signals recover", async () => {
  await withReload(async ({ override, signal, logs, layer }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() => rm(override))
        yield* Effect.promise(signal)
        expect(logs.at(-1)).toBe(
          "Configuration reload: error=read_failed changed=none restart_required=none restart_required_groups=none",
        )
        yield* Effect.promise(() =>
          writeFile(
            override,
            "WORKFLOWD_AGENT_RUN_REPOSITORIES=added=/tmp/added\nSECRET='unfinished-secret",
          ),
        )
        yield* Effect.promise(signal)
        expect(logs.at(-1)).toBe(
          "Configuration reload: error=invalid_environment_file changed=none restart_required=none restart_required_groups=none",
        )
        expect((yield* register(submission)).status).toBe("dispatched")
        yield* Effect.promise(() =>
          writeFile(
            override,
            "WORKFLOWD_AGENT_RUN_REPOSITORIES=added=/tmp/added\nWORKFLOWD_AGENT_RUN_CODEX_ROUTES=scan=gpt-5.6-sol\nWORKFLOWD_AGENT_RUN_CLAUDE_ROUTES=review=claude-opus-5\n",
          ),
        )
        process.emit("SIGHUP")
        yield* Effect.promise(signal)
        for (const [route, model] of [
          ["scan", "gpt-5.6-sol"],
          ["review", "claude-opus-5"],
        ] as const) {
          const receipt = yield* register({ ...submission, repository: "added", route })
          expect(receipt.modelId).toBe(model)
          yield* completed(receipt.runId)
        }
        expect(yield* register(submission).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "unknown_repository" },
        })
        expect(logs.at(-1)).toBe(unchanged)
        expect(logs).toHaveLength(4)
        expect(logs.join("\n")).not.toContain("unfinished-secret")
      }).pipe(Effect.provide(layer)),
    )
  })
})

test("deleting file-owned route and restart-only lines removes their startup values", async () => {
  const routes = {
    WORKFLOWD_AGENT_RUN_ROUTES: "implement=zai-coding-plan/glm-5.3-flash",
    WORKFLOWD_AGENT_RUN_CODEX_ROUTES: "scan=gpt-5.6-sol",
    WORKFLOWD_AGENT_RUN_CLAUDE_ROUTES: "review=claude-opus-5",
    WORKFLOWD_FIX_WORK_ENABLED: "false",
  }
  await withReload(
    async ({ override, signal, logs, layer }) => {
      await signal()
      expect(logs.at(-1)).toBe(unchanged)
      await writeFile(override, "")
      await signal()
      await Effect.runPromise(
        Effect.gen(function* () {
          for (const route of ["implement", "scan", "review"]) {
            expect(yield* register({ ...submission, route }).pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: { reason: "unknown_route" },
            })
          }
        }).pipe(Effect.provide(layer)),
      )
      expect(logs.at(-1)).toBe(
        "Configuration reload: changed=WORKFLOWD_AGENT_RUN_ROUTES,WORKFLOWD_AGENT_RUN_CODEX_ROUTES,WORKFLOWD_AGENT_RUN_CLAUDE_ROUTES restart_required=WORKFLOWD_FIX_WORK_ENABLED restart_required_groups=none",
      )
    },
    {
      env: routes,
      content: Object.entries(routes)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    },
  )
})

for (const [setting, value] of [
  ["WORKFLOWD_AGENT_RUN_REPOSITORIES", "broken-secret-value"],
  ["WORKFLOWD_PORT", "secret-invalid-port"],
]) {
  test(`invalid ${setting} names the setting and preserves accepted dispatch`, async () => {
    await withReload(async ({ override, signal, logs, layer }) => {
      await writeFile(override, `${setting}=${value}\n`)
      await signal()
      expect(logs).toEqual([
        `Configuration reload: error=invalid_configuration setting=${setting} changed=none restart_required=none restart_required_groups=none`,
      ])
      expect(logs.join("\n")).not.toContain(value!)
      await Effect.runPromise(
        Effect.gen(function* () {
          expect((yield* register(submission)).status).toBe("dispatched")
        }).pipe(Effect.provide(layer)),
      )
    })
  })
}

test("a reporting failure leaves dispatch unchanged", async () => {
  let fail = true
  await withReload(
    async ({ override, signal, logs, layer }) => {
      await writeFile(override, "WORKFLOWD_AGENT_RUN_REPOSITORIES=added=/tmp/added\n")
      await signal()
      await Effect.runPromise(
        Effect.gen(function* () {
          expect((yield* register(submission)).status).toBe("dispatched")
          expect(
            yield* register({ ...submission, repository: "added" }).pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure", failure: { reason: "unknown_repository" } })
        }).pipe(Effect.provide(layer)),
      )
      expect(logs).toEqual([
        "Configuration reload: error=invalid_configuration changed=none restart_required=none restart_required_groups=none",
      ])
    },
    {
      log: () => {
        if (fail) {
          fail = false
          throw new Error("report unavailable")
        }
      },
    },
  )
})

test("closing joins queued reloads and ignores later HUP events", async () => {
  await withReload(async ({ override, reload, logs }) => {
    await writeFile(override, "WORKFLOWD_AGENT_RUN_ROUTES=other=zai-coding-plan/glm-5.3-flash\n")
    process.emit("SIGHUP")
    await reload.close()
    expect(logs).toEqual([
      "Configuration reload: changed=WORKFLOWD_AGENT_RUN_ROUTES restart_required=none restart_required_groups=none",
    ])
    process.emit("SIGHUP")
    await reload.settled()
    expect(logs).toHaveLength(1)
  })
})
