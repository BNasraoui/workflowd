import { spawn } from "node:child_process"
import { readFile, stat, chmod, open, mkdir, rmdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ownNativeProcess } from "./native-command.mjs"

const environment = { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }
const docker = {
  spawn(args) {
    return spawn("/usr/bin/docker", args, { env: environment, stdio: ["pipe", "pipe", "pipe"] })
  },
  spawnCustodian(client) {
    return spawn("/usr/bin/python3", ["-I",fileURLToPath(new URL(client ? "./native-client.py" : "./claude-interactive.py",import.meta.url))], {env:environment,stdio:["pipe","pipe","pipe"]})
  },
  async command(args, input) {
    const child = this.spawn(args)
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000)
    child.stdin.on("error", () => {})
    child.stdin.end(input)
    const collect = async (stream) => {
      const chunks = []
      let bytes = 0
      for await (const chunk of stream) {
        bytes += chunk.length
        if (bytes > 1048576) throw new Error("Engine output capacity")
        chunks.push(chunk)
      }
      return Buffer.concat(chunks).toString("utf8")
    }
    try {
      const [code, output] = await Promise.all([closed, collect(child.stdout), collect(child.stderr)])
      if (code !== 0) throw new Error("Engine operation unconfirmed")
      return output
    } finally {
      clearTimeout(timer)
      child.kill("SIGKILL")
      await closed
    }
  },
}

/** The only engine boundary. No Docker socket or control directory enters the agent. */
export function makeNativeDockerBackend({ directory, image, nonce }, engine = docker) {
  if (!/^[a-f0-9]{64}$/.test(nonce) || !/^ghcr\.io\/bnasraoui\/workflowd-agent-base@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Native engine binding refused")
  const name = `workflowd-native-${nonce}`
  const cancelled = join(directory, "launch-cancelled")
  const allowLaunch = async () => {
    try { await stat(cancelled) }
    catch (error) { if (error.code === "ENOENT") return; throw error }
    throw new Error("Native launch cancelled")
  }
  const locked = async (operation) => {
    const lock = join(directory, "engine-operation")
    // A crashed owner leaves uncertainty for job cancellation, never a stale-lock
    // heuristic that could race a delayed Docker start with a successful stop.
    await mkdir(lock, { mode: 0o700 })
    let uncertain = false
    const mutate = async (...args) => {
      try { return await engine.command(...args) }
      catch (error) { uncertain = true; throw error }
    }
    // Killing a client or losing its reply does not join the daemon's operation.
    // Retain the lock on an unconfirmed mutation; readback alone may race it.
    try { return await operation(mutate) }
    finally { if (!uncertain) await rmdir(lock) }
  }
  const inspect = async () => {
    const value = JSON.parse(await engine.command(["inspect", name]))
    if (!Array.isArray(value) || value.length !== 1 ||
        !/^[a-f0-9]{64}$/.test(value[0].Id) ||
        value[0].Config?.Labels?.["io.workflowd.native"] !== nonce ||
        typeof value[0].State?.Running !== "boolean") throw new Error("Native engine custody refused")
    return value[0]
  }
  return {
    async start(request, signal) {
      let owned
      try { return await locked(async (mutate) => {
      await allowLaunch()
      const command = async (...args) => {
        signal?.throwIfAborted()
        await allowLaunch()
        const result = await mutate(...args)
        signal?.throwIfAborted()
        return result
      }
      if ((request.container ?? request.nonce) !== nonce) throw new Error("Native engine binding refused")
      if(!request.resume) {
      const archive = join(directory, "source.tar")
      const size = (await stat(archive)).size
      if (size <= 0 || size > 64 * 1048576) throw new Error("Native source capacity")
      // The containing host directory remains 0700; only this socket is mounted.
      // Its local sentinel is not an account identity or an upstream credential.
      await chmod(join(directory, "../gateway.sock"), 0o666)
      await command([
        "create", "--pull=never", "--name", name, "--label", `io.workflowd.native=${nonce}`,
        "--init", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--read-only", "--pids-limit", "256", "--memory", "2g", "--memory-swap", "2g",
        "--network", "workflowd-sandbox", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
        "--mount", `type=volume,source=${name}-workspace,target=/workdir`,
        "--mount", `type=volume,source=${name}-home,target=/home/agent`,
        "--mount", `type=bind,source=${join(directory, "../gateway.sock")},target=/run/workflowd-gateway.sock,readonly`,
        "--entrypoint", "/bin/python3", image, "/opt/workflowd/claude-interactive.py", "serve",
      ])
      await inspect()
      await command(["cp", "--archive", "-", `${name}:/workdir`], await readFile(archive))
      } else if((await inspect()).State.Running) throw new Error("Resume requires stopped custody")
      await command(["start", name])
      if (!(await inspect()).State.Running) throw new Error("Native container did not start")
      if (!request.client) await command(["exec", name, "/bin/python3", "/opt/workflowd/claude-interactive.py", "prepare"])
      signal?.throwIfAborted()
      owned = ownNativeProcess(engine.spawnCustodian(request.client))
      const { child } = owned
      const launch = {
        container:name, binary: "/bin/claude", home: "/home/agent", workspace: "/workdir", session: request.session,
        model: request.model, effort: request.effort, prompt: request.prompt, resume: request.resume === true,
        baseUrl: "http://127.0.0.1:31741", sentinel: "workflowd-local", deadline: request.deadline / 1000,
        tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      }
      if (request.client) {
        delete launch.sentinel; delete launch.tools; delete launch.allowedTools
        launch.client = request.client === "opencode" ? "opencode2" : request.client
        launch.binary = "/bin/" + launch.client
        launch.provider = request.provider
      }
      child.stdin.write(JSON.stringify(launch) + "\n")
      return owned
      }) } catch (error) {
        owned?.child.kill("SIGKILL")
        await owned?.closed
        throw error
      }
    },
    async stop({ cancelPending = false } = {}) {
      if (cancelPending) {
        // Permanent host-owned fence, including launches saved but not yet at the
        // engine lock. A racing active mutation still prevents acknowledgement.
        const marker = await open(cancelled, "a", 0o600)
        try { await marker.sync() } finally { await marker.close() }
        const parent = await open(directory, "r")
        try { await parent.sync() } finally { await parent.close() }
      }
      return locked(async (mutate) => {
      if ((await inspect()).State.Running) {
        await mutate(["kill", "--signal=KILL", name])
        await mutate(["wait", name])
      }
      if ((await inspect()).State.Running) throw new Error("Native container termination unconfirmed")
      })
    },
    async exportWorkspace() {
      return locked(async () => {
      if ((await inspect()).State.Running) throw new Error("Native export requires stopped custody")
      const file = await open(join(directory, "capture.tar"), "wx", 0o600)
      const { child, closed } = ownNativeProcess(engine.spawn(["cp", `${name}:/workdir/.`, "-"]))
      const timer = setTimeout(() => child.kill("SIGKILL"), 30000)
      child.stdin.end()
      child.stderr.resume()
      try {
        let size = 0
        for await (const chunk of child.stdout) {
          size += chunk.length
          if (size > 96 * 1048576) throw new Error("Native archive capacity")
          await file.write(chunk)
        }
        if (await closed !== 0) throw new Error("Native export failed")
      } finally {
        clearTimeout(timer)
        child.kill("SIGKILL")
        await closed
        await file.close()
      }
      })
    },
    async remove() {
      return locked(async (mutate) => {
      if ((await inspect()).State.Running) throw new Error("Native cleanup requires stopped custody")
      await mutate(["rm", name])
      await mutate(["volume", "rm", `${name}-workspace`, `${name}-home`])
      })
    },
  }
}
