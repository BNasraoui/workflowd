import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schedule } from "effect"
import { OpenCode } from "@opencode-ai/client/effect"
import { FetchHttpClient } from "effect/unstable/http"
import { DirectoryStore } from "../../src/directory/store"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import { AgentRunProvider } from "../../src/kernel/agent-run-ingress"
import { runAgentRunWatchdogIteration } from "../../src/kernel/agent-run-watchdog"
import { SdkOpenCodeAdapter, makeOpenCodeSdkClient } from "../../src/opencode/adapter"
import { WorkSignalLive } from "../../src/work-signal"
import { ResidentCodex, ResidentCodexLive } from "../../src/resident/service"
import { startAppServer } from "../../src/resident/process"
import { makeResidentStore } from "../../src/resident/store"
import { managedStores, seedManaged } from "./managed-fixture"

test("native OpenCode identity and resource mismatch cannot promote or renew directory proof", async () => {
  let id = "ses_proof"
  let cwd = "/other-resource"
  let tokens = 1
  const native = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        data: {
          id,
          projectID: "fixture",
          cost: 0,
          tokens: { input: 0, output: tokens, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          location: { directory: cwd },
        },
      }),
  })
  try {
    const adapter = new SdkOpenCodeAdapter(
      makeOpenCodeSdkClient(
        OpenCode.make({ baseUrl: native.url.toString() }).pipe(
          Effect.provide(FetchHttpClient.layer),
        ),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* DirectoryStore
        const at = new Date()
        yield* seedManaged("proof", at, native.url.toString())
        yield* directory.bindLocalHost("host-a")
        const step = () =>
          runAgentRunWatchdogIteration({
            now: () => new Date(),
            progressWindowMs: 1_200_000,
            staleAfterMs: 0,
            unsupervisedExecutorKinds: ["codex", "claude"],
          }).pipe(Effect.provideService(AgentRunProvider, adapter), Effect.provide(WorkSignalLive))
        yield* step()
        expect((yield* directory.managed(new Date(), 90_000))[0]?.deliverable).toBe(false)
        cwd = "/fixture/proof"
        id = "ses_other"
        yield* step()
        expect((yield* directory.managed(new Date(), 90_000))[0]?.deliverable).toBe(false)
        id = "ses_proof"
        yield* step()
        expect((yield* directory.managed(new Date(), 90_000))[0]?.deliverable).toBe(true)
        cwd = "/other-resource"
        tokens = 2
        yield* step()
        expect((yield* directory.managed(new Date(), 90_000))[0]?.deliverable).toBe(false)
        expect(yield* (yield* AgentRunStore).read("proof")).toMatchObject({
          state: "verified",
          attempt: 1,
        })
      }).pipe(Effect.provide(managedStores())),
    )
  } finally {
    await native.stop(true)
  }
})

test("resident directory proof requires matching native/runtime cwd and explicit loaded input availability", async () => {
  const root = await mkdtemp(join(tmpdir(), "directory-native-proof-"))
  const home = join(root, "home")
  await mkdir(home)
  const binary = join(root, "codex-fixture")
  await writeFile(
    binary,
    `#!/usr/bin/env bun\nawait import(${JSON.stringify(join(import.meta.dir, "fixtures/native-directory.mjs"))})`,
    { mode: 0o700 },
  )
  const owned: ReturnType<typeof startAppServer>[] = []
  try {
    for (const mode of [
      "thread_cwd",
      "runtime_cwd",
      "not_loaded",
      "input_disabled",
      "input_unknown",
      "legacy",
      "good",
    ]) {
      const modeFile = join(root, "native-mode")
      if (mode === "good") await writeFile(modeFile, "good")
      const start: typeof startAppServer = (options, notify) => {
        const child = startAppServer(
          {
            ...options,
            env: {
              ...options.env,
              DIRECTORY_NATIVE_MODE: mode,
              DIRECTORY_NATIVE_CWD: home,
              ...(mode === "good" ? { DIRECTORY_NATIVE_MODE_FILE: modeFile } : {}),
            },
          },
          notify,
        )
        owned.push(child)
        return child
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const directory = yield* DirectoryStore
          yield* directory.bindLocalHost("host-a")
          yield* seedManaged("resident-proof", new Date(), "codex-cli://host-a", "codex", home)
          yield* (yield* makeResidentStore).attach(
            "resident-proof",
            "ses_resident-proof",
            home,
            "same-model",
          )
          const resident = ResidentCodexLive(
            { home, socket: join(root, "resident.sock"), directoryRefreshMs: 1 },
            binary,
            {
              token: "inert",
              repositories: [],
              servers: [],
              auth: { mode: "token", token: "inert" },
            },
            start,
          )
          yield* Effect.gen(function* () {
            yield* ResidentCodex
            expect((yield* directory.managed(new Date(), 90_000))[0]?.deliverable).toBe(
              mode === "good",
            )
            if (mode === "good") {
              const initial = (yield* directory.managed(new Date(), 90_000))[0]
              const awaitProof = (deliverable: boolean) =>
                directory.managed(new Date(), 90_000).pipe(
                  Effect.flatMap((rows) =>
                    rows[0]?.deliverable === deliverable
                      ? Effect.succeed(rows[0])
                      : Effect.fail(new Error("Await native proof change")),
                  ),
                  Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 300 }),
                )
              yield* Effect.promise(() => writeFile(modeFile, "not_loaded"))
              expect(yield* awaitProof(false)).toMatchObject({
                recipientId: initial?.recipientId,
                status: "unavailable",
                observedAt: initial?.observedAt,
              })
              yield* Effect.promise(() => writeFile(modeFile, "good"))
              const refreshed = yield* awaitProof(true)
              expect(refreshed?.recipientId).toBe("managed:host-a:resident-proof")
              expect(Date.parse(refreshed?.observedAt ?? "")).toBeGreaterThan(
                Date.parse(initial?.observedAt ?? ""),
              )
            }
            expect(yield* (yield* AgentRunStore).read("resident-proof")).toMatchObject({
              state: "verified",
              attempt: 1,
            })
          }).pipe(Effect.provide(resident))
          expect((yield* directory.managed(new Date(), 90_000))[0]?.deliverable).toBe(false)
        }).pipe(Effect.provide(managedStores())),
      )
    }
  } finally {
    await Promise.all(owned.map((child) => child.close()))
    await rm(root, { recursive: true, force: true })
  }
})
