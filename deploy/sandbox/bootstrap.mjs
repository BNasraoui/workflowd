import { connect } from "node:net"
import { writeFile } from "node:fs/promises"
import { spawn, execFileSync } from "node:child_process"
import { pipeline } from "node:stream"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { serveBootstrap, takeJobIdentity } from "./bootstrap-helper.mjs"

async function prepare() {
  const directory = "/run/workflowd-sandbox"
  const tooling = dirname(fileURLToPath(import.meta.url))
  const status = JSON.parse(
    execFileSync("/usr/local/bin/tailscale", ["status", "--json"], {
      env: { PATH: "/usr/bin:/bin" },
      maxBuffer: 1048576,
    }).toString(),
  )
  const peerId = status.Self?.ID
  const image = process.env.SANDBOX_AGENT_IMAGE
  const workflowSha = process.env.GITHUB_SHA
  if (
    typeof peerId !== "string" ||
    !/^ghcr\.io\/bnasraoui\/workflowd-agent-base@sha256:[a-f0-9]{64}$/.test(image ?? "") ||
    !/^[a-f0-9]{40}$/.test(workflowSha ?? "")
  )
    throw new Error()
  await writeFile(`${directory}/agent-image`, image, { mode: 0o600 })
  await writeFile(
    `${directory}/identity.json`,
    JSON.stringify({
      repository: process.env.GITHUB_REPOSITORY,
      leaseId: process.env.GITHUB_REF?.replace("refs/heads/workflowd/leases/", ""),
    }),
    { mode: 0o600 },
  )
  const issue = takeJobIdentity(process.env)
  const helper = await serveBootstrap({
    directory,
    identity: { peerId, agentImage: image, workflowSha },
    issue,
    activate: async (grant, signal) => {
      const env = {
        PATH: "/usr/bin:/bin",
        HOME: "/home/runner",
        ...(process.env.RUNNER_TRACKING_ID
          ? { RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID }
          : {}),
      }
      if (grant.mode === "actions-native") {
        await writeFile(`${directory}/native-deadline`, String(grant.deadline), { mode: 0o600, flag: "wx" })
        const child = spawn(process.execPath, [`${tooling}/capability-relay.mjs`, "runner"], {
          env,
          signal,
          stdio: ["pipe", "pipe", "ignore"],
        })
        child.stdin.end(JSON.stringify(grant))
        await new Promise((resolve, reject) => {
          child.once("error", reject)
          child.once("exit", () => reject(new Error("relay unavailable")))
          child.stdout.once("data", (bytes) =>
            bytes.toString() === "ready\n" ? resolve() : reject(new Error("relay unavailable")),
          )
        })
        child.stdout.destroy()
        child.unref()
        await writeFile(`${directory}/relay.pid`, String(child.pid), { mode: 0o600 })
      } else {
        await new Promise((resolve, reject) => {
          const child = spawn("/bin/bash", [`${tooling}/runner.sh`, "private-start"], {
            env,
            signal,
            stdio: "ignore",
          })
          child.once("error", reject)
          child.once("exit", (code) =>
            code === 0 ? resolve() : reject(new Error("runner unavailable")),
          )
        })
      }
      await writeFile(`${directory}/execution-mode`, grant.mode, { mode: 0o600 })
    },
  })
  await helper.completed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "prepare") await prepare()
    else if (process.argv[2] === "prove") {
      const socket = connect("/run/workflowd-sandbox/bootstrap.sock")
      pipeline(process.stdin, socket, (error) => {
        if (error) socket.destroy()
      })
      pipeline(socket, process.stdout, (error) => {
        if (error) socket.destroy()
      })
    } else throw new Error()
  } catch {
    process.stderr.write("private bootstrap unavailable\n")
    process.exitCode = 1
  }
}
