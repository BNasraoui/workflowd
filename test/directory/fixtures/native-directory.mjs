import { createInterface } from "node:readline"
import { readFileSync } from "node:fs"
// Codex 0.159.1 Thread/ThreadResumeResponse fields. Only metadata RPCs exist.
const directory = process.env.DIRECTORY_NATIVE_CWD
const mode = () =>
  process.env.DIRECTORY_NATIVE_MODE_FILE === undefined
    ? process.env.DIRECTORY_NATIVE_MODE
    : readFileSync(process.env.DIRECTORY_NATIVE_MODE_FILE, "utf8")
const thread = () => {
  const current = mode()
  const value = {
    id: "ses_resident-proof",
    cwd: current === "thread_cwd" ? "/other-resource" : directory,
    status: { type: current === "not_loaded" ? "notLoaded" : "idle" },
    canAcceptDirectInput: current === "input_unknown" ? null : current !== "input_disabled",
    turns: [],
  }
  if (current === "legacy") {
    delete value.cwd
    delete value.status
    delete value.canAcceptDirectInput
  }
  return value
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line)
  if (frame.id === undefined) return
  const handlers = {
    initialize: () => ({}),
    "thread/resume": () => ({
      thread: thread(),
      model: "same-model",
      modelProvider: "native",
      reasoningEffort: null,
      cwd: mode() === "runtime_cwd" ? "/other-resource" : directory,
    }),
    "thread/read": () => ({ thread: thread() }),
  }
  const handler = handlers[frame.method]
  process.stdout.write(
    JSON.stringify(
      handler ? { id: frame.id, result: handler() } : { id: frame.id, error: { code: -32601 } },
    ) + "\n",
  )
})
