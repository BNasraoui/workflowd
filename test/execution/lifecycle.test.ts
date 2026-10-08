import { expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Cause, Effect, Fiber, Layer, Option, Schema } from "effect"
import { loadConfig } from "../../src/config"
import { ExecutionDiscovery } from "../../src/execution-capabilities"
import { makeLiveLayer } from "../../src/layers"

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("fixture condition timed out")
    await Bun.sleep(5)
  }
}

for (const [action, name] of [
  ["scope", "closing the live discovery layer terminates its native Codex process and descendant"],
  [
    "reader",
    "cancelling one live discovery reader preserves another reader's shared native refresh",
  ],
] as const)
  test(name, async () => {
    const directory = await mkdtemp(join(tmpdir(), "workflowd-discovery-lifecycle-"))
    const abort = new AbortController()
    let pending: Promise<unknown> | undefined
    let pids: number[] = []
    const cancelReader = Promise.withResolvers<void>()
    const readerCancelled = Promise.withResolvers<void>()
    const readPids = async (): Promise<number[]> =>
      (await readFile(join(directory, "pids.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .flatMap((line) => Schema.decodeUnknownSync(Schema.Array(Schema.Int))(JSON.parse(line)))
    try {
      const bin = join(directory, "codex-fixture")
      await writeFile(
        bin,
        `#!${process.execPath}\nimport { runHangingCodex } from ${JSON.stringify(join(import.meta.dir, "fixtures/codex-descendants.mjs"))};\nrunHangingCodex(${JSON.stringify(directory)});\n`,
        { mode: 0o700 },
      )
      const privateKeyPath = join(directory, "github.pem")
      const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
      await writeFile(privateKeyPath, key.export({ type: "pkcs8", format: "pem" }))
      const config = await loadConfig(
        {
          GITHUB_APP_ID: "123",
          WORKFLOWD_PR_REPOSITORIES: '[{"repository":"example-owner/example","installationId":91}]',
          GITHUB_PRIVATE_KEY_PATH: privateKeyPath,
          GITHUB_WEBHOOK_SECRET: "fixture",
          OPENCODE_SERVER_PASSWORD: "fixture",
          WORKFLOWD_OPENCODE_ATTACH_URL: "http://127.0.0.1:1",
          OPENCODE_SERVER_URL: "http://127.0.0.1:1",
          WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN: "fixture-token",
          WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED: "true",
          WORKFLOWD_AGENT_RUN_CODEX_BIN: bin,
          WORKFLOWD_EXECUTION_CAPABILITIES_TIMEOUT_MS: "30000",
        },
        { home: directory },
      )
      const run = Effect.runPromiseExit(
        Effect.gen(function* () {
          const discovery = yield* Effect.serviceOption(ExecutionDiscovery)
          if (Option.isNone(discovery)) return yield* Effect.die(new Error("discovery missing"))
          if (action === "scope") return yield* discovery.value.list()
          const first = yield* Effect.forkChild(discovery.value.list())
          const second = yield* Effect.forkChild(discovery.value.list())
          yield* Effect.promise(() => cancelReader.promise)
          yield* Fiber.interrupt(first)
          readerCancelled.resolve()
          return yield* Fiber.join(second)
        }).pipe(
          Effect.provide(
            makeLiveLayer(config).pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))),
          ),
        ),
        { signal: abort.signal },
      )
      pending = run
      await waitFor(async () => {
        try {
          await access(join(directory, "ready"))
          return true
        } catch {
          return false
        }
      }, 2000)
      pids = await readPids()
      if (action === "scope") {
        abort.abort()
        const exit = await run
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      } else {
        cancelReader.resolve()
        await readerCancelled.promise
        expect(pids.every(alive)).toBe(true)
        expect(await readPids()).toHaveLength(2)
        await writeFile(join(directory, "release"), "release")
        const exit = await run
        expect(exit._tag).toBe("Success")
        if (exit._tag === "Success")
          expect(exit.value.sources.find((source) => source.kind === "codex")?.status).toBe(
            "available",
          )
      }
      await waitFor(() => pids.every((pid) => !alive(pid)), 250)
    } finally {
      abort.abort()
      cancelReader.resolve()
      // Read the fixture's PIDs even if readiness or an assertion failed.
      try {
        pids = await readPids()
      } catch {
        // The fixture may fail before recording any PIDs.
      }
      for (const pid of pids.reverse()) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // Scope finalization may already have terminated this process.
        }
      }
      await pending
      await waitFor(() => pids.every((pid) => !alive(pid)), 500)
      await rm(directory, { recursive: true, force: true })
    }
  })
