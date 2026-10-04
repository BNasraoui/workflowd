/* global Bun */
import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const binary = process.env.EVIDENCE_REAL_CODEX_BINARY
if (!binary) throw new Error("EVIDENCE_REAL_CODEX_BINARY is required")
const root = await mkdtemp(join(tmpdir(), "workflowd-resident-probe-"))
const home = join(root, "home")
const socket = join(root, "server.sock")
await mkdir(home, { mode: 0o700 })
if (process.env.EVIDENCE_COPY_AUTH === "1")
  await cp(join(homedir(), ".codex", "auth.json"), join(home, "auth.json"))
const child = Bun.spawn([binary, "app-server", "--listen", `unix://${socket}`], {
  env: { ...process.env, CODEX_HOME: home },
  stdout: "ignore",
  stderr: Bun.file(join(root, "server.stderr")),
})
let nextId = 0
const openSocket = async (attempt = 0) => {
  if (attempt >= 100) throw new Error("socket upgrade failed")
  const ws = new WebSocket(`ws+unix://${socket}`)
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true })
      ws.addEventListener("error", reject, { once: true })
    })
    return ws
  } catch {
    ws.close()
    await Bun.sleep(50)
    return openSocket(attempt + 1)
  }
}
const connect = async () => {
  const ws = await openSocket()
  const frames = []
  const pending = new Map()
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data))
    frames.push(frame)
    const id = frame?.id
    if (!Number.isSafeInteger(id) || id <= 0) return
    const waiter = pending.get(id)
    if (typeof waiter !== "function") return
    pending.delete(id)
    waiter(frame)
  })
  const request = async (method, params = {}) => {
    const id = ++nextId
    const response = new Promise((resolve) => pending.set(id, resolve))
    ws.send(JSON.stringify({ id, method, params }))
    const frame = await Promise.race([
      response,
      Bun.sleep(30000).then(() => {
        throw new Error(`${method} timed out`)
      }),
    ])
    if (frame.error) throw new Error(`${method}: ${JSON.stringify(frame.error)}`)
    return frame.result
  }
  await request("initialize", {
    clientInfo: { name: "workflowd-probe", version: "1" },
    capabilities: { experimentalApi: true },
  })
  ws.send(JSON.stringify({ method: "initialized" }))
  return { ws, request, frames }
}
const waitFor = async (check, label, timeout = 120000) => {
  const deadline = Date.now() + timeout
  const attempt = async () => {
    const result = check()
    if (result) return result
    if (Date.now() >= deadline) throw new Error(`${label} timed out`)
    await Bun.sleep(50)
    return attempt()
  }
  return attempt()
}
try {
  let client = await connect()
  const started = await client.request("thread/start", {
    cwd: root,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  })
  const threadId = started.thread.id
  const startTurn = async (prompt) =>
    client.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] })
  const first = await startTurn("Run the shell command sleep 8, then reply exactly PROBE_ONE_DONE.")
  await waitFor(
    () =>
      client.frames.some(
        (f) => f.method === "turn/started" && f.params?.turn?.id === first.turn.id,
      ),
    "first turn start",
  )
  client.ws.close()
  await Bun.sleep(1000)
  client = await connect()
  const resumed = await client.request("thread/resume", { threadId })
  const selection = {
    model: resumed.model,
    modelProvider: resumed.modelProvider,
    reasoningEffort: resumed.reasoningEffort,
  }
  const completion = await waitFor(
    () =>
      client.frames.find(
        (f) => f.method === "turn/completed" && f.params?.turn?.id === first.turn.id,
      ),
    "rejoined turn completion",
  )
  assert.equal(completion.params.turn.status, "completed")
  const second = await startTurn(
    "Run the shell command sleep 8, then reply exactly PROBE_TWO_DONE.",
  )
  await waitFor(
    () =>
      client.frames.some(
        (f) => f.method === "turn/started" && f.params?.turn?.id === second.turn.id,
      ),
    "second turn start",
  )
  client.ws.close()
  await Bun.sleep(45000)
  client = await connect()
  await client.request("thread/resume", { threadId })
  const history = await client.request("thread/read", { threadId, includeTurns: true })
  const last = history.thread.turns.at(-1)
  assert.equal(last.id, second.turn.id)
  assert.equal(last.status, "completed")
  console.log(JSON.stringify({ U1: completion.params.turn.status, U2: last.status, U3: selection }))
  client.ws.close()
} finally {
  child.kill("SIGKILL")
  await child.exited
  await rm(root, { recursive: true, force: true })
}
