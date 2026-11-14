// Fixed SSH operations. Every child byte is private; stdout contains only bound receipts.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"
import { makeNativeDockerBackend } from "./native-docker.mjs"
import { nativeControlLines, superviseNative } from "./native-supervisor.mjs"
import { captureNativeResult } from "./native-capture.mjs"
import { nativeCommand } from "./native-command.mjs"

const root = "/run/workflowd-sandbox"
const directory = join(root, "native")
const tooling = dirname(fileURLToPath(import.meta.url))
const lifetime = new AbortController()
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) process.once(signal, () => {
  lifetime.abort()
  process.stdin.destroy()
})
const command = (args, input = "") => nativeCommand(args, input, { directory, signal: lifetime.signal })

async function main(operation) {
  if (await readFile(join(root, "execution-mode"), "utf8") !== "actions-native") throw new Error("Native mode required")
  const image = (await readFile(join(root, "agent-image"), "utf8")).trim()
  if (operation === "native-initialize") {
    let raw = ""
    for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 4096) throw new Error("Source capacity") }
    const request = JSON.parse(raw)
    const identity = JSON.parse(await readFile(join(root, "identity.json"), "utf8"))
    if (Object.keys(request).sort().join() !== "repository,sourceSha" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository) || request.repository !== identity.repository ||
      !/^[a-f0-9]{40}$/.test(request.sourceSha)) throw new Error("Source binding refused")
    // Exclusive initialization: uncertainty is not a reason to clone/restart again.
    await mkdir(directory, { mode: 0o700 })
    const git = ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "http.extraHeader=", "-c", "protocol.file.allow=never"]
    await command([...git, "init", "--bare", "source.git"])
    await command([...git, "-C", "source.git", "fetch", "--no-tags", "--", `https://github.com/${request.repository}.git`, request.sourceSha])
    await command(["/usr/bin/python3", "-I", join(tooling, "result.py"), "native-source", request.sourceSha])
    await command(["/usr/bin/docker", "pull", image])
    await command(["/usr/bin/docker", "network", "create", "--ipv6", "--subnet", "172.30.0.0/24", "--subnet", "fd42:7766:6400::/64", "-o", "com.docker.network.bridge.name=wfd-sandbox0", "workflowd-sandbox"])
    await command(["/usr/bin/sudo", "-n", "/bin/bash", join(tooling, "network.sh"), "host", "172.30.0.0/24"])
    await writeFile(join(root, "source.sha"), request.sourceSha, { mode: 0o600, flag: "wx" })
    console.log(request.sourceSha)
    return
  }
  if (operation === "native-execute") {
    const iterator = nativeControlLines(process.stdin)
    const first = await iterator.next()
    if (first.done || Buffer.byteLength(first.value) > 1048576) throw new Error("Launch capacity")
    const request = JSON.parse(first.value)
    const deadline = Number(await readFile(join(root, "native-deadline"), "utf8"))
    const native = request.client === "codex" || request.client === "opencode"
    if (Object.keys(request).sort().join() !== (native ? "client,container,deadline,effort,model,nonce,predecessor,prompt,provider,resume,session" : "container,deadline,effort,model,nonce,predecessor,prompt,resume,session") || request.deadline !== deadline ||
      (native && !/^[A-Za-z0-9_-]{1,128}$/.test(request.provider)) ||
      !/^[a-f0-9]{64}$/.test(request.container) || typeof request.resume!=="boolean" ||
      (request.resume ? !/^[a-f0-9]{64}$/.test(request.predecessor) : request.predecessor!==null) ||
      typeof request.prompt !== "string" || typeof request.model !== "string" || !(native ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high", "max"]).includes(request.effort)) throw new Error("Launch binding refused")
    const control = Readable.from((async function* () { for (;;) { const line = await iterator.next(); if (line.done) return; yield line.value + "\n" } })())
    const backend = makeNativeDockerBackend({ directory, image, nonce: request.container })
    try {
      await superviseNative({ directory, request, backend, control, event: value => console.log(JSON.stringify(value)) })
    } finally {
      control.destroy()
      process.stdin.destroy()
      await iterator.return()
    }
    return
  }
  const invocation = JSON.parse(await readFile(join(directory, "invocation.json"), "utf8"))
  const backend = makeNativeDockerBackend({ directory, image, nonce: invocation.container })
  if (operation === "native-evidence") {
    const pty = await readFile(join(directory, `pty-${invocation.nonce}.log`))
    if (pty.length > 1048576) throw new Error("Private evidence capacity")
    console.log(JSON.stringify({ nonce: invocation.nonce, session: invocation.session, pty: pty.toString("base64") }))
  } else if (operation === "native-stop") {
    await backend.stop({ cancelPending: true })
    console.log(JSON.stringify({ nonce: invocation.nonce, session: invocation.session, stopped: true }))
  } else if (operation === "native-result") {
    if (invocation.state !== "stopped" || invocation.outcome !== "completed") throw new Error("Capture custody refused")
    let raw = ""
    for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 65536) throw new Error("Result capacity") }
    console.log(await captureNativeResult({ root, directory, invocation, request: JSON.parse(raw), backend, command, tooling }))
  } else if (operation === "native-cleanup") {
    await backend.stop({ cancelPending: true })
    await backend.remove()
  } else throw new Error("Native operation refused")
}

try { await main(process.argv[2]) } catch {
  // No stack/message can expose private task or launch bytes to the SSH caller.
  process.stderr.write("Native operation failed\n")
  process.exitCode = 1
}
