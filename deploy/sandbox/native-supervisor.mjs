import { open, rename, readFile, mkdir, rmdir } from "node:fs/promises"
import { join } from "node:path"

/** Bound bytes before delimiter discovery; readline alone can buffer an unlimited line. */
export async function* nativeControlLines(input) {
  const buffer = Buffer.allocUnsafe(1048576)
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let size = 0, records = 0
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    let offset = 0
    while (offset < chunk.length) {
      const boundary = chunk.indexOf(10, offset)
      const end = boundary === -1 ? chunk.length : boundary
      const length = end - offset
      if (records >= 3 || size + length > (records === 0 ? 1048576 : 4096))
        throw new Error("Native control capacity")
      chunk.copy(buffer, size, offset, end)
      size += length
      offset = end + 1
      if (boundary !== -1) {
        const line = decoder.decode(buffer.subarray(0, size))
        size = 0
        records++
        yield line
      }
    }
  }
  if (size) throw new Error("Incomplete native control record")
}

async function save(directory, value, exclusive = false) {
  const name = exclusive ? "invocation.json" : "invocation.next"
  const file = await open(join(directory, name), exclusive ? "wx" : "w", 0o600)
  try {
    await file.writeFile(JSON.stringify(value))
    await file.sync()
  } finally { await file.close() }
  if (!exclusive) await rename(join(directory, name), join(directory, "invocation.json"))
  const parent = await open(directory, "r")
  try { await parent.sync() } finally { await parent.close() }
}

async function joined(exit) {
  let timer
  try {
    return await Promise.race([exit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Native process join unconfirmed")), 2000)
    })])
  } finally { clearTimeout(timer) }
}

/** Host custody around an owned process port. Only the backend can confirm container shutdown. */
export async function superviseNative({ directory, request, backend, control, event }) {
  const assignedSession = request.client === "codex" || request.client === "opencode"
  const validSession = value => typeof value === "string" && (request.client === "opencode" ? /^ses_[A-Za-z0-9]{20,64}$/ : /^[a-f0-9-]{36}$/).test(value)
  if (!/^[a-f0-9]{64}$/.test(request.nonce) ||
      !(assignedSession && request.resume ? validSession(request.session) : /^[a-f0-9-]{36}$/.test(request.session)) ||
      !Number.isSafeInteger(request.deadline) || request.deadline <= Date.now() ||
      request.deadline > Date.now() + 285 * 60000) throw new Error("Native request refused")
  const identity = { nonce: request.nonce, container: request.container ?? request.nonce,
    session: request.session, deadline: request.deadline, model:request.model, effort:request.effort,
    ...(assignedSession ? {client:request.client,provider:request.provider} : {}) }
  // Exclusive reservation is also the replay barrier after an SSH/coordinator loss.
  const lock=join(directory,"invocation-operation")
  await mkdir(lock,{mode:0o700})
  try {
    if(request.resume) {
      const prior=JSON.parse(await readFile(join(directory,"invocation.json"),"utf8"))
      if(prior.state!=="paused" || prior.outcome!=="paused" || prior.nonce!==request.predecessor || prior.nonce===request.nonce ||
        ["container","session","deadline","model","effort","client","provider"].some(key=>prior[key]!==identity[key])) throw new Error("Native resume refused")
    }
    await save(directory, { ...identity, state: "launching" }, !request.resume)
  } catch(error) {await rmdir(lock);throw error}
  let child, timer, closureTimer, killTimer, listener, ended, closed, capture
  let outcome = "operator_required"
  let started = false, failed = false, closureRequested
  let cancelled = false
  const startup = new AbortController()
  let nativeClose
  let pty
  const interrupt = (cancel = false) => {
    if (cancel) cancelled = true
    else failed = true
    startup.abort()
    if(child && !child.stdin.destroyed) child.stdin.write('{"operation":"cancel"}\n')
    if(child && !killTimer) killTimer=setTimeout(()=>{
      failed=true
      child.kill("SIGKILL")
      child.stdout.destroy()
      child.stderr.destroy()
    },3000)
  }
  const fail = () => interrupt()
  try {
    timer = setTimeout(fail, Math.max(0, request.deadline - Date.now()))
    let input = ""
    listener = (bytes) => {
      input += bytes.toString("utf8")
      if (input.length > 4096) return fail()
      let boundary
      while ((boundary = input.indexOf("\n")) !== -1) {
        const line = input.slice(0, boundary)
        input = input.slice(boundary + 1)
        try {
          const command = JSON.parse(line)
          if (Object.keys(command).length !== 1 ||
                !(command.operation === "cancel" || (["finish","pause"].includes(command.operation) && started && !closureRequested))) return fail()
           if (command.operation === "cancel") { interrupt(true); return }
            if (["finish","pause"].includes(command.operation)) closureRequested = command.operation
          if (!child.stdin.write(JSON.stringify(command) + "\n")) control.pause()
        } catch { fail() }
      }
    }
    ended = () => fail()
    control.on("data", listener)
    control.once("end", ended)
    control.once("error", ended)
    if (control.destroyed || control.readableEnded) fail()
    startup.signal.throwIfAborted()
    pty = await open(join(directory, `pty-${request.nonce}.log`), "wx", 0o600)
    // Startup must settle before stop can acknowledge custody. Abort prevents
    // later startup steps; the backend joins its current bounded engine call.
    ;({ child, closed } = await backend.start(request, startup.signal))
    child.stdin.on("drain", () => control.resume())
    startup.signal.throwIfAborted()
    capture = (async () => {
      let bytes = 0
      for await (const chunk of child.stderr) {
        bytes += chunk.length
        if (bytes > 1048576) throw new Error("Private PTY capacity")
        await pty.write(chunk)
      }
    })().catch(() => { if (!cancelled) fail() })
    let buffer = "", eventCount = 0
    for await (const chunk of child.stdout) {
      if (nativeClose) throw new Error("Native events after closure")
      buffer += chunk.toString("utf8")
      if (buffer.length > 65536) throw new Error("Native event capacity")
      let boundary
      while ((boundary = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 1)
        const message = JSON.parse(line)
        if (nativeClose) throw new Error("Native events after closure")
        if (++eventCount > 32 || ((started || !assignedSession || request.resume) ? message.session !== identity.session : !validSession(message.session))) throw new Error("Native event refused")
        if (message.event === "started" && !started) {
          started = true
          identity.session = message.session
          await save(directory, { ...identity, state: "running" })
          event({ event: "started", nonce: identity.nonce, session: identity.session })
        } else if (message.event === "closed" && started && !nativeClose &&
          ["completed", "paused", "cancelled", "operator_required"].includes(message.outcome) && Number.isInteger(message.exitCode)) {
          nativeClose = message
          clearTimeout(closureTimer)
          closureTimer = setTimeout(fail, 2000)
        } else throw new Error("Native event refused")
      }
    }
    const [code] = await joined(Promise.all([closed, capture]))
    if (!failed && !buffer && code === 0 && nativeClose) {
      if (nativeClose.outcome === "cancelled") outcome = "cancelled"
      else if (closureRequested && nativeClose.outcome === (closureRequested==="pause"?"paused":"completed") && nativeClose.exitCode === 0) outcome = nativeClose.outcome
    }
  } catch { if (!cancelled) fail() }
  finally {
    clearTimeout(timer)
    clearTimeout(closureTimer)
    clearTimeout(killTimer)
    if (listener) control.off("data", listener)
    if (ended) { control.off("end", ended); control.off("error", ended) }
    child?.kill("SIGKILL")
    child?.stdout.destroy()
    child?.stderr.destroy()
    try { await joined(closed) } catch { failed = true }
    await capture
    await pty?.close()
  }
  if (failed) outcome = "operator_required"
  else if (cancelled) outcome = "cancelled"
  let stopped = false
  try { await backend.stop(); stopped = true } catch { outcome = "operator_required" }
  await save(directory, { ...identity, state: stopped ? (outcome==="paused"?"paused":"stopped") : "uncertain", outcome })
  if(stopped) await rmdir(lock)
  event({ event: "closed", nonce: identity.nonce, session: identity.session, outcome, stopped })
  return outcome
}
