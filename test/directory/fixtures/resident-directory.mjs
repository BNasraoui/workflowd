import { createInterface } from "node:readline"

// Read-only native protocol fixture: no turn or queue command can succeed.
let cwd
const thread = () => ({
  id: "thread",
  cwd,
  status: { type: "idle" },
  canAcceptDirectInput: true,
  turns: [],
})
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line)
  if (frame.id === undefined) return
  const handlers = {
    initialize: () => ({}),
    "thread/resume": () => {
      cwd = frame.params.cwd
      return { thread: thread(), cwd, model: "same-model", modelProvider: "native" }
    },
    "thread/read": () => ({ thread: thread() }),
  }
  const handler = handlers[frame.method]
  process.stdout.write(
    JSON.stringify(
      handler === undefined
        ? { id: frame.id, error: { code: -32601 } }
        : { id: frame.id, result: handler() },
    ) + "\n",
  )
})
