import { spawn } from "node:child_process"
import { lstat, readFile, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"
import { serveRunnerRelay } from "./capability-relay.mjs"
import {
  maxEventBatchBytes,
  maxResultBundleBytes,
  maxResultManifestBytes,
} from "./capability-limits.mjs"

/**
 * The run client of a runner job. It holds the relay in its own process, so the run token and the
 * session key stay in this one process outside the box. It reads the run's launch from the
 * gateway, runs the harness with it, posts the harness's event lines in numbered batches, and
 * posts the run's one sealed result. The box reaches only the relay's model and Git routes.
 */

const root = "/run/workflowd-sandbox"
const imagePattern = /^ghcr\.io\/bnasraoui\/workflowd-agent-base@sha256:[a-f0-9]{64}$/
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/**
 * The longest time with no post of the run: a quiet harness posts an empty batch then, so the
 * daemon tells a quiet run from a lost one (it ends a run lost after 120 s with no post).
 */
const heartbeatMs = 10000
/** The time a harness has to end after its stop, before it is killed. */
const stopGraceMs = 30000

/**
 * Sends one run route request until the gateway answers it: a 429, a 503 or a lost connection is
 * sent again, the same bytes, after a pause; any other answer is the answer. A relay that ended
 * its session sends nothing more.
 */
async function sent(relay, route, body, attempts = 8) {
  for (let attempt = 1; ; attempt++) {
    try {
      const answer = await relay.runRoute(route, body)
      if (answer.status !== 429 && answer.status !== 503) return answer
    } catch (error) {
      if (error instanceof Error && error.message === "relay stopped") throw error
      // Sent again below, as a busy gateway is.
    }
    if (attempt >= attempts) throw new Error(`run ${route} unavailable`)
    await pause(Math.min(30000, 1000 * 2 ** (attempt - 1)))
  }
}

/** The agent Git identity of a launch: a name and an address, as the seal takes them. */
const identityOf = (identity) =>
  typeof identity === "object" &&
  identity !== null &&
  Object.keys(identity).sort().join() === "email,name" &&
  typeof identity.name === "string" &&
  typeof identity.email === "string"

/**
 * The run's launch, as the gateway holds it: its prompt, its image, the agent Git identity, its
 * model, its source commit, its repository and its deadline, and no other key. A launch whose
 * image is not the job's own is refused.
 */
export async function readLaunch(relay, jobImage) {
  const answer = await sent(relay, "launch")
  if (answer.status !== 200) throw new Error("launch refused")
  const launch = JSON.parse(answer.body.toString("utf8"))
  if (
    Object.keys(launch).sort().join() !==
      "deadline,identity,image,model,prompt,repositoryId,sourceSha" ||
    typeof launch.prompt !== "string" ||
    !identityOf(launch.identity) ||
    !Number.isSafeInteger(launch.repositoryId) ||
    launch.repositoryId < 1 ||
    typeof launch.model !== "string" ||
    !imagePattern.test(launch.image) ||
    !/^[a-f0-9]{40}$/.test(launch.sourceSha) ||
    !Number.isSafeInteger(launch.deadline) ||
    launch.image !== jobImage
  )
    throw new Error("launch refused")
  return launch
}

/**
 * Posts event lines in batches numbered 1, 2, 3, … of at most `maxEventBatchBytes` each. A line
 * that cannot fit a batch alone is replaced by a line that names its size. `flush` posts what is
 * held; `beat` posts an empty batch when nothing was posted for `heartbeatMs`. A batch that the
 * gateway refuses, or that the relay cannot send once its session ended, ends the poster and
 * calls `refused` once: the run is stopped, revoked or past its time.
 */
export function eventPoster(relay, refused = () => undefined) {
  let sequence = 0
  let held = []
  let queue = Promise.resolve()
  let posted = Date.now()
  let ended = false
  // The batch is sized with the largest sequence number, so a batch never passes the bound.
  const encoded = (lines) => Buffer.from(JSON.stringify({ sequence: 1_000_000, lines }))
  const body = (lines) => Buffer.from(JSON.stringify({ sequence: sequence + 1, lines }))
  const post = (lines) => {
    posted = Date.now()
    queue = queue.then(async () => {
      const answer = await sent(relay, "events", body(lines)).catch((error) => {
        if (error instanceof Error && error.message === "relay stopped") return { status: 0 }
        throw error
      })
      if (answer.status !== 204) {
        if (!ended) refused()
        ended = true
        throw new Error("events refused")
      }
      sequence += 1
    })
    return queue
  }
  return {
    add(line) {
      const kept = encoded([line]).length > maxEventBatchBytes
        ? JSON.stringify({ type: "workflowd.line_dropped", bytes: Buffer.byteLength(line) })
        : line
      if (held.length > 0 && encoded([...held, kept]).length > maxEventBatchBytes) {
        void post(held).catch(() => undefined)
        held = []
      }
      held.push(kept)
    },
    flush() {
      if (held.length > 0) {
        void post(held).catch(() => undefined)
        held = []
      }
      return queue
    },
    beat() {
      if (held.length === 0 && Date.now() - posted >= heartbeatMs)
        void post([]).catch(() => undefined)
    },
  }
}

/** A file of the result, at most `limit` bytes and not a link. */
async function resultFile(path, limit) {
  const info = await lstat(path)
  if (!info.isFile() || info.size === 0 || info.size > limit) throw new Error("result refused")
  return readFile(path)
}

/** The result body: the 4-byte big-endian length of result.json, result.json, result.bundle. */
export function framedResult(manifest, bundle) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(manifest.length)
  return Buffer.concat([head, manifest, bundle])
}

/**
 * Posts the run's one result, read from `directory`/result. A run that changed nothing leaves
 * result.json and no bundle: its result has an empty bundle.
 */
export async function postResult(relay, directory) {
  const manifest = await resultFile(`${directory}/result/result.json`, maxResultManifestBytes)
  const bundlePath = `${directory}/result/result.bundle`
  const unchanged = await lstat(bundlePath).then(
    () => false,
    (error) => error?.code === "ENOENT",
  )
  const bundle = unchanged ? Buffer.alloc(0) : await resultFile(bundlePath, maxResultBundleBytes)
  const answer = await sent(relay, "result", framedResult(manifest, bundle))
  if (answer.status !== 204) throw new Error("result refused")
}

/**
 * Runs the harness `command` with the launch on its standard input. Each line of its standard
 * output is an event line; it leaves its sealed result below `directory`/result. Resolves to the
 * harness's exit code once every line it wrote is posted. When the gateway refuses a batch (the
 * run's stop revoked it), the harness gets SIGTERM, removes its box and ends; one that has not
 * ended after `stopGraceMs` is killed. The run then fails as stopped.
 */
export async function runHarness(relay, directory, command, launch) {
  let stopped = false
  let killer
  const poster = eventPoster(relay, () => {
    stopped = true
    child.kill("SIGTERM")
    killer = setTimeout(() => child.kill("SIGKILL"), stopGraceMs)
  })
  const child = spawn(command[0], command.slice(1), {
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", WORKFLOWD_RUN_DIRECTORY: directory },
    stdio: ["pipe", "pipe", "ignore"],
  })
  const exited = new Promise((resolve) => {
    child.once("error", () => resolve(-1))
    child.once("close", (code) => resolve(code ?? -1))
  })
  child.stdin.on("error", () => undefined)
  child.stdin.end(JSON.stringify(launch))
  const timer = setInterval(() => {
    void poster.flush().catch(() => undefined)
    poster.beat()
  }, 2000)
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity }))
      if (line.length > 0) poster.add(line)
    const code = await exited
    if (stopped) throw new Error("run stopped")
    await poster.flush()
    return code
  } finally {
    clearInterval(timer)
    clearTimeout(killer)
    child.kill("SIGKILL")
  }
}

/** The whole job: the relay, the launch, the harness, then the result. */
export async function runJob(config, directory, command) {
  const relay = await serveRunnerRelay(config, directory)
  try {
    process.stdout.write("ready\n")
    const jobImage = (await readFile(`${directory}/agent-image`, "utf8")).trim()
    const launch = await readLaunch(relay, jobImage)
    const code = await runHarness(relay, directory, command, launch)
    if (code !== 0) throw new Error("harness failed")
    await postResult(relay, directory)
    // The job's hold step reads this end: the run's one result is posted.
    await writeFile(`${directory}/relay-ended`, "result\n", { mode: 0o600 })
  } finally {
    relay.close()
  }
}

async function configInput() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 16384) throw new Error("run client configuration refused")
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `run-client.mjs runner <directory> -- <harness command...>`
  const [operation, directory = root, separator, ...command] = process.argv.slice(2)
  try {
    if (operation !== "runner" || separator !== "--" || command.length === 0)
      throw new Error("run client operation refused")
    await runJob(await configInput(), directory, command)
  } catch {
    // The public log of the job shows only that the step failed, never a cause.
    process.stderr.write("run client failed\n")
    process.exitCode = 1
  }
}
