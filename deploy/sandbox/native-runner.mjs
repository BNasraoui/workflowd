// The harness of a runner run, which the run client starts with the launch on its standard input.
// Its standard output is Claude Code's stream-json lines and nothing else: the run client posts
// each of them as an event. It leaves the run's sealed result in <run directory>/result.
import { randomBytes } from "node:crypto"
import { appendFileSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath, pathToFileURL } from "node:url"
import { boxNetwork, boxPort, boxSentinel, command, docker, makeBox } from "./native-docker.mjs"

const tooling = dirname(fileURLToPath(import.meta.url))
/** What the run's stop (SIGTERM from the run client) does: the box, once made, is removed. */
let onStop = () => process.exit(1)

/**
 * The completion of the sealed result. A run in print mode names no title of its own, so the
 * title, the commit message and the body are fixed; the final message is the run's own.
 */
const completion = {
  title: "workflowd agent run",
  commitMessage: "workflowd agent run\n\nThe workspace of one agent run, sealed on its runner.\n",
  body: "The workspace of one agent run, sealed on its runner.",
}

/** The final message as the seal admits it: no control or format character but newline and tab. */
const finalText = (text) =>
  Buffer.from(text.replace(/(?![\n\t])[\p{Cc}\p{Cf}]/gu, ""), "utf8")
    .subarray(0, 65536)
    .toString("utf8")
    .replace(/�$/u, "")

/** The launch on standard input: at most 64 KiB, with the keys that the run client checked. */
async function readLaunch() {
  let raw = ""
  for await (const chunk of process.stdin) {
    raw += chunk
    if (Buffer.byteLength(raw) > 65536) throw new Error("launch: capacity")
  }
  const launch = JSON.parse(raw)
  if (
    typeof launch.prompt !== "string" ||
    typeof launch.model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/.test(launch.model) ||
    !/^[a-f0-9]{40}$/.test(launch.sourceSha) ||
    !Number.isSafeInteger(launch.repositoryId) ||
    !Number.isSafeInteger(launch.deadline)
  )
    throw new Error("launch: refused")
  return launch
}

/**
 * Runs Claude Code in print mode in the box, with the prompt on its standard input, and writes
 * each line of its stream to standard output. Resolves to the text of its last result line; fails
 * when it exits other than 0 or the run's deadline comes first.
 */
function runClaude(box, launch, log) {
  const child = box.spawn(
    [
      "/bin/claude", "-p", "--output-format", "stream-json", "--verbose",
      "--model", launch.model,
      // Print-mode turns must finish their commands before the run is sealed.
      "--settings", '{"env":{"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS":"1"}}',
      "--setting-sources", "user", "--dangerously-skip-permissions",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    ],
    {
      CLAUDE_CODE_OAUTH_TOKEN: boxSentinel,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${boxPort}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: launch.identity.name,
      GIT_AUTHOR_EMAIL: launch.identity.email,
      GIT_COMMITTER_NAME: launch.identity.name,
      GIT_COMMITTER_EMAIL: launch.identity.email,
    },
    launch.prompt,
  )
  let errors = ""
  child.stderr.on("data", (bytes) => {
    errors = (errors + bytes.toString("utf8")).slice(-4000)
  })
  const closed = new Promise((resolve) => {
    child.once("error", () => resolve(-1))
    child.once("close", (code) => resolve(code ?? -1))
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(0, launch.deadline - Date.now()))
  return (async () => {
    let result = ""
    let lines = 0
    let last = ""
    try {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        if (line.length === 0) continue
        lines += 1
        last = line
        process.stdout.write(`${line}\n`)
        try {
          const value = JSON.parse(line)
          if (value?.type === "result" && typeof value.result === "string") result = value.result
        } catch {
          // A line that is not JSON is posted as it is; the daemon's reader judges it.
        }
      }
      const code = await closed
      if (code !== 0) throw new Error(`claude: exit ${code}: ${errors.trim()}`)
      return result
    } finally {
      clearTimeout(timer)
      child.kill("SIGKILL")
      log(`claude lines: ${lines}; last: ${last.slice(0, 2000)}`)
      log(`claude errors: ${errors.trim()}`)
    }
  })()
}

/** The whole run in the box: its network, its image, the source, Claude Code, then the seal. */
async function runBox(directory, launch) {
  const native = join(directory, "native")
  await mkdir(native, { mode: 0o700 })
  // The job's private record of the run's steps, in its 0700 run directory, outside the box.
  const log = (line) => appendFileSync(join(native, "harness.log"), `${line}\n`, { mode: 0o600 })
  const step = async (name, operation) => {
    log(`step ${name}`)
    try {
      return await operation()
    } catch (error) {
      log(`failed ${name}: ${error instanceof Error ? error.message : "unknown"}`)
      throw error
    }
  }
  const box = makeBox({
    directory,
    image: launch.image,
    name: `workflowd-native-${randomBytes(16).toString("hex")}`,
  })
  onStop = async () => {
    log("stopped")
    await box.remove()
    process.exit(1)
  }
  try {
    await step("network", async () => {
      await docker("network", [
        "network", "create", "--subnet", boxNetwork.subnet,
        "-o", "com.docker.network.bridge.name=wfd-sandbox0", boxNetwork.name,
      ])
      // The box reaches no private, tailnet or metadata address, and not the host.
      await command("network rules", "/usr/bin/sudo", [
        "-n", "/bin/bash", join(tooling, "network.sh"), "host", boxNetwork.subnet,
      ])
    })
    await step("image", () => docker("image", ["pull", "--quiet", launch.image], { timeoutMs: 900000 }))
    await step("box", () => box.start())
    // The source, through the relay's Git route of the run's own repository, with no credential.
    await step("source", async () => {
      const git = ["git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.http.allow=always"]
      await box.exec("source init", [...git, "init", "--quiet"])
      await box.exec(
        "source fetch",
        [
          ...git, "-c", `http.extraHeader=Authorization: Bearer ${boxSentinel}`,
          "fetch", "--quiet", "--no-tags", "--depth=1",
          `http://127.0.0.1:${boxPort}/capabilities/v1/git/${launch.repositoryId}.git`, launch.sourceSha,
        ],
        { timeoutMs: 600000 },
      )
      await box.exec("source checkout", [...git, "checkout", "--quiet", "--detach", launch.sourceSha])
      if ((await box.exec("source head", ["git", "rev-parse", "HEAD"])).trim() !== launch.sourceSha)
        throw new Error("source head: mismatch")
      // The source objects for the seal, copied before the agent runs: no agent wrote them.
      await box.copyOut("source copy", "/workdir/.git", join(native, "source.git"))
    })
    const result = await step("claude", () => runClaude(box, launch, log))
    await step("stop", () => box.stop())
    await step("export", () => box.exportWorkspace(join(native, "capture.tar")))
    await step("seal", async () => {
      const python = (operation, input) =>
        command(operation, "/usr/bin/python3", ["-I", join(tooling, "result.py"), ...operation.split(" "), launch.sourceSha], {
          cwd: native,
          input,
          timeoutMs: 300000,
        })
      // The workspace archive, read by the seal; the run's own .git is never read.
      await python("native-export capture.tar")
      const sealed = JSON.parse(
        await python(
          "native-seal",
          JSON.stringify({
            completion: { ...completion, finalMessage: finalText(result) },
            sensitiveValues: [],
            identity: launch.identity,
          }),
        ),
      )
      if (sealed.empty === true) {
        // A run that changed nothing: its completion with no bundle, so its caller hears its end.
        const manifest = {
          sourceSha: launch.sourceSha,
          title: completion.title,
          body: completion.body,
          finalMessage: finalText(result),
        }
        await mkdir(join(directory, "result"), { mode: 0o700 })
        await writeFile(join(directory, "result", "result.json"), JSON.stringify(manifest), {
          mode: 0o600,
          flag: "wx",
        })
        return
      }
      await rename(join(native, "result"), join(directory, "result"))
    })
  } finally {
    await box.remove()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.once("SIGTERM", () => void onStop())
  try {
    const directory = process.env.WORKFLOWD_RUN_DIRECTORY
    if (directory === undefined || process.argv.length !== 2) throw new Error("harness refused")
    await runBox(directory, await readLaunch())
  } catch {
    // The run client reads only the exit code; the cause is in the run directory's harness.log.
    process.exitCode = 1
  }
}
