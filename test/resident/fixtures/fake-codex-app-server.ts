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
const save = () => writeFile(path, JSON.stringify(thread))
const send = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + "\n")
const notify = (method: string, turn: Turn) =>
  send({
    method,
    params: { threadId: "fixture-thread", turn: { id: turn.id, status: turn.status } },
  })

for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line)
  if (typeof frame.id !== "number") continue
  const params = frame.params ?? {}
  let result: unknown = {}
  if (frame.method === "thread/start")
    result = {
      thread: { id: "fixture-thread" },
      model: "fixture",
      modelProvider: "fixture",
      reasoningEffort: null,
    }
  if (frame.method === "thread/resume") {
    for (const turn of thread.turns) if (turn.status === "inProgress") turn.status = "interrupted"
    await save()
    result = { model: "fixture", modelProvider: "fixture", reasoningEffort: null }
  }
  if (frame.method === "thread/read") result = { thread }
  if (frame.method === "thread/queue/list") result = { data: [], nextCursor: null }
  send({ id: frame.id, result })
  if (frame.method === "thread/queue/add" || frame.method === "turn/start") {
    const turn: Turn = {
      id: params.clientUserMessageId,
      status: "inProgress",
      items: [{ type: "userMessage", clientId: params.clientUserMessageId }],
    }
    thread.turns.push(turn)
    await save()
    notify("turn/started", turn)
    send({
      method: "item/completed",
      params: { threadId: "fixture-thread", item: { type: "agentMessage", text: "first token" } },
    })
    if (frame.method === "turn/start") {
      turn.status = "completed"
      await save()
      notify("turn/completed", turn)
    }
  }
}
