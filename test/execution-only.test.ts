import { ExecutionCapabilities } from "../src/execution-capability-contract"
import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Option, Layer, Schedule, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { loadConfig } from "../src/config"
import { makeLiveLayer } from "../src/layers"
import { startHookService } from "../src/runtime"
import { mainProgram } from "../src/main"
import { Automation } from "../src/opencode"
import { GitHub } from "../src/github"
import { AgentRunProvider } from "../src/kernel/agent-run-ingress"

test("real execution-only daemon starts with native Codex discovery and no PR consumers", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccw2-execution-only-"))
  try {
    const binary = join(root, "codex-fixture")
    await writeFile(
      binary,
      `#!/usr/bin/env bun\nif (process.argv[2] === "app-server") { process.argv[2] = "normal"; await import(${JSON.stringify(join(import.meta.dir, "execution/fixtures/codex-app-server.mjs"))}); } else console.log("fixture");`,
      { mode: 0o700 },
    )
    const config = await loadConfig({
      WORKFLOWD_MODE: "execution",
      WORKFLOWD_AGENT_RUN_TOKEN: "native-secret",
      WORKFLOWD_AGENT_RUN_REPOSITORIES: `fixture=${root}`,
      WORKFLOWD_AGENT_RUN_CODEX_BIN: binary,
      WORKFLOWD_DATABASE_PATH: join(root, "state.db"),
      WORKFLOWD_EXECUTION_CAPABILITIES_TIMEOUT_MS: "1000",
    })
    // A port selected by the OS is test-only; config continues to validate real ports.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        expect(Option.isNone(yield* Effect.serviceOption(Automation))).toBe(true)
        expect(Option.isNone(yield* Effect.serviceOption(GitHub))).toBe(true)
        expect(Option.isNone(yield* Effect.serviceOption(AgentRunProvider))).toBe(true)
        const server = yield* startHookService({ ...config, http: { ...config.http, port: 0 } })
        const capabilities = yield* Effect.tryPromise(() =>
          fetch(new URL("/execution-capabilities", server.url), {
            headers: { authorization: "Bearer native-secret" },
          }).then((r) => r.json()),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ExecutionCapabilities)))
        const hook = yield* Effect.tryPromise(() =>
          fetch(new URL("/hooks/github", server.url), { method: "POST" }),
        )
        return { capabilities, hook: hook.status }
      }).pipe(
        Effect.provide(
          makeLiveLayer(config).pipe(
            Layer.provide(SqliteClient.layer({ filename: config.storage.databasePath })),
          ),
        ),
        Effect.scoped,
      ),
    )
    expect(result.capabilities.capabilities[0]).toMatchObject({
      identity: { executor: "codex:local", model: "first" },
      availability: "unknown",
    })
    expect(result.hook).toBe(404)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("daemon entry point loads execution-only config, serves HTTP and releases on interruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccw2-main-"))
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = reservation.port!
  await reservation.stop(true)
  const controller = new AbortController()
  let program: Promise<unknown> | undefined
  try {
    const binary = join(root, "codex-fixture")
    await writeFile(binary, '#!/usr/bin/env bun\nconsole.log("fixture");\n', { mode: 0o700 })
    program = Effect.runPromiseExit(
      mainProgram({
        WORKFLOWD_MODE: "execution",
        WORKFLOWD_HOST: "127.0.0.1",
        WORKFLOWD_PORT: String(port),
        WORKFLOWD_AGENT_RUN_TOKEN: "native-secret",
        WORKFLOWD_AGENT_RUN_REPOSITORIES: `fixture=${root}`,
        WORKFLOWD_AGENT_RUN_CODEX_BIN: binary,
        WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "false",
        WORKFLOWD_DATABASE_PATH: join(root, "nested/state.db"),
      }),
      { signal: controller.signal },
    )
    const url = `http://127.0.0.1:${port}/hooks/github`
    const response = await Effect.runPromise(
      Effect.tryPromise(() => fetch(url, { method: "POST" })).pipe(
        Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 300 }),
        Effect.timeout("5 seconds"),
      ),
    )
    expect(response.status).toBe(404)
    controller.abort()
    expect(await program).toMatchObject({ _tag: "Failure" })
    await expect(fetch(url)).rejects.toThrow()
  } finally {
    controller.abort()
    await program
    await rm(root, { recursive: true, force: true })
  }
})
