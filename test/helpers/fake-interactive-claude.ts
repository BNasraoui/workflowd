#!/usr/bin/env bun
// Unit-test stand-in for Claude Code's normal interactive interface: a PTY-only
// program that enables bracketed paste, accepts one pasted prompt submitted with
// Enter, runs its configured command hooks, appends a transcript and exits on a
// confirmed EOF. It never contacts a model. Print/headless switches are refused.
import { appendFile, mkdir, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"

const args = process.argv.slice(2)
if (args[0] === "--version") {
  console.log("2.1.301 (Claude Code)")
  process.exit(0)
}
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(3)
if (args.some((value) => ["-p", "--print", "--output-format", "--input-format"].includes(value)))
  process.exit(4)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const resume = option("--resume")
const session = resume ?? option("--session-id") ?? ""
const settings = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      hooks: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Array(
            Schema.Struct({ hooks: Schema.Array(Schema.Struct({ command: Schema.String })) }),
          ),
        ),
      ),
    }),
  ),
)(option("--settings") ?? "{}")
const mode = process.env.FAKE_CLAUDE_MODE ?? "normal"
const record = process.env.FAKE_CLAUDE_RECORD
if (record !== undefined)
  await writeFile(
    record,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      sandboxed: process.env.CLAUDE_CODE_SANDBOXED,
      git: process.env.GIT_AUTHOR_EMAIL,
    }),
  )
const configDirectory = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
const project = join(configDirectory, "projects", process.cwd().replace(/[^A-Za-z0-9-]/g, "-"))
if (mode === "symlink-project") {
  await mkdir(`${project}-elsewhere`, { recursive: true })
  await symlink(`${project}-elsewhere`, project).catch(() => undefined)
} else await mkdir(project, { recursive: true })
const transcript = join(project, `${session}.jsonl`)
const hook = async (name: string, input: Record<string, unknown>) => {
  for (const group of settings.hooks?.[name] ?? [])
    for (const entry of group.hooks) {
      const child = Bun.spawn(["/bin/sh", "-c", entry.command], {
        stdin: new Blob([
          JSON.stringify({ session_id: session, transcript_path: transcript, ...input }),
        ]),
        stdout: "ignore",
        stderr: "ignore",
      })
      await child.exited
    }
}

process.stdin.setRawMode(true)
const decoder = new TextDecoder()
const eof = (text: string) => [...text].filter((character) => character === "\x04").length
let input = ""
let pasted = false
let eofs = 0
const submitted = Promise.withResolvers<string>()
const exit = Promise.withResolvers<void>()
process.stdin.on("data", (bytes: Buffer) => {
  const text = decoder.decode(bytes, { stream: true })
  if (pasted) eofs += eof(text)
  else {
    // Keystrokes before a complete paste+Enter accumulate; nothing else is input.
    input += text
    const start = input.indexOf("\x1b[200~")
    const end = start === -1 ? -1 : input.indexOf("\x1b[201~", start)
    if (end !== -1 && input[end + 6] === "\r") {
      pasted = true
      submitted.resolve(input.slice(start + 6, end))
      eofs += eof(input.slice(end + 7))
    }
  }
  if (eofs >= 2 && mode !== "ignore-eof") exit.resolve()
})
process.stdin.on("end", () => {
  if (mode !== "ignore-eof") exit.resolve()
})
process.stdout.write("\x1b[2J\x1b[1mfake claude\x1b[0m starting\r\n")

if (mode === "no-start") await new Promise(() => setInterval(() => {}, 1000))
await hook("SessionStart", {
  hook_event_name: "SessionStart",
  source: resume ? "resume" : "startup",
  model: option("--model") ?? "fixture-default",
  ...(mode === "foreign-transcript"
    ? { transcript_path: join(configDirectory, "projects", "..", "x", `${session}.jsonl`) }
    : {}),
})
if (mode === "hang") {
  // A same-group descendant proves the owned process group is reaped, not just signalled.
  const descendant = Bun.spawn(["/bin/sleep", "300"], { stdin: "ignore" })
  if (process.env.FAKE_CLAUDE_DESCENDANT)
    await writeFile(process.env.FAKE_CLAUDE_DESCENDANT, String(descendant.pid))
  await new Promise(() => setInterval(() => {}, 1000))
}
if (mode === "exit-early") process.exit(7)
// Ready for input: the only point at which a prompt may be pasted.
process.stdout.write("\x1b[?2004h> ")
const prompt = await submitted.promise
await hook("UserPromptSubmit", {
  hook_event_name: "UserPromptSubmit",
  prompt: mode === "different-prompt" ? `${prompt} (altered)` : prompt,
})
if (mode === "permission") {
  await hook("PermissionRequest", { hook_event_name: "PermissionRequest", tool_name: "Bash" })
  await new Promise(() => setInterval(() => {}, 1000))
}
let answer = `fixture:${prompt}`
let failure: string | undefined
if (process.env.FAKE_CLAUDE_SCRIPT !== undefined) {
  const child = Bun.spawn(["/bin/sh", "-c", process.env.FAKE_CLAUDE_SCRIPT], {
    env: { ...process.env, PROMPT: prompt },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  answer = stdout
  if (status !== 0) failure = `fixture_failure: ${stderr.trim()}`
}
await appendFile(
  transcript,
  JSON.stringify({ type: "user", sessionId: session, message: { role: "user", content: prompt } }) +
    "\n",
)
if (failure !== undefined) {
  await hook("StopFailure", { hook_event_name: "StopFailure", error: failure })
} else {
  for (const [id, text] of [
    ["msg_fixture_1", ""],
    ["msg_fixture_2", answer],
  ] as const) {
    const line = Buffer.from(
      JSON.stringify({
        type: "assistant",
        sessionId: session,
        message: {
          id,
          role: "assistant",
          model: option("--model") ?? "fixture-default",
          content:
            text === ""
              ? [{ type: "tool_use", name: "Bash", input: {} }]
              : [{ type: "text", text }],
          usage: { output_tokens: 3 },
        },
      }) + "\n",
    )
    if (mode === "split-utf8" && text !== "") {
      // Split inside a multibyte character so a reader sees two separate appends.
      const cut = line.indexOf(Buffer.from("😀")) + 2
      await appendFile(transcript, line.subarray(0, cut))
      await Bun.sleep(400)
      await appendFile(transcript, line.subarray(cut))
    } else await appendFile(transcript, line)
  }
  await hook("Stop", {
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: answer,
  })
  if (mode === "stop-then-failure")
    await hook("StopFailure", { hook_event_name: "StopFailure", error: "late_failure" })
}
await exit.promise
process.exit(0)
