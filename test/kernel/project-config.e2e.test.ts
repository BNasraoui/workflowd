import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runClaudeWorker } from "../../src/kernel/claude-worker"
import { runCliWorker, runCodexWorker } from "../../src/kernel/codex-worker"
import { codexProjectConfig } from "../../src/execution/project-config"
import { startAppServer } from "../../src/resident/process"
import { makeClaudeCli } from "../../src/kernel/claude-session"
import { linkedWorktree } from "./project-config-fixture"
import { Effect, Schema } from "effect"
import { nativeModelFixture } from "../sandbox/native-fixture"

for (const kind of ["claude", "codex"] as const) {
  test(`installed ${kind} excludes worktree hooks while retaining user hooks`, async () => {
    const root = await mkdtemp(join(tmpdir(), "workflowd-project-config-"))
    const home = join(root, "home")
    await mkdir(home)
    const { repository, directory } = await linkedWorktree(root)
    const fixture = await nativeModelFixture(kind, root)
    const configHome = join(home, `.${kind}`)
    await mkdir(configHome)
    await mkdir(join(directory, `.${kind}`))
    const marker = join(root, "project-hook-ran")
    const hookMarker = join(root, "project-session-hook-ran")
    const localMarker = join(root, "project-local-hook-ran")
    const mcpMarker = join(root, "project-mcp-ran")
    const userMarker = join(root, "user-hook-ran")
    const hooks = (path: string) => ({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `touch ${JSON.stringify(path)}` }] }],
      },
    })
    const file = kind === "claude" ? "settings.json" : "hooks.json"
    await writeFile(
      join(directory, `.${kind}`, file),
      JSON.stringify(hooks(kind === "codex" ? hookMarker : marker)),
    )
    await writeFile(join(configHome, file), JSON.stringify(hooks(userMarker)))
    if (kind === "claude") {
      await writeFile(
        join(directory, ".claude/settings.local.json"),
        JSON.stringify({
          ...hooks(localMarker),
          enableAllProjectMcpServers: true,
        }),
      )
      await writeFile(
        join(directory, ".mcp.json"),
        JSON.stringify({
          mcpServers: { project_fixture: { command: "/usr/bin/touch", args: [mcpMarker] } },
        }),
      )
    }
    if (kind === "codex") {
      // This CLI version resolves linked-worktree hook sources in the primary checkout.
      await mkdir(join(repository, ".codex"))
      await writeFile(join(repository, ".codex/hooks.json"), JSON.stringify(hooks(hookMarker)))
      await writeFile(
        join(configHome, "config.toml"),
        `model_reasoning_effort="high"\n[projects.${JSON.stringify(repository)}]\ntrust_level="trusted"\n[projects.${JSON.stringify(directory)}]\ntrust_level="trusted"\n`,
      )
      await writeFile(
        join(directory, ".codex", "config.toml"),
        `model_reasoning_effort="low"
[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type="command"
command=${JSON.stringify(`touch ${JSON.stringify(marker)}`)}
[mcp_servers.project_fixture]
command="/usr/bin/touch"
args=[${JSON.stringify(marker)}]
startup_timeout_sec=1
`,
      )
    }
    const binary = join(root, "isolated-cli")
    await writeFile(
      binary,
      `#!${process.execPath}\nconst child=Bun.spawn([${JSON.stringify(fixture.binary)}, ...${JSON.stringify(kind === "codex" ? ["--dangerously-bypass-hook-trust", "-c", "features.hooks=true"] : [])}, ...process.argv.slice(2)], {stdin:"inherit",stdout:"inherit",stderr:"inherit",env:{PATH:process.env.PATH,HOME:${JSON.stringify(home)},CODEX_HOME:${JSON.stringify(configHome)},CLAUDE_CONFIG_DIR:${JSON.stringify(configHome)},XDG_CONFIG_HOME:${JSON.stringify(join(home, ".config"))}}}); process.exitCode=await child.exited\n`,
      { mode: 0o700 },
    )
    const options = {
      binary,
      directory,
      promptFile: join(root, "prompt"),
      resultFile: join(root, "result"),
      eventsFile: join(root, "events"),
      stderrFile: join(root, "stderr"),
      maxOutputBytes: 1000000,
      model: "fixture-model",
    }
    await writeFile(options.promptFile, "Reply with the fixture completion.")
    try {
      // Positive control: the same installed CLI must actually execute the fixture hook.
      const command =
        kind === "claude"
          ? [
              binary,
              "--print",
              "--output-format",
              "stream-json",
              "--verbose",
              "--model",
              "fixture-model",
              "--dangerously-skip-permissions",
            ]
          : [
              binary,
              "exec",
              "--json",
              "--dangerously-bypass-approvals-and-sandbox",
              "-m",
              "fixture-model",
              "-",
            ]
      const controlExit = await runCliWorker(options, command)
      expect({
        exit: controlExit,
        stderr: await readFile(options.stderrFile, "utf8"),
      }).toMatchObject({ exit: 0 })
      expect({
        project: await Bun.file(marker).exists(),
        user: await Bun.file(userMarker).exists(),
        stderr: await readFile(options.stderrFile, "utf8"),
        events: await readFile(options.eventsFile, "utf8"),
      }).toMatchObject({ project: true, user: true })
      if (kind === "codex") {
        expect(await Bun.file(hookMarker).exists()).toBe(true)
        await rm(hookMarker)
      }
      if (kind === "claude") {
        expect(await Bun.file(localMarker).exists()).toBe(true)
        expect(await Bun.file(mcpMarker).exists()).toBe(true)
        await rm(localMarker)
        await rm(mcpMarker)
      }
      await rm(marker)
      await rm(userMarker)
      expect(await (kind === "claude" ? runClaudeWorker : runCodexWorker)(options)).toBe(0)
      expect(await readFile(options.eventsFile, "utf8")).toContain("native-fixture-complete")
      expect(await Bun.file(userMarker).exists()).toBe(true)
      expect(await Bun.file(marker).exists()).toBe(false)
      expect(await Bun.file(hookMarker).exists()).toBe(false)
      expect(await Bun.file(localMarker).exists()).toBe(false)
      expect(await Bun.file(mcpMarker).exists()).toBe(false)
      const events = (await readFile(options.eventsFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) =>
          Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(line)),
        )
      if (kind === "claude") {
        const session = Schema.decodeUnknownSync(Schema.Struct({ session_id: Schema.String }))(
          events.find((event) => event.type === "system" && event.subtype === "init"),
        )
        // Positive control on resume too: persisted sessions must not hide inert fixtures.
        expect(
          await runCliWorker(options, [
            binary,
            "-p",
            "--resume",
            session.session_id,
            "--output-format",
            "stream-json",
            "--verbose",
            "--dangerously-skip-permissions",
          ]),
        ).toBe(0)
        for (const path of [marker, localMarker, mcpMarker, userMarker]) {
          expect(await Bun.file(path).exists()).toBe(true)
          await rm(path)
        }
        const output = await Effect.runPromise(
          makeClaudeCli({ binary }).resume({
            nativeSessionId: session.session_id,
            directory,
            prompt: "Continue.",
            timeoutMs: 15000,
          }),
        )
        expect(output).toContain("native-fixture-complete")
        expect(await Bun.file(userMarker).exists()).toBe(true)
        for (const path of [marker, localMarker, mcpMarker])
          expect(await Bun.file(path).exists()).toBe(false)
      } else {
        let completion = Promise.withResolvers<unknown>()
        const server = startAppServer({ binary, home: configHome }, (frame) => {
          if (frame.method === "turn/completed") completion.resolve(frame.params)
        })
        const runTurn = async (threadId: string) => {
          completion = Promise.withResolvers<unknown>()
          const before = fixture.requests.length
          const timer = setTimeout(
            () => completion.reject(new Error("Resident turn timed out")),
            15000,
          )
          try {
            const finished = completion.promise
            await server.rpc.request("turn/start", {
              threadId,
              input: [{ type: "text", text: "Reply with the fixture completion." }],
            })
            expect(await finished).toMatchObject({ threadId, turn: { status: "completed" } })
            expect(fixture.requests.length).toBeGreaterThan(before)
            for (const path of [marker, hookMarker])
              expect(await Bun.file(path).exists()).toBe(false)
          } finally {
            clearTimeout(timer)
          }
        }
        try {
          await server.initialize()
          const params = {
            cwd: directory,
            model: "fixture-model",
            modelProvider: "fixture",
            config: {
              ...codexProjectConfig(directory),
              model_providers: {
                fixture: {
                  name: "fixture",
                  base_url: `${fixture.modelUrl}v1`,
                  wire_api: "responses",
                  requires_openai_auth: false,
                },
              },
            },
            approvalPolicy: "never",
            sandbox: "danger-full-access",
          }
          const started = await server.rpc.request("thread/start", params)
          expect(started).toMatchObject({ reasoningEffort: "high" })
          const startedThread = Schema.decodeUnknownSync(
            Schema.Struct({
              thread: Schema.Struct({ id: Schema.String }),
            }),
          )(started)
          await runTurn(startedThread.thread.id)
          const thread = Schema.decodeUnknownSync(Schema.Struct({ thread_id: Schema.String }))(
            events.find((event) => event.type === "thread.started"),
          )
          const resumed = await server.rpc.request("thread/resume", {
            ...params,
            threadId: thread.thread_id,
          })
          expect(resumed).toMatchObject({ reasoningEffort: "high" })
          await runTurn(thread.thread_id)
          expect(await Bun.file(marker).exists()).toBe(false)
        } finally {
          await server.close()
        }
      }
    } finally {
      await fixture.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
}
