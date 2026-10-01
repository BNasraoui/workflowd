import { expect, test } from "bun:test"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { makeCodexCli } from "../../src/kernel/codex-session"
import { makeClaudeDispatchCli } from "../../src/kernel/claude-dispatch"
import {
  AgentRunIngress,
  AgentRunIngressLive,
  agentRunIdentifiers,
} from "../../src/kernel/agent-run-ingress"
import { AgentRunStore } from "../../src/kernel/agent-run-store"
import {
  at,
  defaultState,
  makeLayer,
  makeProvider,
  register,
  worktrees,
} from "./agent-run-ingress-harness"

for (const kind of ["codex", "claude"] as const)
  for (const boundary of [
    "inspection_throw",
    "inspection_exit",
    "launch_throw",
    "launch_exit",
    "launch_timeout",
    "launch_delayed",
  ] as const)
    test(`${kind} retains manifest and spawning row through ${boundary}, then recovers/cancels the same native execution`, async () => {
      const root = await mkdtemp(join(tmpdir(), "ccw2-uncertain-"))
      let child: ReturnType<typeof Bun.spawn> | undefined
      let healthy = false,
        launchCount = 0,
        description = ""
      const launched = Promise.withResolvers<void>()
      const releaseLaunch = Promise.withResolvers<void>()
      const completion = Promise.withResolvers<void>()
      try {
        const binary = join(root, "native-fixture")
        await writeFile(
          binary,
          "#!/usr/bin/env bun\nconsole.log(JSON.stringify({loggedIn:true}));\n",
          { mode: 0o700 },
        )
        const runCommand = async (command: ReadonlyArray<string>) => {
          if (command[0] === "systemd-run") {
            launchCount += 1
            try {
              if (boundary === "launch_delayed") await releaseLaunch.promise
              description =
                command.find((part) => part.startsWith("--description="))?.slice(14) ?? ""
              child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              })
              const eventsPath = command[command.indexOf("--events-file") + 1]
              if (eventsPath === undefined) throw new Error("fixture missing event path")
              const events =
                kind === "codex"
                  ? [
                      { type: "thread.started", thread_id: "native-thread" },
                      { type: "item.completed", item: { type: "agent_message", text: "fixture" } },
                    ]
                  : [
                      {
                        type: "system",
                        subtype: "init",
                        session_id: "native-thread",
                        model: "native-model",
                      },
                      {
                        type: "assistant",
                        message: { content: [{ type: "text", text: "fixture" }] },
                      },
                    ]
              await writeFile(
                eventsPath,
                events.map((event) => JSON.stringify(event)).join("\n") + "\n",
              )
              if (boundary === "launch_throw") throw new Error("launch acknowledgement lost")
              if (boundary === "launch_exit")
                return { exitCode: 1, stdout: "", stderr: "launch acknowledgement failed" }
              if (boundary === "launch_timeout") await Bun.sleep(40)
              return { exitCode: 0, stdout: "", stderr: "" }
            } finally {
              launched.resolve()
            }
          }
          if (command.includes("show-environment")) return { exitCode: 0, stdout: "", stderr: "" }
          if (command.includes("stop") || command.includes("kill")) {
            if (child !== undefined && child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL")
              await child.exited
            }
            return { exitCode: 0, stdout: "", stderr: "" }
          }
          if (!healthy) {
            if (boundary === "inspection_exit")
              return { exitCode: 1, stdout: "", stderr: "manager observation unavailable" }
            throw new Error("manager observation unavailable")
          }
          if (child === undefined)
            return {
              exitCode: 1,
              stdout: "LoadState=not-found\nActiveState=inactive\n",
              stderr: "",
            }
          return {
            exitCode: 0,
            stdout: `LoadState=loaded\nMainPID=${child?.pid ?? 0}\nInvocationID=native-invocation\nDescription=${description}\nActiveState=${child?.exitCode === null && child.signalCode === null ? "active" : "inactive"}\nResult=success\n`,
            stderr: "",
          }
        }
        const cli = (kind === "codex" ? makeCodexCli : makeClaudeDispatchCli)({
          binary,
          custodyRoot: root,
          commandTimeoutMs:
            boundary === "launch_timeout" || boundary === "launch_delayed" ? 15 : 1000,
          cancellationGraceMs: 100,
          pollIntervalMs: 2,
          runCommand,
        })
        const options = {
          routes: [],
          codexRoutes: kind === "codex" ? [{ name: "native", modelID: "native-model" }] : [],
          claudeRoutes: kind === "claude" ? [{ name: "native", modelID: "native-model" }] : [],
          repositories: [{ name: "workflowd", directory: root }],
          agent: "build",
          worktreeRoot: root,
          verifyTimeoutMs: 100,
          verifyPollIntervalMs: 5,
          progressWindowMs: 1000,
          maxAttempts: 3,
          claudeHosts: [],
          identity: {
            owningHostId: "mint",
            providerId: "opencode-primary",
            serverId: "opencode-primary",
            endpointAlias: "local",
            endpointIdentity: "http://127.0.0.1:4096",
            providerVersion: 1,
          },
        }
        const input = {
          route: "native",
          repository: "workflowd",
          prompt: "inert fixture",
          idempotencyKey: "uncertain",
        }
        const id = agentRunIdentifiers({
          route: "native",
          repository: "workflowd",
          prompt: input.prompt,
          parentSessionId: null,
          resumePrompt: null,
          idempotencyKey: input.idempotencyKey,
        }).runId
        await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* AgentRunStore
            const observedStore = {
              ...store,
              operatorRequired: (input: Parameters<typeof store.operatorRequired>[0]) =>
                store.operatorRequired(input).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      if (!input.diagnostic.includes("_recovery_failed")) completion.resolve()
                    }),
                  ),
                ),
            }
            const first = yield* register(input).pipe(Effect.result)
            expect(first._tag).toBe("Failure")
            if (boundary !== "launch_delayed") {
              expect(child?.exitCode).toBeNull()
              expect(child?.signalCode).toBeNull()
            }
            expect((yield* store.read(id))?.state).toBe("spawning")
            expect(
              yield* Effect.promise(() =>
                access(join(root, id, "manifest.json")).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(true)
            const duplicate = yield* register(input).pipe(Effect.result)
            expect(duplicate._tag).toBe("Failure")
            expect(launchCount).toBe(1)
            if (boundary === "launch_delayed") {
              healthy = true
              yield* Effect.gen(function* () {
                yield* AgentRunIngress
                expect((yield* store.read(id))?.state).toBe("operator_required")
                const duplicate = yield* register(input).pipe(Effect.result)
                expect(duplicate._tag).toBe("Failure")
              }).pipe(Effect.provide(AgentRunIngressLive(options)))
              releaseLaunch.resolve()
            }
            yield* Effect.promise(() => launched.promise)
            healthy = true
            yield* Effect.gen(function* () {
              const ingress = yield* AgentRunIngress
              expect((yield* store.read(id))?.state).toBe(
                boundary === "launch_delayed" ? "operator_required" : "verified",
              )
              yield* ingress.cancel(id, at)
            }).pipe(
              Effect.provide(AgentRunIngressLive(options)),
              Effect.provideService(AgentRunStore, observedStore),
            )
            if (boundary !== "launch_delayed") yield* Effect.promise(() => completion.promise)
            expect((yield* store.read(id))?.state).toBe("cancelled")
            expect(launchCount).toBe(1)
            expect(child?.signalCode).toBe("SIGKILL")
            const manifest = yield* Effect.promise(() =>
              readFile(join(root, id, "manifest.json"), "utf8"),
            )
            expect(JSON.parse(manifest).invocationId).toBe("native-invocation")
          }).pipe(
            Effect.provide(
              makeLayer(
                makeProvider(defaultState()),
                worktrees([]),
                kind === "codex" ? cli : undefined,
                options,
                kind === "claude" ? cli : undefined,
              ),
            ),
          ),
        )
      } finally {
        releaseLaunch.resolve()
        if (launchCount > 0) await launched.promise
        if (child !== undefined) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
          await child.exited
        }
        await rm(root, { recursive: true, force: true })
      }
    })
