#!/usr/bin/env bun
import { createInterface } from "node:readline"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

type Turn = { id: string; status: string; items: Array<{ type: string; clientId: string }> }
export type FakeThread = { turns: Turn[] }
const home = process.env.CODEX_HOME
if (home === undefined) throw new Error("CODEX_HOME required")
const path = join(home, "fixture-thread.json")
await mkdir(home, { recursive: true })
const thread: FakeThread = await readFile(path, "utf8").then(JSON.parse, () => ({ turns: [] }))
let startedHere = false
const save = () => writeFile(path, JSON.stringify(thread))
let send: (frame: unknown) => void = (frame) => {
  process.stdout.write(JSON.stringify(frame) + "\n")
}
const notify = (method: string, turn: Turn) =>
  send({
    method,
    params: { threadId: "fixture-thread", turn: { id: turn.id, status: turn.status } },
  })

const runTurn = async (clientId: string, complete: boolean) => {
  const turn: Turn = {
    id: clientId,
    status: "inProgress",
    items: [{ type: "userMessage", clientId }],
  }
  thread.turns.push(turn)
  await save()
  notify("turn/started", turn)
  send({
    method: "item/completed",
    params: { threadId: "fixture-thread", item: { type: "agentMessage", text: "first token" } },
  })
  if (complete) {
    await Bun.sleep(1500)
    turn.status = "completed"
    await save()
    notify("turn/completed", turn)
  }
}

const receive = async (line: string) => {
  const frame = JSON.parse(line)
  if (typeof frame.id !== "number") return
  const params = frame.params ?? {}
  let result: unknown = {}
  if (frame.method === "thread/start") {
    startedHere = true
    result = {
      thread: { id: "fixture-thread" },
      model: "fixture",
      modelProvider: "fixture",
      reasoningEffort: null,
    }
  }
  if (frame.method === "thread/resume") {
    if (!startedHere)
      for (const turn of thread.turns) if (turn.status === "inProgress") turn.status = "interrupted"
    await save()
    result = { model: "fixture", modelProvider: "fixture", reasoningEffort: null }
  }
  if (frame.method === "thread/read") result = { thread }
  if (frame.method === "thread/queue/list") result = { data: [], nextCursor: null }
  send({ id: frame.id, result })
  if (frame.method === "thread/queue/add" || frame.method === "turn/start")
    await runTurn(
      String(params.clientUserMessageId),
      frame.method === "turn/start" || Boolean(socket),
    )
}

const socket = process.argv.find((arg) => arg.startsWith("unix://"))?.slice(7)
if (socket) {
  Bun.serve({
    unix: socket,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response(null, { status: 400 })
    },
    websocket: {
      open(ws) {
        send = (frame) => {
          ws.send(JSON.stringify(frame))
        }
      },
      message(_ws, message) {
        void receive(String(message))
      },
      close() {
        send = () => {}
      },
    },
  })
} else for await (const line of createInterface({ input: process.stdin })) await receive(line)
