#!/usr/bin/env bun
// Opt-in real-process evidence. Never imported by bun test or CI.
import assert from "node:assert/strict"
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto"
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:net"
import { spawn, spawnSync } from "node:child_process"
import { Database } from "bun:sqlite"
import { connect } from "@nats-io/transport-node"
import { jetstreamManager } from "@nats-io/jetstream"
import { requestRunSocket } from "../../src/worker-identity/socket-client.ts"

const repo = resolve(import.meta.dirname, "../..")
const root = join(repo, ".scratch/evidence", new Date().toISOString().replaceAll(/[:.]/g, "-"))
mkdirSync(join(root, "logs"), { recursive: true, mode: 0o700 })
chmodSync(root, 0o700)
// Short absolute Linux paths avoid AF_UNIX's 108-byte pathname limit.
process.chdir(root)
const socketRoot = `/proc/${process.pid}/cwd`
const logs = join(root, "logs")
const unitPrefix = `workflowd-evidence57-${Date.now()}-`
const rows = []
const processes = new Set()
const descendants = new Map()
const drains = []
const secrets = []
let interrupted = false
process.once("SIGINT", () => {
  interrupted = true
})
process.once("SIGTERM", () => {
  interrupted = true
})
const secret = () => {
  const s = randomBytes(32).toString("hex")
  secrets.push(s)
  return s
}
const webhookSecret = process.env.EVIDENCE_GITHUB_WEBHOOK_SECRET_FILE
    ? readFileSync(process.env.EVIDENCE_GITHUB_WEBHOOK_SECRET_FILE, "utf8").trim()
    : secret(),
  natsToken = secret(),
  runToken = secret(),
  ciToken = secret(),
  ocPassword = secret()
secrets.push(webhookSecret)
const scrub = (value) => secrets.reduce((s, key) => s.split(key).join("[REDACTED]"), String(value))
const log = (kind, data) =>
  appendFileSync(
    join(logs, "evidence.jsonl"),
    scrub(JSON.stringify({ at: new Date().toISOString(), kind, data })) + "\n",
  )
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(label, fn, ms = 90000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}
async function port() {
  const s = createServer()
  await new Promise((r) => s.listen(0, "127.0.0.1", r))
  const p = s.address().port
  await new Promise((r) => s.close(r))
  return p
}
function command(args, env, cwd = repo) {
  const r = spawnSync(args[0], args.slice(1), { cwd, env, encoding: "utf8" })
  assert.equal(r.status, 0, `Command failed: ${args[0]}: ${scrub(r.stderr)}`)
  return r.stdout.trim()
}
function start(name, args, env) {
  const p = spawn(args[0], args.slice(1), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
  processes.add(p)
  for (const [streamName, stream] of [
    ["stdout", p.stdout],
    ["stderr", p.stderr],
  ]) {
    drains.push(
      (async () => {
        let pending = ""
        for await (const chunk of stream) {
          pending += chunk.toString()
          const lines = pending.split("\n")
          pending = lines.pop()
          for (const line of lines)
            appendFileSync(
              join(logs, `${name}.log`),
              `${new Date().toISOString()} ${streamName} ${scrub(line)}\n`,
            )
        }
        if (pending) appendFileSync(join(logs, `${name}.log`), scrub(pending) + "\n")
      })(),
    )
  }
  log("process-start", { name, pid: p.pid })
  return p
}
async function stop(p) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return
  rememberChildren(p.pid)
  p.kill("SIGCONT")
  p.kill("SIGTERM")
  try {
    await until("owned process exits", () => p.exitCode !== null || p.signalCode !== null, 10000)
  } catch {
    p.kill("SIGKILL")
    await until(
      "owned process exits after escalation",
      () => p.exitCode !== null || p.signalCode !== null,
      5000,
    )
  }
  log("process-stop", { pid: p.pid, code: p.exitCode, signal: p.signalCode })
}
function rememberChildren(pid) {
  const children = `/proc/${pid}/task/${pid}/children`
  if (!existsSync(children)) return
  for (const child of readFileSync(children, "utf8")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)) {
    try {
      const fields = readFileSync(`/proc/${child}/stat`, "utf8").split(") ")[1].split(" ")
      descendants.set(child, fields[19])
      rememberChildren(child)
    } catch {
      /* Child exited while being enumerated. */
    }
  }
}
async function stopDescendants() {
  for (const [pid, birth] of [...descendants].reverse()) {
    const alive = () => {
      try {
        const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")
        return fields[19] === birth && fields[0] !== "Z"
      } catch {
        return false
      }
    }
    if (!alive()) continue
    process.kill(pid, "SIGCONT")
    process.kill(pid, "SIGTERM")
    try {
      await until("owned descendant exits", () => !alive(), 5000)
    } catch {
      if (alive()) process.kill(pid, "SIGKILL")
      await until("owned descendant killed", () => !alive(), 5000)
    }
    log("descendant-stopped", { pid, birth })
  }
}
async function stopRecorders() {
  for (const event of frames().filter((e) => e.direction === "launch")) {
    const stat = `/proc/${event.pid}/stat`
    if (!existsSync(stat)) continue
    const birth = readFileSync(stat, "utf8").split(") ")[1].split(" ")[19]
    if (birth !== event.frame.birth) continue
    process.kill(event.pid, "SIGTERM")
    await until(
      "owned recorder exits",
      () => !existsSync(stat) || readFileSync(stat, "utf8").split(") ")[1].startsWith("Z "),
      15000,
    )
    log("recorder-stopped", { pid: event.pid, birth })
  }
}
async function cancel(r) {
  const child = start(
    "cancellation",
    [
      process.execPath,
      join(repo, "scripts/evidence/cancel-run.mjs"),
      env.WORKFLOWD_DATABASE_PATH,
      r.runId,
    ],
    env,
  )
  await until("administrative cancellation", () => child.exitCode !== null)
  assert.equal(child.exitCode, 0)
  assert.equal(
    query("SELECT state FROM kernel_agent_runs WHERE run_id=?", r.runId)[0]?.state,
    "cancelled",
  )
  log("cancel-persisted", { runId: r.runId })
}
class Blocked extends Error {}
async function scenario(id, name, run) {
  if (
    process.env.EVIDENCE_SCENARIOS &&
    !process.env.EVIDENCE_SCENARIOS.split(",").includes(String(id))
  )
    return
  if (interrupted) throw new Error("Evidence run interrupted; cleaning up owned processes")
  log("scenario-start", { id, name })
  const started = new Date().toISOString()
  try {
    const detail = await run()
    rows.push({ id, name, status: "PASS", detail, started })
  } catch (error) {
    rows.push({
      id,
      name,
      status: error instanceof Blocked ? "BLOCKED" : "FAIL",
      detail: scrub(error.message),
      started,
    })
  }
  log("scenario-result", rows.at(-1))
  console.log(`${id}. ${rows.at(-1).status}: ${name} — ${rows.at(-1).detail}`)
}
let db, nc, workflow, base, env
const query = (sql, ...params) => db.query(sql).all(...params)
function snapshot(label) {
  const tables = [
    "webhook_deliveries",
    "ci_deliveries",
    "ci_targets",
    "ci_events",
    "resident_threads",
    "resident_inbox",
    "kernel_agent_runs",
    "kernel_workflow_instances",
    "kernel_waits",
    "kernel_wait_event_deliveries",
  ]
  const data = Object.fromEntries(tables.map((t) => [t, query(`SELECT * FROM ${t}`)]))
  log("sqlite-snapshot", { label, data })
  return data
}
function frames() {
  const path = join(logs, "codex.jsonl")
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
}
const threadFrames = (id) => frames().filter((e) => e.frame.params?.threadId === id)
async function dispatch(name, prompt) {
  const response = await fetch(base + "/workflows/agent-runs", {
    method: "POST",
    headers: { authorization: `Bearer ${runToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      route: "evidence",
      repository: "evidence",
      prompt,
      idempotencyKey: name,
    }),
    signal: AbortSignal.timeout(360000),
  })
  const body = await response.json()
  log("dispatch", { name, status: response.status, body })
  assert.equal(response.status, 202, JSON.stringify(body))
  return body
}
async function subscribe(name, selector) {
  const r = await dispatch(
    name,
    `This is an isolated inbox evidence task. Do not inspect files, run git, access the network, or change anything. First send the commentary message "Registering ${name}" so workflowd verifies custody. Then call the MCP tool subscribe_to_event with exactly ${JSON.stringify(selector)}. After successful registration, reply "SUBSCRIBED ${name}" and END YOUR TURN. Do not sleep or poll. When a workflowd completion arrives in a NEW turn, reply "RESULT ${name}: " followed by its conclusion/status and all failing job names. Do not call any further tools.`,
  )
  await until("subscription is durable and first turn has ended", () => {
    const subscriptions = query(
      "SELECT * FROM kernel_workflow_instances WHERE workflow_type='mailbox_subscription' AND workflow_key=?",
      r.nativeSessionId,
    )
    const completed = threadFrames(r.nativeSessionId).some(
      (e) => e.frame.method === "turn/completed",
    )
    return subscriptions.length === 1 && completed
  })
  snapshot(`${name}: subscribed, turn ended`)
  return r
}
async function delivered(r, expected) {
  await until(
    "one inbox delivery and model reply",
    () => {
      const inbox = query(
        "SELECT * FROM resident_inbox WHERE thread_id=? AND id LIKE 'subscription-%'",
        r.nativeSessionId,
      )
      const replies = threadFrames(r.nativeSessionId)
        .filter(
          (e) => e.frame.method === "item/completed" && e.frame.params.item.type === "agentMessage",
        )
        .map((e) => e.frame.params.item.text)
      return (
        inbox.length === 1 &&
        inbox[0].state === "delivered" &&
        replies.some((s) => s?.includes("RESULT") && s.includes(expected))
      )
    },
    120000,
  )
  const f = threadFrames(r.nativeSessionId)
  assert.equal(
    f.filter(
      (e) =>
        e.direction === "send" &&
        e.frame.method === "thread/queue/add" &&
        e.frame.params.clientUserMessageId.startsWith("subscription-"),
    ).length,
    1,
  )
  const turns = f
    .filter((e) => e.frame.method === "turn/started")
    .map((e) => e.frame.params.turn.id)
  assert.equal(new Set(turns).size, 2, "completion must start exactly one NEW turn")
  snapshot("delivered")
}
async function natsSnapshot(label) {
  const manager = await jetstreamManager(nc)
  const info = await manager.streams.info("WORKFLOWD_CI_V1")
  const messages = []
  for (let seq = info.state.first_seq; seq > 0 && seq <= info.state.last_seq; seq++) {
    const m = await manager.streams.getMessage("WORKFLOWD_CI_V1", { seq })
    messages.push({ seq: m.seq, subject: m.subject, body: new TextDecoder().decode(m.data) })
  }
  log("nats-snapshot", { label, state: info.state, messages })
  return messages
}
const fixturesPath = process.env.EVIDENCE_CI_FIXTURES
const fixtures = fixturesPath ? JSON.parse(readFileSync(fixturesPath, "utf8")) : null
for (const target of [fixtures?.success, fixtures?.failure])
  if (target?.signature) secrets.push(target.signature)
const repository = fixtures?.repository ?? "BNasraoui/workflowd"
assert.equal(
  repository,
  "BNasraoui/workflowd",
  "Evidence CI policy must contain only the authorized repository",
)
const installationId = Number(process.env.EVIDENCE_GITHUB_INSTALLATION_ID ?? 2147483647)
const sha = (id) => id.toString(16).padStart(40, "0")
async function webhook(name, target, conclusion, configured = true) {
  const deliveryId = configured && target.deliveryId ? target.deliveryId : `evidence-${name}`
  const payload =
    configured && target.body
      ? target.body
      : JSON.stringify({
          action: "completed",
          installation: { id: installationId },
          repository: { full_name: configured ? repository : "unconfigured/ignored" },
          workflow_run: {
            id: target.runId ?? 987654321,
            name: "CI",
            head_sha: target.sha,
            status: "completed",
            conclusion,
            run_attempt: 1,
            html_url: `https://github.com/${repository}/actions/runs/${target.runId ?? 987654321}`,
          },
        })
  const signature =
    configured && target.signature
      ? target.signature
      : "sha256=" + createHmac("sha256", webhookSecret).update(payload).digest("hex")
  assert.equal(
    signature,
    "sha256=" + createHmac("sha256", webhookSecret).update(payload).digest("hex"),
  )
  log("webhook-send", { deliveryId, payload })
  const response = await fetch(base + "/hooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "workflow_run",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
    body: payload,
  })
  // Query synchronously on receipt, before parsing or yielding to another operation.
  const persisted = query("SELECT * FROM webhook_deliveries WHERE delivery_id=?", deliveryId)
  log("webhook-response", {
    deliveryId,
    status: response.status,
    persistedAtResponse: persisted,
    body: await response.text(),
  })
  assert.equal(response.status, 202)
  assert.equal(persisted.length, configured ? 1 : 0)
  return deliveryId
}
function requireCi() {
  if (!fixtures || !process.env.EVIDENCE_GITHUB_KEY)
    throw new Blocked(
      "Needs owner-authorized App credentials and real successful/failing deliveries",
    )
}
async function ciResult(target) {
  await until(
    "GitHub reconciliation produces CI state",
    () =>
      query("SELECT * FROM ci_events WHERE sha=?", target.sha).some(
        (r) => JSON.parse(r.state_json).conclusion !== "pending",
      ),
    420000,
  )
}
async function boot(resident = true) {
  const next = { ...env }
  if (!resident)
    for (const name of Object.keys(next))
      if (/^WORKFLOWD_(CI_|CODEX_RESIDENT_|WORKER_GITHUB_)/.test(name)) delete next[name]
  workflow = start(
    resident ? "workflowd" : "workflowd-defaults",
    [process.execPath, join(repo, "src/main.ts")],
    next,
  )
  await until(
    "workflowd health",
    async () => {
      assert.equal(workflow.exitCode, null, "workflowd exited")
      try {
        return (await fetch(base + "/health")).ok
      } catch {
        return false
      }
    },
    30000,
  )
}

try {
  const home = join(root, "home"),
    codexHome = join(root, "codex"),
    work = join(root, "repository")
  for (const dir of [home, codexHome, work]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const auth = readFileSync(join(homedir(), ".codex/auth.json"), "utf8")
  const collect = (v) => {
    if (typeof v === "string" && v.length >= 8) secrets.push(v)
    else if (v && typeof v === "object") Object.values(v).forEach(collect)
  }
  collect(JSON.parse(auth))
  writeFileSync(join(codexHome, "auth.json"), auth, { mode: 0o600 })
  writeFileSync(
    join(codexHome, "config.toml"),
    'model_reasoning_effort = "low"\n[features]\napps = false\n',
  )
  const keyPath = join(root, "github.pem")
  if (process.env.EVIDENCE_GITHUB_KEY) copyFileSync(process.env.EVIDENCE_GITHUB_KEY, keyPath)
  else
    writeFileSync(
      keyPath,
      generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey,
      { mode: 0o600 },
    )
  chmodSync(keyPath, 0o600)
  secrets.push(readFileSync(keyPath, "utf8"))
  const natsPort = await port(),
    httpPort = await port(),
    unusedOpenCodePort = await port()
  base = `http://127.0.0.1:${httpPort}`
  const path = process.env.PATH
  env = {
    XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus`,
    PATH: path,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CODEX_HOME: codexHome,
    TMPDIR: root,
    LANG: "C.UTF-8",
    EVIDENCE_ROOT: root,
    EVIDENCE_CODEX_BIN: command(["which", "codex"], { PATH: path }),
    GITHUB_APP_ID: process.env.EVIDENCE_GITHUB_APP_ID ?? "2147483647",
    GITHUB_PRIVATE_KEY_PATH: keyPath,
    GITHUB_WEBHOOK_SECRET: webhookSecret,
    OPENCODE_SERVER_PASSWORD: ocPassword,
    OPENCODE_SERVER_URL: `http://127.0.0.1:${unusedOpenCodePort}`,
    WORKFLOWD_OPENCODE_ATTACH_URL: `http://127.0.0.1:${unusedOpenCodePort}`,
    WORKFLOWD_HOST: "127.0.0.1",
    WORKFLOWD_PORT: String(httpPort),
    WORKFLOWD_DATABASE_PATH: join(root, "workflowd.db"),
    WORKFLOWD_STATE_DIR: join(root, "state"),
    WORKFLOWD_CACHE_DIR: join(root, "cache"),
    WORKFLOWD_WORKTREE_ROOT: join(root, "worktrees"),
    WORKFLOWD_REPOSITORY_ROOT: work,
    WORKFLOWD_LOCAL_REPOSITORIES: work,
    OPENCODE_WORKTREE_REGISTRY: join(root, "registry"),
    WORKFLOWD_CI_ENABLED: "true",
    WORKFLOWD_CI_TOKEN: ciToken,
    WORKFLOWD_CI_REPOSITORIES: JSON.stringify([
      {
        repository,
        dispatchRepository: "evidence",
        installationId,
        workflows: fixtures?.workflows ?? ["CI"],
      },
    ]),
    WORKFLOWD_NATS_SERVERS: `nats://127.0.0.1:${natsPort}`,
    WORKFLOWD_NATS_TOKEN: natsToken,
    WORKFLOWD_CODEX_RESIDENT_ENABLED: "true",
    WORKFLOWD_CODEX_RESIDENT_HOME: codexHome,
    WORKFLOWD_CODEX_RESIDENT_SOCKET: join(socketRoot, "resident.sock"),
    WORKFLOWD_WORKER_GITHUB_ENABLED: "true",
    WORKFLOWD_WORKER_GITHUB_DIRECTORY: join(root, "gh"),
    WORKFLOWD_WORKER_GITHUB_SOCKET: join(socketRoot, "identity.sock"),
    WORKFLOWD_WORKER_GITHUB_REPOSITORIES: JSON.stringify([
      { name: "evidence", repository, installationId, permissions: { contents: "read" } },
    ]),
    WORKFLOWD_REVIEWER_AGENT: "evidence",
    WORKFLOWD_FIXER_AGENT: "evidence",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      autoupdate: false,
      share: "disabled",
      agents: { evidence: { mode: "primary", description: "Isolated evidence worker" } },
      providers: { openai: { models: { "gpt-5.6-sol": { name: "GPT 5.6 Sol" } } } },
    }),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    WORKFLOWD_AGENT_RUN_TOKEN: runToken,
    WORKFLOWD_AGENT_RUN_ROUTES: "unused=openai/gpt-5.6-sol",
    WORKFLOWD_AGENT_RUN_CODEX_ROUTES: `evidence=${process.env.EVIDENCE_MODEL ?? "gpt-5.6-sol"}`,
    WORKFLOWD_AGENT_RUN_REPOSITORIES: `evidence=${work}`,
    WORKFLOWD_AGENT_RUN_CODEX_BIN: join(root, "codex-launch.mjs"),
    WORKFLOWD_AGENT_RUN_CODEX_UNIT_PREFIX: unitPrefix,
    WORKFLOWD_AGENT_RUN_VERIFY_TIMEOUT_MS: "120000",
  }
  // The transient unit receives only scratch configuration, even if the user
  // manager has ambient credentials. Preserve the resident's run-bound routing.
  const workerEnv = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "CODEX_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "EVIDENCE_ROOT",
      "EVIDENCE_CODEX_BIN",
    ].map((name) => [name, env[name]]),
  )
  writeFileSync(
    env.WORKFLOWD_AGENT_RUN_CODEX_BIN,
    `#!${process.execPath}\nconst owned = ${JSON.stringify(workerEnv)};\n` +
      `for (const name of Object.keys(process.env)) if (!name.startsWith("WORKFLOWD_") && name !== "GH_CONFIG_DIR") delete process.env[name];\n` +
      `Object.assign(process.env, owned);\nawait import(${JSON.stringify(join(repo, "scripts/evidence/codex-recorder.mjs"))});\n`,
    { mode: 0o700 },
  )
  writeFileSync(join(root, "redactions.json"), JSON.stringify(secrets), { mode: 0o600 })
  start(
    "opencode",
    [
      command(["which", "opencode2"], env),
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(unusedOpenCodePort),
    ],
    env,
  )
  await until(
    "scratch OpenCode",
    async () => {
      try {
        return (
          await fetch(env.OPENCODE_SERVER_URL + "/api/agent", {
            headers: {
              authorization: "Basic " + Buffer.from(`opencode:${ocPassword}`).toString("base64"),
            },
          })
        ).ok
      } catch {
        return false
      }
    },
    30000,
  )
  for (const resource of ["agent", "model"]) {
    const response = await fetch(env.OPENCODE_SERVER_URL + `/api/${resource}`, {
      headers: {
        authorization: "Basic " + Buffer.from(`opencode:${ocPassword}`).toString("base64"),
      },
    })
    log(`opencode-${resource}`, await response.json())
  }
  await until(
    "OpenCode agent catalog ready",
    async () => {
      const response = await fetch(env.OPENCODE_SERVER_URL + "/api/agent", {
        headers: {
          authorization: "Basic " + Buffer.from(`opencode:${ocPassword}`).toString("base64"),
        },
      })
      const result = await response.json()
      return result.data.some((agent) => agent.name === "evidence")
    },
    15000,
  )
  command(["git", "init", "-q", work], env)
  command(
    [
      "git",
      "-C",
      work,
      "-c",
      "user.name=Evidence",
      "-c",
      "user.email=evidence@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "Isolated evidence workspace",
    ],
    env,
  )
  log("isolation", {
    root,
    natsPort,
    httpPort,
    unusedOpenCodePort,
    gitHead: command(["git", "rev-parse", "HEAD"], { PATH: path }),
    credentialMode: fixtures
      ? "owner-authorized-app-original-signed-deliveries"
      : "generated-invalid-app-key",
    model: env.WORKFLOWD_AGENT_RUN_CODEX_ROUTES,
  })
  writeFileSync(
    join(root, "nats.conf"),
    `host: 127.0.0.1\nport: ${natsPort}\nauthorization { token: "${natsToken}" }\njetstream { store_dir: "${join(root, "jetstream")}" }\n`,
    { mode: 0o600 },
  )
  start("nats", [command(["which", "nats-server"], env), "-c", join(root, "nats.conf")], env)
  await until(
    "scratch NATS",
    async () => {
      try {
        nc = await connect({
          servers: env.WORKFLOWD_NATS_SERVERS,
          token: natsToken,
          reconnect: false,
          timeout: 300,
        })
        return true
      } catch {
        return false
      }
    },
    10000,
  )
  await boot()
  db = new Database(env.WORKFLOWD_DATABASE_PATH, { readonly: true })
  let first
  await scenario(1, "CI success and new turn", async () => {
    const target = fixtures?.success ?? { sha: sha(1) }
    first = await subscribe("ci-success", { kind: "ci", repository, sha: target.sha })
    await webhook("ci-success", target, "success")
    await until(
      "NATS completion",
      async () =>
        (await natsSnapshot("success")).some(
          (m) =>
            JSON.parse(m.body).deliveryId ===
            (fixtures?.success.deliveryId ?? "evidence-ci-success"),
        ),
      10000,
    )
    requireCi()
    await ciResult(target)
    await delivered(first, "success")
    return "Signed webhook persisted by 202, JetStream receipt, one inbox message, two distinct turns, success reply"
  })
  await scenario(2, "CI failure includes failing jobs", async () => {
    requireCi()
    const t = fixtures.failure
    const r = await subscribe("ci-failure", { kind: "ci", repository, sha: t.sha })
    await webhook("ci-failure", t, "failure")
    await ciResult(t)
    await delivered(r, "failure")
    const inbox = query(
      "SELECT prompt FROM resident_inbox WHERE thread_id=? AND id LIKE 'subscription-%'",
      r.nativeSessionId,
    )[0]
    assert.ok(t.failingJobs.length)
    const replies = threadFrames(r.nativeSessionId)
      .filter(
        (e) => e.frame.method === "item/completed" && e.frame.params.item.type === "agentMessage",
      )
      .map((e) => e.frame.params.item.text)
      .join("\n")
    for (const job of t.failingJobs) {
      assert.ok(inbox.prompt.includes(job))
      assert.ok(replies.includes(job))
    }
    return "Failure and all expected job names delivered"
  })
  await scenario(3, "Duplicate webhook delivers once", async () => {
    await webhook("ci-success", fixtures?.success ?? { sha: sha(1) }, "success")
    const messages = await natsSnapshot("duplicate")
    assert.equal(
      messages.filter(
        (m) =>
          JSON.parse(m.body).deliveryId === (fixtures?.success.deliveryId ?? "evidence-ci-success"),
      ).length,
      1,
    )
    requireCi()
    assert.ok(first)
    await delivered(first, "success")
    return "One persisted receipt, NATS completion, mailbox message and continuation"
  })
  await scenario(4, "Late subscription", async () => {
    requireCi()
    await ciResult(fixtures.success)
    const r = await subscribe("ci-late", { kind: "ci", repository, sha: fixtures.success.sha })
    const receipt = threadFrames(r.nativeSessionId).find(
      (e) =>
        e.frame.method === "item/completed" &&
        e.frame.params.item.type === "mcpToolCall" &&
        e.frame.params.item.tool === "subscribe_to_event",
    )
    assert.equal(
      receipt?.frame.params.item.result?.structuredContent?.deliveryState,
      "delivered",
      "late result must be queued before subscription receipt",
    )
    await delivered(r, "success")
    return "Existing terminal CI state queues one message immediately"
  })
  await scenario(5, "Two worker threads", async () => {
    requireCi()
    const a = await subscribe("ci-two-a", { kind: "ci", repository, sha: fixtures.success.sha })
    const b = await subscribe("ci-two-b", { kind: "ci", repository, sha: fixtures.success.sha })
    assert.notEqual(a.nativeSessionId, b.nativeSessionId)
    await delivered(a, "success")
    await delivered(b, "success")
    return "Two distinct threads each received one continuation"
  })
  await scenario(6, "Agent-run completed and cancelled", async () => {
    const child = await dispatch(
      "child-completed",
      "Reply exactly CHILD COMPLETE. Do not use tools or inspect anything.",
    )
    await until(
      "child completes",
      () =>
        query("SELECT state FROM kernel_agent_runs WHERE run_id=?", child.runId)[0]?.state ===
        "completed",
    )
    const parent = await subscribe("agent-completed", { kind: "agent_run", run_id: child.runId })
    await delivered(parent, "completed")
    const childToCancel = await subscribe("child-cancelled", {
      kind: "ci",
      repository,
      sha: sha(6),
    })
    const cancellationParent = await subscribe("agent-cancelled", {
      kind: "agent_run",
      run_id: childToCancel.runId,
    })
    await cancel(childToCancel)
    await delivered(cancellationParent, "cancelled")
    return "Real completed run and real store administrative cancellation each delivered once in a new turn"
  })
  await scenario(7, "Cross-run peer credentials", async () => {
    const victim = await subscribe("cross-run-victim", { kind: "ci", repository, sha: sha(7) })
    assert.equal(
      query("SELECT state FROM kernel_agent_runs WHERE run_id=?", victim.runId)[0]?.state,
      "verified",
    )
    const subscription = await requestRunSocket(
      env.WORKFLOWD_CODEX_RESIDENT_SOCKET,
      "/subscriptions",
      JSON.stringify({ runId: victim.runId, selector: { kind: "ci", repository, sha: sha(70) } }),
    )
    const token = await requestRunSocket(
      env.WORKFLOWD_WORKER_GITHUB_SOCKET,
      `/workers/github/${victim.runId}/token`,
    )
    log("cross-run-denial", {
      runId: victim.runId,
      peerPid: process.pid,
      subscription: subscription.status,
      token: token.status,
    })
    assert.equal(subscription.status, 403)
    assert.equal(token.status, 403)
    return "Unrelated process denied 403 on subscription and token sockets"
  })
  await scenario(8, "Mailbox failure requires operator", async () => {
    const child = await subscribe("failure-child", { kind: "ci", repository, sha: sha(8) })
    const r = await subscribe("mailbox-failure", { kind: "agent_run", run_id: child.runId })
    writeFileSync(join(root, `fail-${r.runId}`), "fail next queue")
    await cancel(child)
    await until(
      "operator required",
      () =>
        query(
          "SELECT * FROM resident_inbox WHERE thread_id=? AND state='operator_required'",
          r.nativeSessionId,
        ).length === 1,
    )
    snapshot("operator-required")
    const attempts = () =>
      threadFrames(r.nativeSessionId).filter(
        (e) =>
          e.direction === "send" &&
          e.frame.method === "thread/queue/add" &&
          e.frame.params.clientUserMessageId.startsWith("subscription-"),
      ).length
    assert.equal(attempts(), 1)
    await delay(6000)
    assert.equal(attempts(), 1)
    assert.equal(
      query("SELECT state FROM resident_threads WHERE thread_id=?", r.nativeSessionId)[0].state,
      "operator_required",
    )
    snapshot("operator-required after six delivery intervals")
    return "Owned app-server stopped before queue call; operator_required persists, one attempt across six retry intervals"
  })
  await scenario(9, "Restart between persist and deliver", async () => {
    const child = await subscribe("restart-child", { kind: "ci", repository, sha: sha(9) })
    const parent = await subscribe("restart-parent", { kind: "agent_run", run_id: child.runId })
    // Freeze only this harness's workflowd to make the crash window deterministic.
    workflow.kill("SIGSTOP")
    await until("scratch daemon frozen", () =>
      readFileSync(`/proc/${workflow.pid}/stat`, "utf8").split(") ")[1].startsWith("T "),
    )
    await cancel(child)
    assert.equal(
      query(
        "SELECT * FROM resident_inbox WHERE thread_id=? AND id LIKE 'subscription-%'",
        parent.nativeSessionId,
      ).length,
      0,
    )
    snapshot("terminal event persisted while delivery process frozen")
    rememberChildren(workflow.pid)
    workflow.kill("SIGKILL")
    await until("scratch daemon crashed", () => workflow.signalCode !== null)
    await stopRecorders()
    const custody = join(root, "agent-processes")
    for (const name of existsSync(custody) ? readdirSync(custody) : []) {
      const manifestPath = join(custody, name, "manifest.json")
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      assert.ok(manifest.executionId.startsWith(unitPrefix))
      const status = spawnSync(
        "systemctl",
        [
          "--user",
          "show",
          manifest.executionId,
          "-p",
          "InvocationID",
          "-p",
          "Description",
          "-p",
          "ActiveState",
        ],
        { env, encoding: "utf8" },
      )
      if (
        status.status === 0 &&
        /ActiveState=(active|activating|deactivating)/.test(status.stdout)
      ) {
        assert.ok(status.stdout.includes(`InvocationID=${manifest.invocationId}`))
        assert.ok(status.stdout.includes(`Description=workflowd codex launch ${manifest.launchId}`))
        command(["systemctl", "--user", "stop", manifest.executionId], env)
      }
      spawnSync("systemctl", ["--user", "reset-failed", manifest.executionId], {
        env,
        stdio: "ignore",
      })
      log("scratch-unit-cleaned", { unit: manifest.executionId })
    }
    await stopDescendants()
    for (const name of ["resident.sock", "identity.sock"]) rmSync(join(root, name), { force: true })
    await boot()
    await delivered(parent, "cancelled")
    return "Real terminal run state persisted before owned daemon crash; restart resumed thread and delivered exactly once"
  })
  await scenario(10, "Unconfigured repository ignored", async () => {
    const before = await natsSnapshot("before ignored")
    await webhook("unconfigured", { sha: sha(10) }, "success", false)
    await delay(1500)
    assert.equal(
      query("SELECT * FROM ci_deliveries WHERE delivery_id='evidence-unconfigured'").length,
      0,
    )
    const after = await natsSnapshot("after ignored")
    assert.equal(after.filter((m) => m.body.includes("unconfigured/ignored")).length, 0)
    snapshot("ignored")
    return `No receipt, CI delivery or NATS message (stream ${before.length} → ${after.length})`
  })
  await scenario(11, "Defaults off uses transient exec", async () => {
    await stop(workflow)
    await boot(false)
    const r = await dispatch(
      "defaults-off",
      "Reply exactly DEFAULTS OFF. Do not use tools or inspect anything.",
    )
    await until(
      "legacy completes",
      () =>
        query("SELECT state FROM kernel_agent_runs WHERE run_id=?", r.runId)[0]?.state ===
        "completed",
    )
    assert.equal(query("SELECT * FROM resident_threads WHERE run_id=?", r.runId).length, 0)
    assert.ok(frames().some((f) => f.direction === "launch" && f.frame.args[0] === "exec"))
    snapshot("defaults-off")
    return "Real transient-systemd codex exec --json dispatch completed; no resident thread"
  })
  await scenario(12, "OpenCode resident completion", async () => {
    const child = query(
      "SELECT run_id FROM kernel_agent_runs WHERE prompt LIKE '%cross-run-victim%' AND state='verified'",
    )[0]
    assert.ok(child, "Needs the still-waiting run from scenario 7")
    await stop(workflow)
    env.WORKFLOWD_WORKER_GITHUB_ENABLED = "false"
    env.WORKFLOWD_CODEX_RESIDENT_ENABLED = "false"
    delete env.WORKFLOWD_AGENT_RUN_CODEX_ROUTES
    env.WORKFLOWD_OPENCODE_RESIDENT_ENABLED = "true"
    env.WORKFLOWD_OPENCODE_RESIDENT_SOCKET = join(socketRoot, "opencode-resident.sock")
    env.WORKFLOWD_AGENT_RUN_ROUTES = `evidence=${process.env.EVIDENCE_OPENCODE_MODEL ?? "opencode/nemotron-3.5-lightning-free"}`
    env.WORKFLOWD_AGENT_RUN_VERIFY_TIMEOUT_MS = "300000"
    await boot()
    const r = await dispatch(
      "opencode-mailbox",
      `This is an isolated mailbox evidence task. Do not inspect files, run git, search for executables, or change anything. First say Registering opencode-mailbox and run the shell command printf 'REGISTERING\\n' so workflowd can verify the generated step. Then run exactly this shell command once: ${JSON.stringify(process.execPath)} ${JSON.stringify(join(repo, "src/resident/subscribe.ts"))} --agent-run ${child.run_id}. It uses the subscribe_to_event registration path and returns immediately. Never print environment variables or credentials. If the command fails, report the failure and stop; do not search or retry. After a successful receipt, reply SUBSCRIBED opencode-mailbox and END YOUR TURN. Do not sleep or poll. When a completion message arrives in a NEW turn, reply RESULT opencode-mailbox followed by its status and summary. Do not call further tools.`,
    )
    const get = async (suffix) => {
      const response = await fetch(
        env.OPENCODE_SERVER_URL + `/api/session/${r.nativeSessionId}${suffix}`,
        {
          headers: {
            authorization: "Basic " + Buffer.from(`opencode:${ocPassword}`).toString("base64"),
          },
        },
      )
      assert.equal(response.status, 200)
      return response.json()
    }
    const texts = (page) =>
      page.data
        .filter((m) => m.type === "assistant")
        .flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => c.text))
    await until(
      "OpenCode subscription turn ended",
      async () => {
        const messages = await get("/message?limit=100&order=asc")
        const session = await get("")
        const subscribed = query(
          "SELECT * FROM kernel_workflow_instances WHERE workflow_type='mailbox_subscription' AND workflow_key=?",
          r.nativeSessionId,
        )
        return (
          subscribed.length === 1 &&
          texts(messages).some((t) => t.includes("SUBSCRIBED opencode-mailbox")) &&
          session.data.time?.idle
        )
      },
      180000,
    )
    log("opencode-subscription-turn-ended", {
      sessionId: r.nativeSessionId,
      messages: await get("/message?limit=100&order=asc"),
      session: await get(""),
    })
    await cancel({ runId: child.run_id })
    await until(
      "OpenCode mailbox continuation",
      async () => {
        const messages = await get("/message?limit=100&order=asc")
        return texts(messages).some(
          (t) => t.includes("RESULT opencode-mailbox") && t.includes("cancelled"),
        )
      },
      180000,
    )
    const messages = await get("/message?limit=100&order=asc")
    log("opencode-mailbox-continuation", { sessionId: r.nativeSessionId, messages })
    const inbox = query(
      "SELECT * FROM resident_inbox WHERE thread_id=? AND id LIKE 'subscription-%'",
      r.nativeSessionId,
    )
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].state, "delivered")
    assert.equal(texts(messages).filter((t) => t.includes("RESULT opencode-mailbox")).length, 1)
    snapshot("OpenCode completion delivered")
    return "Separate credential-free OpenCode server: registered, ended subscription turn, one durable delivered inbox and one cancellation reply"
  })
} catch (error) {
  log("setup-failure", { message: scrub(error.message) })
  console.error(scrub(error.message))
} finally {
  if (db) {
    try {
      snapshot("final")
    } catch {
      /* setup may be incomplete */
    }
    db.close()
  }
  if (nc) await nc.close()
  for (const p of [...processes].reverse()) {
    try {
      await stop(p)
    } catch (e) {
      log("cleanup-failure", { pid: p.pid, message: e.message })
    }
  }
  try {
    await stopRecorders()
  } catch (error) {
    log("cleanup-failure", { message: error.message })
  }
  await stopDescendants()
  log("cleanup-complete", { ownedProcesses: processes.size, trackedDescendants: descendants.size })
  await Promise.allSettled(drains)
  // Credentials are never among uploadable logs and are removed after use.
  for (const file of [
    "codex/auth.json",
    "redactions.json",
    "github.pem",
    "nats.conf",
    "codex-launch.mjs",
  ])
    rmSync(join(root, file), { force: true })
  for (let id = 1; id <= 12; id++)
    if (!rows.some((r) => r.id === id))
      rows.push({
        id,
        name: `Scenario ${id}`,
        status: process.env.EVIDENCE_SCENARIOS ? "SKIPPED" : "BLOCKED",
        detail: process.env.EVIDENCE_SCENARIOS
          ? "Not selected for this scoped run"
          : "Setup failed; see evidence log",
      })
  rows.sort((a, b) => a.id - b.id)
  const table =
    "| # | Scenario | Result | Evidence / limitation |\n|---|---|---|---|\n" +
    rows
      .map(
        (r) =>
          `| ${r.id} | ${r.name} | ${r.status} | ${r.detail.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
      )
      .join("\n")
  writeFileSync(
    join(logs, "results.md"),
    `## Evidence\n\nRerun: \`bun scripts/evidence/agent-inboxes.mjs\`\n\n${table}\n`,
  )
  writeFileSync(join(logs, "results.json"), JSON.stringify(rows, null, 2))
  console.log(table + `\nEvidence: ${logs}`)
  process.exitCode = rows.every((r) => ["PASS", "SKIPPED"].includes(r.status)) ? 0 : 1
}
