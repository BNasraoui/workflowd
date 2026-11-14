import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { nativeModelFixture } from "../sandbox/native-fixture"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { parseClaudeDispatchEvent } from "../../src/kernel/claude-dispatch"

test("production interactive worker retains durable dispatch events from normal CLI transcripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "interactive-worker-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  const fixture = await nativeModelFixture("claude", root)
  await writeFile(join(root, "prompt"), "Reply with the synthetic fixture result")
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("test/helpers/interactive-dispatch-worker.ts"),
        "--binary",
        fixtureExecutable("claude"),
        "--directory",
        directory,
        "--prompt-file",
        join(root, "prompt"),
        "--result-file",
        join(root, "result"),
        "--events-file",
        join(root, "events"),
        "--stderr-file",
        join(root, "stderr"),
        "--max-output-bytes",
        "1048576",
        "--model",
        "claude-opus-4-6",
      ],
      {
        env: { ...process.env, WORKFLOWD_FIXTURE_UPSTREAM: fixture.modelUrl },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(JSON.parse(await readFile(join(root, "result"), "utf8"))).toEqual({
      version: 1,
      exitCode: 0,
    })
    const events = (await readFile(join(root, "events"), "utf8"))
      .trim()
      .split("\n")
      .map(parseClaudeDispatchEvent)
    expect(events.find((event) => event.type === "thread.started")).toMatchObject({
      model: "claude-opus-4-6",
    })
    expect(events.find((event) => event.type === "agent_message")).toMatchObject({
      text: "native-fixture-complete",
    })
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" })
    expect(fixture.requests.length).toBeGreaterThan(0)
  } finally {
    await fixture.close()
    await rm(root, { recursive: true, force: true })
  }
}, 45000)

test("production interactive host worker retains real native session history across a resumed wake", async () => {
  const root = await mkdtemp(join(tmpdir(), "interactive-host-worker-"))
  const directory = join(root, "workspace")
  const home = join(root, "home")
  await mkdir(directory)
  await mkdir(home)
  const fixture = await nativeModelFixture("claude", root)
  const worker = join(root, "worker.js")
  try {
    const build = await Bun.build({
      entrypoints: [resolve("test/helpers/interactive-host-worker.ts")],
      target: "bun",
    })
    expect(build.success).toBe(true)
    await writeFile(worker, await build.outputs[0]!.text())
    await writeFile(
      join(root, "interactive-input.json"),
      JSON.stringify({
        binary: fixtureExecutable("claude"),
        baseUrl: fixture.modelUrl,
        hostNetns: process.env.WORKFLOWD_FIXTURE_HOST_NETNS,
        uid: process.getuid!(),
        identity: {},
      }),
    )
    let session: string | undefined
    for (const profile of ["claude", "claude-session", "claude-resume"] as const) {
      const io = join(root, profile)
      await mkdir(io)
      const input = join(io, "input")
      const prompt =
        profile === "claude" ? "Initial native host fixture turn." : "Resume exactly once."
      await writeFile(
        input,
        JSON.stringify({
          operation: "start",
          profile,
          runId: profile,
          directory,
          model: "claude-opus-4-6",
          prompt,
          ...(session ? { nativeSessionId: session } : {}),
        }),
      )
      const child = Bun.spawn(
        [process.execPath, worker, "--host-input", input, "--binary", fixtureExecutable("claude")],
        {
          cwd: io,
          env: { ...process.env, HOME: home },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" })
      const events = await readFile(join(io, "events"), "utf8")
      if (profile === "claude") {
        const started = events
          .trim()
          .split("\n")
          .map(parseClaudeDispatchEvent)
          .find((event) => event.type === "thread.started")
        expect(started?.type).toBe("thread.started")
        if (started?.type !== "thread.started") throw new Error("Native session missing")
        session = started.threadId
      } else if (profile === "claude-session") expect(events).toBe("true")
      else
        expect(JSON.parse(events)).toMatchObject({
          type: "result",
          is_error: false,
          result: "native-fixture-complete",
          session_id: session,
        })
      expect(JSON.parse(await readFile(join(io, "result"), "utf8"))).toEqual({
        version: 1,
        exitCode: 0,
      })
    }
    const main = fixture.requests.filter((_, index) => fixture.catalogs[index]!.length > 0)
    expect(main).toHaveLength(2)
    expect(JSON.stringify(main.at(-1)).split("Initial native host fixture turn.")).toHaveLength(2)
    expect(JSON.stringify(main.at(-1)).split("Resume exactly once.")).toHaveLength(2)
  } finally {
    await fixture.close()
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
