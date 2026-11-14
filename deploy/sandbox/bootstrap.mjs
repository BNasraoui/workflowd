import { createServer, connect } from "node:net"
import { chmod, writeFile } from "node:fs/promises"
import { spawn, execFileSync } from "node:child_process"
import { pipeline } from "node:stream"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export async function serveBootstrap({ directory, identity, issue, activate, timeoutMs = 60000 }) {
  let claimed = false
  const lifetime = new AbortController()
  const sockets = new Set()
  let resolveCompletion, rejectCompletion
  const completed = new Promise((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (claimed) {
      socket.destroy()
      return
    }
    claimed = true
    sockets.add(socket)
    let data = ""
    let phase = 0
    let work = Promise.resolve()
    const fail = () => {
      rejectCompletion(new Error("private bootstrap refused"))
      close()
    }
    socket.on("error", fail)
    socket.on("close", () => {
      sockets.delete(socket)
      if (phase !== 2) fail()
    })
    socket.on("end", () => {
      void work.then(() => {
        if (phase !== 2) fail()
      })
    })
    socket.on("data", (bytes) => {
      data += bytes.toString("utf8")
      if (data.length > 16384) {
        fail()
        return
      }
      const at = data.indexOf("\n")
      if (at === -1) return
      const line = data.slice(0, at)
      data = data.slice(at + 1)
      work = work
        .then(async () => {
          lifetime.signal.throwIfAborted()
          const input = JSON.parse(line)
          if (phase === 0) {
            if (
              Object.keys(input).sort().join(",") !== "audience,peerId" ||
              input.peerId !== identity.peerId ||
              typeof input.audience !== "string" ||
              !/^workflowd:[A-Za-z0-9:._-]{1,512}$/.test(input.audience)
            )
              throw new Error()
            const token = await issue(input.audience, lifetime.signal)
            lifetime.signal.throwIfAborted()
            if (typeof token !== "string" || token.length > 16384) throw new Error()
            phase = 1
            socket.write(
              JSON.stringify({
                token,
                peerId: identity.peerId,
                agentImage: identity.agentImage,
                workflowSha: identity.workflowSha,
              }) + "\n",
            )
          } else if (phase === 1) {
            if (!["remote-tools", "actions-native"].includes(input.mode)) throw new Error()
            await activate(input, lifetime.signal)
            lifetime.signal.throwIfAborted()
            phase = 2
            socket.end('{"admitted":true}\n')
            clearTimeout(timer)
            server.close()
            resolveCompletion()
          } else throw new Error()
        })
        .catch(fail)
    })
  })
  const close = () => {
    rejectCompletion(new Error("private bootstrap refused"))
    lifetime.abort()
    clearTimeout(timer)
    for (const socket of sockets) socket.destroy()
    server.close()
  }
  const timer = setTimeout(() => {
    rejectCompletion(new Error("private bootstrap timeout"))
    close()
  }, timeoutMs)
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(`${directory}/bootstrap.sock`, resolve)
  })
  await chmod(`${directory}/bootstrap.sock`, 0o600)
  return { completed, close }
}

/** Transfer the runner's one-shot OIDC authority into helper-local custody. */
export function takeJobIdentity(environment, send = fetch) {
  let requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  let requestUrl = environment.ACTIONS_ID_TOKEN_REQUEST_URL
  delete environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  delete environment.ACTIONS_ID_TOKEN_REQUEST_URL
  return async (audience, signal) => {
    try {
      const url = new URL(requestUrl)
      if (
        url.protocol !== "https:" ||
        !url.hostname.endsWith(".actions.githubusercontent.com") ||
        url.username ||
        url.password ||
        !requestToken
      )
        throw new Error("job identity unavailable")
      url.searchParams.set("audience", audience)
      const response = await send(url, {
        headers: { authorization: `Bearer ${requestToken}` },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      })
      if (!response.ok || !response.body) throw new Error("job identity unavailable")
      let text = ""
      for await (const bytes of response.body) {
        text += Buffer.from(bytes).toString("utf8")
        if (text.length > 20000) throw new Error("job identity unavailable")
      }
      return JSON.parse(text).value
    } finally {
      requestToken = undefined
      requestUrl = undefined
    }
  }
}

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
