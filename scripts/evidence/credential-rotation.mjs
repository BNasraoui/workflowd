#!/usr/bin/env bun
/* global Bun */
// Explicit manual invocation only; never imported by CI or the test suite.
import assert from "node:assert/strict"
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  stat,
  copyFile,
  chmod,
  utimes,
} from "node:fs/promises"
import { resolve, join } from "node:path"
import { fullDaemonEnvironment } from "./credential-rotation-full.mjs"
import { Database } from "bun:sqlite"
import { agentRunIdentifiers } from "../../src/kernel/agent-run-ingress.ts"
if (process.env.CI) throw Error("This manual evidence runner must not run in CI")
const full = process.argv.includes("--full")
const base = resolve(".scratch/evidence59")
const root = join(base, `run-${Date.now()}`)
await mkdir(root, { recursive: true, mode: 0o700 })
const prefix = `workflowd-evidence59-${Date.now()}-`
const env = {
  PATH: process.env.PATH,
  HOME: join(root, "home"),
  CODEX_HOME: join(root, "codex-home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus`,
  EVIDENCE_TOKEN: crypto.randomUUID(),
  EVIDENCE_ROOT: root,
  EVIDENCE_PREFIX: prefix,
  EVIDENCE_BINARY: resolve("scripts/evidence/credential-rotation-worker.mjs"),
}
for (const path of [
  env.HOME,
  env.CODEX_HOME,
  env.XDG_CONFIG_HOME,
  env.XDG_DATA_HOME,
  env.XDG_STATE_HOME,
  env.XDG_CACHE_HOME,
])
  await mkdir(path, { recursive: true, mode: 0o700 })
const entries = []
const results = []
let fullSetup = null
let host = null,
  port = null,
  db = null
const log = (label, value) => {
  const item = { at: new Date().toISOString(), label, value }
  entries.push(item)
  console.log(JSON.stringify(item))
}
const command = async (args, options = {}) => {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe", ...options })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}
let interrupted = false
const interrupt = () => {
  interrupted = true
}
process.on("SIGINT", interrupt)
process.on("SIGTERM", interrupt)
const wait = async (fn, ms = 15000) => {
  const deadline = Date.now() + ms
  do {
    if (interrupted) throw Error("evidence run interrupted")
    const value = await fn()
    if (value) return value
    await Bun.sleep(40)
  } while (Date.now() < deadline)
  throw Error("condition timed out")
}
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  )
const stop = async (signal = "SIGKILL") => {
  if (host) {
    host.kill(signal)
    await host.exited
    host = null
  }
  await rm(join(root, "ready.json"), { force: true })
}
const start = async (extra = {}) => {
  await stop()
  const index = (await readdir(root)).filter((x) => x.startsWith("host-")).length
  host = Bun.spawn(
    [
      process.execPath,
      resolve(full ? "src/main.ts" : "scripts/evidence/credential-rotation-host.mjs"),
    ],
    {
      env: full
        ? {
            ...fullSetup.env,
            ...extra,
            WORKFLOWD_AGENT_RUN_CODEX_BIN: extra.EVIDENCE_BINARY ?? env.EVIDENCE_BINARY,
            ...(extra.EVIDENCE_UNAVAILABLE === "1"
              ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/missing-bus`, XDG_RUNTIME_DIR: root }
              : {}),
          }
        : { ...env, ...extra },
      stdout: Bun.file(join(root, `host-${index}.log`)),
      stderr: Bun.file(join(root, `host-${index}.stderr.log`)),
    },
  )
  await wait(async () => {
    if (host.exitCode !== null) throw Error(`scratch host exited ${host.exitCode}`)
    if (full)
      return fetch(`http://127.0.0.1:${fullSetup.port}/health`).then(
        () => true,
        () => false,
      )
    return exists(join(root, "ready.json"))
  }, 70000)
  port = full ? fullSetup.port : JSON.parse(await readFile(join(root, "ready.json"), "utf8")).port
  log("host-start", { pid: host.pid, port, extra: Object.keys(extra) })
}
const post = async (input) => {
  const response = await fetch(
    `http://127.0.0.1:${port}/workflows/agent-runs${input.cancel ? `/${input.cancel}` : ""}`,
    {
      method: input.cancel ? "DELETE" : "POST",
      headers: { authorization: `Bearer ${env.EVIDENCE_TOKEN}` },
      ...(input.cancel ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(65000),
    },
  )
  const body = await response.json()
  return response.ok
    ? { _tag: "Success", status: response.status, value: body }
    : { _tag: "Failure", status: response.status, failure: body }
}
const input = (name, prompt = name, route = "codex") => ({
  route,
  repository: "scratch",
  prompt,
  idempotencyKey: `evidence59-${name}`,
})
const id = (submission) =>
  agentRunIdentifiers({ ...submission, parentSessionId: null, resumePrompt: null }).runId
const row = (runId) => db.query("SELECT * FROM kernel_agent_runs WHERE run_id = ?").get(runId)
const manifest = (runId) =>
  readFile(join(root, "agent-processes", runId, "manifest.json"), "utf8").then(JSON.parse)
const snapshot = async (runId, label) => {
  const custody = await manifest(runId)
  assert.ok(custody.executionId.startsWith(prefix))
  const unit = await command([
    "systemctl",
    "--user",
    "show",
    custody.executionId,
    "-p",
    "InvocationID,ActiveState,SubState,Description,Result,ControlGroup",
  ])
  log(label, { row: row(runId), custody, unit })
  return { custody, unit }
}
const terminal = (runId) =>
  wait(() => {
    const r = row(runId)
    return ["completed", "failed", "operator_required", "cancelled"].includes(r?.state) && r
  }, 120000)
const complete = async (runId) => {
  const r = await terminal(runId)
  log("terminal", r)
  await snapshot(runId, "terminal-custody")
  assert.equal(r.state, "completed")
  assert.equal(
    db
      .query("SELECT count(*) AS n FROM evidence_transitions WHERE run_id=? AND state='completed'")
      .get(runId).n,
    1,
  )
  const output = await readFile(join(root, "agent-processes", runId, "events.jsonl"), "utf8")
  log("worker-output", output)
  assert.equal(output.split("full-final-output").length - 1, 1)
  assert.equal(r.last_output_tokens, 42)
}
const scenario = async (name, fn) => {
  if (interrupted) throw Error("evidence run interrupted")
  try {
    await fn()
    results.push({ scenario: name, result: "PASS" })
  } catch (error) {
    results.push({ scenario: name, result: "FAIL", detail: String(error) })
    log("failure", { name, error: String(error) })
  }
}
const owned = async () =>
  (await readdir(root)).filter((x) => x.startsWith("owned-")).map((x) => x.slice(6))
const removeUnit = async (unit) => {
  assert.ok(unit.startsWith(prefix))
  await command(["systemctl", "--user", "stop", "--no-block", unit])
  await command(["systemctl", "--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit])
  await wait(async () => {
    const s = await command(["systemctl", "--user", "show", unit, "-p", "ActiveState"])
    return !/ActiveState=(active|activating|deactivating)/.test(s.stdout)
  })
  await command(["systemctl", "--user", "reset-failed", unit])
}
try {
  log("checkout", await command(["git", "rev-parse", "HEAD"]))
  await command(["git", "init", "-q", join(root, "repo")])
  const identity = await Promise.all(
    ["user.name", "user.email"].map((key) => command(["git", "config", key], { env: process.env })),
  )
  assert.ok(identity.every((x) => x.code === 0 && x.stdout.trim()))
  for (let i = 0; i < 2; i++)
    await command([
      "git",
      "-C",
      join(root, "repo"),
      "config",
      ["user.name", "user.email"][i],
      identity[i].stdout.trim(),
    ])
  await writeFile(join(root, "repo", "README"), "Scratch evidence repository.\n")
  await command(["git", "-C", join(root, "repo"), "add", "README"])
  assert.equal(
    (
      await command([
        "git",
        "-C",
        join(root, "repo"),
        "commit",
        "-qm",
        "Initialize scratch repository",
      ])
    ).code,
    0,
  )
  if (process.env.EVIDENCE_COPY_AUTH === "1") {
    await copyFile(join(process.env.HOME, ".codex/auth.json"), join(env.CODEX_HOME, "auth.json"))
    await chmod(join(env.CODEX_HOME, "auth.json"), 0o600)
  }
  if (full) fullSetup = await fullDaemonEnvironment(root, prefix, env, log)
  log("scope", {
    entrypoint: full ? "src/main.ts" : "focused host",
    nats: "disabled",
    openCode: "isolated HTTP fixture",
  })
  await start()
  db = new Database(join(root, "state.db"))
  db.exec(
    "CREATE TABLE evidence_transitions(run_id TEXT,state TEXT,at TEXT); CREATE TRIGGER evidence_transition AFTER UPDATE OF state ON kernel_agent_runs WHEN NEW.state != OLD.state BEGIN INSERT INTO evidence_transitions VALUES(NEW.run_id,NEW.state,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;",
  )
  await scenario("1. Survive restart (controlled worker)", async () => {
    const s = input("survive")
    const runId = id(s)
    log("dispatch", await post(s))
    assert.equal(row(runId).state, "verified")
    const before = await snapshot(runId, "before-restart")
    await stop()
    const down = await snapshot(runId, "host-down")
    assert.match(down.unit.stdout, /ActiveState=active/)
    await start()
    const after = await snapshot(runId, "after-restart")
    assert.equal(after.custody.invocationId, before.custody.invocationId)
    assert.equal(after.custody.launchId, before.custody.launchId)
    await complete(runId)
  })
  await scenario("2. Restart during launch", async () => {
    await start({ EVIDENCE_LAUNCH_BARRIER: "1" })
    const s = input("launch")
    const runId = id(s)
    const pending = post(s).catch(() => null)
    await wait(() => exists(join(root, "launch-barrier")))
    assert.equal(row(runId).state, "spawning")
    const before = await snapshot(runId, "launch-barrier")
    assert.equal(before.custody.invocationId, null)
    await stop()
    await pending
    await start()
    const after = await snapshot(runId, "launch-recovered")
    assert.equal(after.custody.launchId, before.custody.launchId)
    assert.ok(after.custody.invocationId)
    await complete(runId)
  })
  await scenario("3. Worker exits while host is down", async () => {
    await start()
    const s = input("down")
    const runId = id(s)
    log("dispatch", await post(s))
    await snapshot(runId, "before-down")
    await stop()
    await wait(() => exists(join(root, "agent-processes", runId, "result.json")))
    await snapshot(runId, "exited-host-down")
    await start()
    await complete(runId)
  })
  await scenario("4. Absent and reused units", async () => {
    for (const reuse of [false, true]) {
      await start()
      const s = input(reuse ? "reuse" : "absent")
      const runId = id(s)
      await post(s)
      await stop()
      const before = await snapshot(runId, "before-unit-removal")
      const unit = before.custody.executionId
      await removeUnit(unit)
      await rm(before.custody.resultPath, { force: true })
      if (reuse) {
        assert.equal(
          (
            await command([
              "systemd-run",
              "--user",
              `--unit=${unit}`,
              "--description=unrelated scratch replacement",
              "/bin/sleep",
              "60",
            ])
          ).code,
          0,
        )
      }
      await start()
      const r = await terminal(runId)
      log("recovery-refusal", r)
      assert.ok(["operator_required", "failed"].includes(r.state))
      assert.match(r.diagnostic, /absent|missing|identity mismatch|without a result/)
      if (reuse) {
        const refusal = await post({ cancel: runId })
        log("reused-cancel-refusal", refusal)
        assert.equal(refusal._tag, "Failure")
        const after = await snapshot(runId, "reused-unit-protected")
        assert.match(after.unit.stdout, /ActiveState=active/)
        assert.ok(!after.unit.stdout.includes(`InvocationID=${before.custody.invocationId}`))
        await removeUnit(unit)
      }
    }
  })
  await scenario("5. Cancellation with SIGTERM-trapping child", async () => {
    await start()
    const s = input("trap")
    const runId = id(s)
    await post(s)
    await wait(async () =>
      (await readFile(join(root, "agent-processes", runId, "events.jsonl"), "utf8")).includes(
        "child-ready",
      ),
    )
    const before = await snapshot(runId, "before-cancel")
    const started = Date.now()
    log("cancel", await post({ cancel: runId }))
    log("cancel-duration-ms", Date.now() - started)
    const r = await terminal(runId)
    assert.equal(r.state, "cancelled")
    const after = await snapshot(runId, "after-cancel")
    assert.doesNotMatch(after.unit.stdout, /ActiveState=(active|activating|deactivating)/)
    assert.ok(Date.now() - started < 15000)
    await removeUnit(before.custody.executionId)
  })
  await scenario("6. Partial JSON output line", async () => {
    await start()
    const s = input("partial")
    const runId = id(s)
    const pending = post(s)
    await wait(() => exists(join(root, "agent-processes", runId, "events.jsonl")))
    await wait(async () =>
      (await readFile(join(root, "agent-processes", runId, "events.jsonl"), "utf8")).includes(
        '"par',
      ),
    )
    assert.equal(row(runId).state, "spawning")
    await snapshot(runId, "partial-line-pending")
    log("half-line", await readFile(join(root, "agent-processes", runId, "events.jsonl"), "utf8"))
    log("dispatch", await pending)
    await complete(runId)
    const output = await readFile(join(root, "agent-processes", runId, "events.jsonl"), "utf8")
    assert.equal(output.split("partial-once").length - 1, 1)
    const parsed = (
      await Promise.all(
        (await readdir(root))
          .filter((name) => /^host-\d+\.log$/.test(name))
          .map((name) => readFile(join(root, name), "utf8")),
      )
    )
      .flatMap((text) => text.split("\n"))
      .filter((line) =>
        line.includes('"parsedEvent":{"type":"agent_message","text":"partial-once"'),
      )
    if (!full) assert.equal(parsed.length, 1)
    log(
      "partial-parsed-count",
      full
        ? "not instrumented in full daemon; verified transition and persisted output asserted"
        : parsed.length,
    )
    assert.equal(
      db
        .query("SELECT count(*) AS n FROM evidence_transitions WHERE run_id=? AND state='verified'")
        .get(runId).n,
      1,
    )
  })
  await scenario("7. Output bound and retention cleanup", async () => {
    await start()
    const s = input("limit")
    const runId = id(s)
    await post(s)
    await terminal(runId)
    await snapshot(runId, "before-retention-cleanup")
    const path = join(root, "agent-processes", runId)
    const bytes = (await stat(join(path, "events.jsonl"))).size
    log("bounded-bytes", bytes)
    assert.equal(bytes, full ? 10 * 1024 * 1024 : 4096)
    const stderrBytes = (await stat(join(path, "stderr.log"))).size
    assert.equal(stderrBytes, full ? 10 * 1024 * 1024 : 4096)
    log("bounded-stderr-bytes", stderrBytes)
    if (full) {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60_000)
      await utimes(join(path, "result.json"), old, old)
      log(
        "retention-fixture",
        "aged scratch result mtime eight days; production seven-day retention",
      )
    } else await Bun.sleep(1200)
    await start()
    assert.equal(await exists(path), false)
    log("retention-cleanup", { runId, removed: true, row: row(runId) })
  })
  await scenario("8. Manager unavailable, identical retry", async () => {
    await start({ EVIDENCE_UNAVAILABLE: "1" })
    const s = input("unavailable")
    const refused = await post(s)
    log("unavailable-refusal", refused)
    assert.equal(refused._tag, "Failure")
    assert.equal(refused.failure.reason, "systemd_unavailable")
    assert.equal(row(id(s)), null)
    await start()
    log("identical-retry", await post(s))
    await complete(id(s))
  })
  await scenario("9. Defaults and non-Codex route separation", async () => {
    await start({ EVIDENCE_UNAVAILABLE: "1" })
    const count = (await owned()).length
    const s = input("other", "route-separation", "other")
    const receipt = await post(s)
    log("non-codex-receipt", receipt)
    assert.equal(receipt._tag, "Success")
    assert.equal(row(id(s)).state, "verified")
    assert.equal((await owned()).length, count)
    log("non-codex-row", { row: row(id(s)), newUnits: 0 })
    const source = await readFile(resolve("src/kernel/codex-session.ts"), "utf8")
    assert.ok(source.includes('options.unitPrefix ?? "workflowd-agent-"'))
    log("defaults", {
      codex: "transient-exec, default workflowd-agent- prefix, 10 MiB/file, 7 day retention",
      nonCodex:
        "production ingress dispatches OpenCode protocol fixture with manager unavailable; no unit created",
    })
  })
  await scenario("1b. Real short Codex model turn", async () => {
    const binary = process.env.EVIDENCE_REAL_CODEX_BINARY
    assert.ok(
      binary,
      "BLOCKED: set EVIDENCE_REAL_CODEX_BINARY; EVIDENCE_COPY_AUTH=1 requires explicit owner permission to copy only the Codex login file",
    )
    await start({ EVIDENCE_BINARY: binary })
    const s = input(
      "real",
      "Run the shell command sleep 12, then reply exactly EVIDENCE59_REAL_OK. Do not read files or do anything else.",
    )
    const pending = post(s).catch(() => null)
    const runId = id(s)
    await wait(async () => {
      try {
        return (
          await readFile(join(root, "agent-processes", runId, "events.jsonl"), "utf8")
        ).includes("command_execution")
      } catch {
        return false
      }
    }, 120000)
    const before = await snapshot(runId, "real-before-restart")
    assert.ok(before.custody.invocationId)
    await stop("SIGTERM")
    await pending
    const down = await snapshot(runId, "real-host-down")
    assert.match(down.unit.stdout, /ActiveState=active/)
    assert.equal(await exists(before.custody.resultPath), false)
    await start({ EVIDENCE_BINARY: binary })
    const after = await snapshot(runId, "real-reattached")
    assert.match(after.unit.stdout, /ActiveState=active/)
    assert.equal(before.custody.launchId, after.custody.launchId)
    assert.equal(before.custody.invocationId, after.custody.invocationId)
    const r = await terminal(runId)
    log("real-terminal", r)
    assert.equal(r.state, "completed")
    assert.equal(
      db
        .query(
          "SELECT count(*) AS n FROM evidence_transitions WHERE run_id=? AND state='completed'",
        )
        .get(runId).n,
      1,
    )
    const output = await readFile(join(root, "agent-processes", runId, "events.jsonl"), "utf8")
    log("real-output", output)
    const messages = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "item.completed" && event.item.type === "agent_message")
    assert.equal(
      messages.filter((event) => event.item.text.trim() === "EVIDENCE59_REAL_OK").length,
      1,
    )
    assert.ok(r.last_output_tokens > 0)
  })
} catch (error) {
  results.push({ scenario: "Harness", result: "FAIL", detail: String(error) })
  log("harness-error", String(error))
} finally {
  interrupted = false
  await stop()
  await fullSetup?.fixture.stop(true)
  await rm(env.CODEX_HOME, { recursive: true, force: true })
  log("auth-cleanup", { absent: !(await exists(join(env.CODEX_HOME, "auth.json"))) })
  for (const unit of await owned()) {
    try {
      await removeUnit(unit)
    } catch (error) {
      results.push({ scenario: `Cleanup ${unit}`, result: "FAIL", detail: String(error) })
    }
  }
  const remaining = await command([
    "systemctl",
    "--user",
    "list-units",
    "--all",
    "--no-legend",
    `${prefix}*`,
  ])
  log("cleanup", remaining)
  if (remaining.code !== 0 || remaining.stdout.trim() !== "")
    results.push({ scenario: "Cleanup", result: "FAIL", detail: "scratch units still present" })
  if (db)
    log(
      "persisted-transitions",
      db.query("SELECT * FROM evidence_transitions ORDER BY rowid").all(),
    )
  db?.close()
  const table = [
    "| Scenario | Result | Detail |",
    "|---|---|---|",
    ...results.map(
      (x) =>
        `| ${x.scenario} | ${x.result} | ${(x.detail ?? "").replaceAll("\n", " ").replaceAll("|", "/")} |`,
    ),
  ].join("\n")
  await writeFile(
    join(root, "evidence.jsonl"),
    entries.map((x) => JSON.stringify(x)).join("\n") + "\n",
  )
  await writeFile(join(root, "summary.md"), table + "\n")
  console.log(table)
  console.log(`Evidence directory: ${root}`)
  process.exitCode = results.some((x) => x.result === "FAIL") ? 1 : 0
}
