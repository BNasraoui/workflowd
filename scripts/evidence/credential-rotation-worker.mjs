#!/usr/bin/env bun
/* global Bun */
// Deliberately controlled process fixtures for timing, signals and byte limits.
if (process.argv.includes("--version") || process.argv.includes("status")) process.exit(0)
const stdinPrompt = await new Response(Bun.stdin.stream()).text()
const emit = (value) => console.log(JSON.stringify(value))
if (stdinPrompt === "trap") {
  Bun.spawn(["/bin/sh", "-c", 'trap "" TERM; echo child-ready; while :; do sleep 1; done'], {
    stdout: "inherit",
    stderr: "inherit",
  })
}
emit({ type: "thread.started", thread_id: `thread-${process.pid}` })
if (stdinPrompt === "partial") {
  process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"par')
  await Bun.sleep(1000)
  process.stdout.write('tial-once"}}\n')
} else emit({ type: "item.completed", item: { type: "agent_message", text: "first-output" } })
if (stdinPrompt === "limit") {
  console.log("x".repeat(11 * 1024 * 1024))
  process.stderr.write("e".repeat(11 * 1024 * 1024))
}
if (stdinPrompt === "trap") await Bun.sleep(120000)
else await Bun.sleep(stdinPrompt === "down" ? 1500 : 4000)
emit({ type: "item.completed", item: { type: "agent_message", text: "full-final-output" } })
emit({ type: "turn.completed", usage: { output_tokens: 42 } })
