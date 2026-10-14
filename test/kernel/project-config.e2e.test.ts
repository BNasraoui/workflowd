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
      await rm(marker)
      await rm(userMarker)
      expect(await (kind === "claude" ? runClaudeWorker : runCodexWorker)(options)).toBe(0)
      expect(await readFile(options.eventsFile, "utf8")).toContain("native-fixture-complete")
      expect(await Bun.file(userMarker).exists()).toBe(true)
      expect(await Bun.file(marker).exists()).toBe(false)
      expect(await Bun.file(hookMarker).exists()).toBe(false)
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
        const output = await Effect.runPromise(
          makeClaudeCli({ binary }).resume({
            nativeSessionId: session.session_id,
            directory,
            prompt: "Continue.",
            timeoutMs: 15000,
          }),
        )
        expect(output).toContain("native-fixture-complete")
        expect(await Bun.file(marker).exists()).toBe(false)
      } else {
        const server = startAppServer({ binary, home: configHome }, () => {})
        try {
          await server.initialize()
          const params = {
            cwd: directory,
            model: "fixture-model",
            config: codexProjectConfig(directory),
            approvalPolicy: "never",
            sandbox: "danger-full-access",
          }
          const started = await server.rpc.request("thread/start", params)
          expect(started).toMatchObject({ reasoningEffort: "high" })
          const thread = Schema.decodeUnknownSync(Schema.Struct({ thread_id: Schema.String }))(
            events.find((event) => event.type === "thread.started"),
          )
          // The exec thread uses the fixture provider; override it for this no-inference resume.
          const resumed = await server.rpc.request("thread/resume", {
            ...params,
            modelProvider: "openai",
            threadId: thread.thread_id,
          })
          expect(resumed).toMatchObject({ reasoningEffort: "high" })
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
