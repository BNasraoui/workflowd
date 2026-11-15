import { createServer } from "node:net"
import { chmod } from "node:fs/promises"

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
