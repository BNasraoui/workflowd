// A spawnable stand-in for `codex app-server --listen stdio://` that is enough
// for a resident workflowd thread: initialize, thread/start|read|queue/add|
// queue/list, and turn notifications. It launches the stdio MCP server named
// by its `-c mcp_servers.workflowd_subscriptions={...}` argv flag, as Codex
// does, and a queued message containing `SUBSCRIBE_AGENT_RUN <run id>` runs a
// scripted turn that calls subscribe_to_event before the turn completes; one
// containing `HOLD_TURN` leaves its turn in progress, like a working child.
// Every thread/queue/add is appended to $CODEX_HOME/queue-add.jsonl.
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const flag = process.argv[process.argv.indexOf("-c") + 1] ?? ""
const subscriptions =
  /^mcp_servers\.workflowd_subscriptions=\{command=("[^"]*"),args=\[(.*?)\],env_vars=\[(.*?)\]/.exec(
    flag,
  )
if (subscriptions === null || !process.argv.includes("app-server")) process.exit(2)
const mcpCommand = JSON.parse(subscriptions[1])
const mcpArgs = JSON.parse(`[${subscriptions[2]}]`)
const mcpEnvVars = JSON.parse(`[${subscriptions[3]}]`)

const threadId = `thread-${process.pid}`
const turns = []
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const notify = (method, params) => send({ method, params })

const subscribe = async (runId) => {
  const env = { PATH: process.env.PATH ?? "" }
  for (const name of mcpEnvVars) if (process.env[name] !== undefined) env[name] = process.env[name]
  const client = new Client({ name: "codex-fixture", version: "1" })
  await client.connect(new StdioClientTransport({ command: mcpCommand, args: mcpArgs, env }))
  try {
    // The caller becomes verified only after its first agent message is observed.
    const trySubscribe = async (attempt) => {
      const result = await client.callTool({
        name: "subscribe_to_event",
        arguments: { kind: "agent_run", run_id: runId },
      })
      if (result.isError !== true) return
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (attempt === 99) throw new Error("subscribe_to_event never succeeded")
      return trySubscribe(attempt + 1)
    }
    await trySubscribe(0)
  } finally {
    await client.close()
  }
}

const runTurn = async (text, clientId) => {
  const turn = {
    id: `turn-${turns.length + 1}`,
    status: "inProgress",
    items: [{ type: "userMessage", clientId }],
  }
  turns.push(turn)
  notify("turn/started", { threadId, turn: { id: turn.id, status: turn.status } })
  notify("item/completed", { threadId, item: { type: "agentMessage", text: "working" } })
  const directive = /SUBSCRIBE_AGENT_RUN (\S+)/.exec(text)
  if (directive !== null) await subscribe(directive[1])
  if (text.includes("HOLD_TURN")) return
  turn.status = "completed"
  notify("turn/completed", { threadId, turn: { id: turn.id, status: turn.status } })
}

let chain = Promise.resolve()
const handlers = {
  initialize: () => ({}),
  "thread/list": () => ({ data: [], nextCursor: null }),
  "thread/start": (params) => ({
    thread: { id: threadId },
    model: params.model ?? "fixture-model",
    ...(params.modelProvider === undefined ? {} : { modelProvider: params.modelProvider }),
    reasoningEffort: params.config?.model_reasoning_effort ?? null,
  }),
  "thread/queue/list": () => ({ data: [], nextCursor: null }),
  "thread/read": () => ({ thread: { turns } }),
  "thread/queue/add": (params) => {
    appendFileSync(
      join(process.env.CODEX_HOME ?? ".", "queue-add.jsonl"),
      `${JSON.stringify(params)}\n`,
    )
    const text = params.input.map((part) => part.text).join("")
    chain = chain
      .then(() => runTurn(text, params.clientUserMessageId))
      .catch((error) => {
        process.stderr.write(`${String(error)}\n`)
        process.exit(3)
      })
    return {}
  },
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line)
  if (frame.id === undefined) return
  const handler = handlers[frame.method]
  if (handler === undefined) {
    send({ id: frame.id, error: { code: -32601 } })
    return
  }
  send({ id: frame.id, result: handler(frame.params ?? {}) })
})
