import { expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { parseClaudeDispatchEvent } from "../../src/kernel/claude-dispatch"
import {
  admitClaudePrompt,
  claudeInteractiveArguments,
  claudeInteractiveSettings,
  runClaudeInteractiveTurn,
} from "../../src/kernel/claude-interactive"
import { claudeProjectArguments } from "../../src/execution/project-config"
import { makeClaudeCli } from "../../src/kernel/claude-session"
import { runClaudeInteractiveWorker } from "../../src/kernel/codex-worker"

const Invocation = Schema.Struct({
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  sandboxed: Schema.String,
})
const fake = resolve(import.meta.dir, "../helpers/fake-interactive-claude.ts")
const onboarded = '{"hasCompletedOnboarding":true,"theme":"dark"}'
// Reaped means gone from /proc: a zombie still has an entry and is not proof of a join.
const reaped = (pid: number) => access(`/proc/${pid}`).then(
  () => false,
  () => true,
)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-interactive-"))
  const directory = join(root, "workspace")
  const config = join(root, "config")
  await mkdir(directory)
  await mkdir(config)
  // Explicit synthetic-fixture onboarding; production turns never write it.
  await writeFile(join(config, ".claude.json"), onboarded)
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: config,
    FAKE_CLAUDE_RECORD: join(root, "invocation.json"),
  }
  const files = {
    binary: fake,
    directory,
    promptFile: join(root, "prompt"),
    resultFile: join(root, "result"),
    eventsFile: join(root, "events"),
    stderrFile: join(root, "stderr"),
    maxOutputBytes: 65536,
    model: "claude-opus-4-6",
    effort: "high",
  }
  const reset = () =>
    Promise.all(
      [files.resultFile, files.eventsFile, files.stderrFile, `${files.stderrFile}.hooks`].map(
        (path) => rm(path, { force: true }),
      ),
    )
  return {
    root,
    config,
    env,
    files,
    reset,
    close: () => rm(root, { recursive: true, force: true }),
    invocation: async () =>
      Schema.decodeUnknownSync(Schema.fromJsonString(Invocation))(
        await readFile(env.FAKE_CLAUDE_RECORD, "utf8"),
      ),
    turn: async (
      env: Record<string, string | undefined>,
      extra: { prompt?: string; signal?: AbortSignal; deadline?: number; hooks?: string } = {},
    ) => {
      const session = crypto.randomUUID()
      return runClaudeInteractiveTurn({
        args: await claudeInteractiveArguments(files, { id: session, resume: false }),
        prompt: extra.prompt ?? "hold",
        directory,
        session,
        env,
        hooksPath: extra.hooks ?? join(root, `${session}.hooks`),
        ...(extra.signal === undefined ? {} : { signal: extra.signal }),
        ...(extra.deadline === undefined ? {} : { deadline: extra.deadline }),
      })
    },
  }
}

const dispatchEvents = async (path: string) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map(parseClaudeDispatchEvent)
    .filter((event) => event.type !== "other")

test("a dispatched turn pastes its prompt into the PTY and keeps the stream-event contract", async () => {
  const run = await fixture()
  try {
    const prompt = "Reply;\n$(touch injected) `id` && 'quoted' é"
    await writeFile(run.files.promptFile, prompt)
    const session = { id: crypto.randomUUID(), resume: false }
    expect(await runClaudeInteractiveWorker(run.files, session, undefined, run.env)).toBe(0)
    const invocation = await run.invocation()
    // The native argv is exactly the selected policy: no prompt, separator or print switch.
    expect(invocation.args).toEqual(
      (await claudeInteractiveArguments(run.files, session)).slice(1),
    )
    expect(invocation.args.join("\n")).not.toContain("touch injected")
    expect(invocation.args).toContain("--dangerously-skip-permissions")
    expect(invocation.args.slice(-2)).toEqual(["--session-id", session.id])
    expect(JSON.parse(claudeInteractiveSettings).env).toEqual({
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    })
    expect(invocation.cwd).toBe(run.files.directory)
    expect(invocation.sandboxed).toBe("1")
    expect(await stat(join(run.files.directory, "injected")).catch(() => null)).toBeNull()
    expect(JSON.parse(await readFile(run.files.resultFile, "utf8"))).toEqual({
      version: 1,
      exitCode: 0,
    })
    expect(await readFile(run.files.eventsFile, "utf8")).toContain('"type":"user"')
    expect(await dispatchEvents(run.files.eventsFile)).toEqual([
      { type: "thread.started", threadId: session.id, model: "claude-opus-4-6" },
      { type: "agent_message", text: "[tool_use:Bash]" },
      { type: "agent_message", text: `fixture:${prompt}` },
      { type: "turn.completed", outputTokens: 6 },
    ])
    expect((await stat(`${run.files.stderrFile}.hooks`)).mode & 0o777).toBe(0o600)
    expect(await readFile(join(run.config, ".claude.json"), "utf8")).toBe(onboarded)
  } finally {
    await run.close()
  }
}, 30000)

test("a resumed turn keeps the user policy and returns only this turn's answer", async () => {
  const run = await fixture()
  try {
    const id = crypto.randomUUID()
    const project = join(run.config, "projects", run.files.directory.replace(/[^A-Za-z0-9-]/g, "-"))
    await mkdir(project, { recursive: true })
    await writeFile(
      join(project, `${id}.jsonl`),
      JSON.stringify({
        type: "assistant",
        sessionId: id,
        message: { id: "earlier", content: [{ type: "text", text: "earlier answer" }] },
      }) + "\n",
    )
    const prompt = "Resume exactly once.\n" + "x".repeat(200_000)
    await writeFile(run.files.promptFile, prompt)
    const resumed = { ...run.files, model: null, maxOutputBytes: 1024 * 1024 }
    expect(await runClaudeInteractiveWorker(resumed, { id, resume: true }, 20000, run.env)).toBe(0)
    const invocation = await run.invocation()
    expect(invocation.args).toEqual([
      "--settings",
      claudeInteractiveSettings,
      ...claudeProjectArguments,
      "--resume",
      id,
    ])
    expect(JSON.parse(await readFile(run.files.eventsFile, "utf8"))).toMatchObject({
      type: "result",
      is_error: false,
      result: `fixture:${prompt}`,
    })
  } finally {
    await run.close()
  }
}, 30000)

test("native failures, contradictions and interactive questions never complete a turn", async () => {
  const run = await fixture()
  try {
    await writeFile(run.files.promptFile, "fail")
    const session = { id: crypto.randomUUID(), resume: false }
    const failing = { ...run.env, FAKE_CLAUDE_SCRIPT: "echo rate limited >&2; exit 9" }
    expect(await runClaudeInteractiveWorker(run.files, session, undefined, failing)).not.toBe(0)
    expect((await dispatchEvents(run.files.eventsFile)).at(-1)).toEqual({
      type: "turn.failed",
      message: "fixture_failure: rate limited",
    })
    expect(await readFile(run.files.stderrFile, "utf8")).toStartWith(
      "fixture_failure: rate limited\n",
    )
    expect(JSON.parse(await readFile(run.files.resultFile, "utf8")).exitCode).not.toBe(0)

    await run.reset()
    const contradicted = { ...run.env, FAKE_CLAUDE_MODE: "stop-then-failure" }
    expect(await runClaudeInteractiveWorker(run.files, session, undefined, contradicted)).not.toBe(
      0,
    )
    expect((await dispatchEvents(run.files.eventsFile)).at(-1)).toMatchObject({
      type: "turn.failed",
    })

    for (const [mode, failure] of [
      ["different-prompt", "Claude received a different prompt than was submitted"],
      ["permission", "Claude asked an interactive PermissionRequest question (Bash)"],
      ["foreign-transcript", "Claude transcript is not this session's transcript"],
      ["symlink-project", "Claude transcript directory is not a real directory"],
      ["exit-early", "Claude exited 7 without a completed turn"],
    ] as const) {
      const outcome = await run.turn({ ...run.env, FAKE_CLAUDE_MODE: mode })
      expect({ mode, completed: outcome.completed, failure: outcome.failure }).toEqual({
        mode,
        completed: false,
        failure,
      })
      expect(outcome.exitCode).not.toBe(0)
    }
  } finally {
    await run.close()
  }
}, 60000)

test("deadline and cancellation reap the whole owned process group before returning", async () => {
  const run = await fixture()
  try {
    for (const stop of ["deadline", "signal"] as const) {
      const marker = join(run.root, `${stop}.pid`)
      const controller = new AbortController()
      const turn = run.turn(
        { ...run.env, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DESCENDANT: marker },
        { signal: controller.signal, ...(stop === "deadline" ? { deadline: Date.now() + 1500 } : {}) },
      )
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await stat(marker).catch(() => null)) break
        await Bun.sleep(50)
      }
      const descendant = Number(await readFile(marker, "utf8"))
      expect(await reaped(descendant)).toBe(false)
      if (stop === "signal") controller.abort()
      const outcome = await turn
      expect(outcome.completed).toBe(false)
      expect(outcome.exitCode).not.toBe(0)
      expect(outcome.failure).toBe(
        stop === "signal"
          ? "Claude interactive turn was cancelled"
          : "Claude interactive turn did not finish before its deadline",
      )
      // The helper confirmed an empty group, so the same-group descendant was reaped.
      expect(await reaped(descendant)).toBe(true)
    }
  } finally {
    await run.close()
  }
}, 30000)

test("lost capture is sticky and split UTF-8 records are decoded intact", async () => {
  const run = await fixture()
  try {
    await writeFile(run.files.promptFile, "split")
    const session = { id: crypto.randomUUID(), resume: false }
    const split = { ...run.env, FAKE_CLAUDE_SCRIPT: "printf 'é😀 done'", FAKE_CLAUDE_MODE: "split-utf8" }
    expect(await runClaudeInteractiveWorker(run.files, session, undefined, split)).toBe(0)
    expect(await dispatchEvents(run.files.eventsFile)).toContainEqual({
      type: "agent_message",
      text: "é😀 done",
    })

    // Room for the final record only: ordinary records are lost, so success is refused.
    await run.reset()
    const small = { ...run.files, maxOutputBytes: 4096 + 64 }
    expect(await runClaudeInteractiveWorker(small, session, undefined, run.env)).toBe(1)
    expect((await dispatchEvents(run.files.eventsFile)).at(-1)).toEqual({
      type: "turn.failed",
      message: "Claude output capacity",
    })
  } finally {
    await run.close()
  }
}, 30000)

test("acquisition failures and inadmissible prompts launch nothing", async () => {
  const run = await fixture()
  try {
    const hooks = join(run.root, "taken.hooks")
    await writeFile(hooks, "")
    await expect(run.turn(run.env, { hooks })).rejects.toThrow()
    expect(await stat(run.env.FAKE_CLAUDE_RECORD).catch(() => null)).toBeNull()

    const session = crypto.randomUUID()
    const missing = await runClaudeInteractiveTurn({
      args: [join(run.root, "missing-claude")],
      prompt: "never",
      directory: run.files.directory,
      session,
      env: run.env,
      hooksPath: join(run.root, "missing.hooks"),
    })
    expect(missing.completed).toBe(false)
    expect(missing.failure).toBe("Claude launch failed (FileNotFoundError)")

    await writeFile(join(run.config, ".claude.json"), '{"theme":"light"}')
    await expect(run.turn(run.env)).rejects.toThrow("onboarding is incomplete")
    await rm(join(run.config, ".claude.json"))
    await expect(run.turn(run.env)).rejects.toThrow("onboarding is incomplete")
    expect(await stat(join(run.config, ".claude.json")).catch(() => null)).toBeNull()
    expect(await stat(run.env.FAKE_CLAUDE_RECORD).catch(() => null)).toBeNull()

    // The agent-host admitted bound is preserved; only key-like controls are refused.
    expect(admitClaudePrompt("x".repeat(262_144))).toHaveLength(262_144)
    expect(admitClaudePrompt("a\r\nb\tc")).toBe("a\nb\tc")
    expect(() => admitClaudePrompt("x".repeat(262_145))).toThrow("admitted size")
    for (const control of ["\x1b[201~", "\x03", "\x7f", "\u009b"])
      expect(() => admitClaudePrompt(`task ${control}`)).toThrow("control characters")
  } finally {
    await run.close()
  }
}, 30000)

test("the local resume port keeps its identity and a bounded, joined timeout", async () => {
  const run = await fixture()
  const saved = { ...process.env }
  try {
    Object.assign(process.env, run.env, { FAKE_CLAUDE_SCRIPT: 'printf "%s" "$GIT_AUTHOR_EMAIL"' })
    const git = { name: "Agent", email: "agent@example.test", blockedEmails: [] }
    const cli = makeClaudeCli({ binary: fake, git })
    const input = {
      nativeSessionId: crypto.randomUUID(),
      directory: run.files.directory,
      prompt: "identity",
      timeoutMs: 20000,
    }
    expect(JSON.parse(await Effect.runPromise(cli.resume(input)))).toEqual({
      type: "result",
      is_error: false,
      result: "agent@example.test",
    })
    const marker = join(run.root, "timeout.pid")
    Object.assign(process.env, { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DESCENDANT: marker })
    const failed = await Effect.runPromise(
      cli.resume({ ...input, timeoutMs: 1500 }).pipe(Effect.result),
    )
    expect(failed._tag).toBe("Failure")
    // The interrupted resume returned only after its helper reaped the whole group.
    expect(await reaped(Number(await readFile(marker, "utf8")))).toBe(true)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await run.close()
  }
}, 30000)
