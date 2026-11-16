import { spawn } from "node:child_process"
import { chmod, open } from "node:fs/promises"
import { join } from "node:path"
import { command, environment } from "./command.mjs"

/** The port of the box's entry, on the box's own loopback; claude-interactive.py serves it. */
export const boxPort = 31741
/** The fixed local credential of the box's port: not an account or a provider credential. */
export const boxSentinel = "workflowd-local"
/** The network of the run's boxes, as `network.sh host` drops its private destinations. */
export const boxNetwork = { name: "workflowd-sandbox", subnet: "172.30.0.0/24" }

/**
 * Runs `docker` with `args` and `input` on its standard input; resolves to its standard output,
 * and fails with the step's name and its last bytes of standard error when it exits other than 0
 * or outlives `timeoutMs`.
 */
export function docker(step, args, { input = "", timeoutMs = 120000, binary = "/usr/bin/docker" } = {}) {
  return command(step, binary, args, { input, timeoutMs })
}


/**
 * The box of one run: a container of the run's image, as the user 1000 with no capability, a
 * read-only root, bounded memory and processes, its workspace and home on volumes of its own, and
 * the relay's socket as its only mount from the host. No Docker socket and no file of the job
 * enters it. `name` names the container and its volumes; each carries the label
 * `io.workflowd.native`, by which `runner.sh stop` removes what a run left.
 */
export function makeBox({ directory, image, name }) {
  if (
    !/^workflowd-native-[a-f0-9]{32}$/.test(name) ||
    !/^ghcr\.io\/bnasraoui\/workflowd-agent-base@sha256:[a-f0-9]{64}$/.test(image)
  )
    throw new Error("box binding refused")
  const label = `io.workflowd.native=${name}`
  const volumes = { workspace: `${name}-workspace`, home: `${name}-home` }
  return {
    name,
    /** Creates the box and starts its entry, the port to the relay. */
    async start() {
      // The relay's directory stays 0700; the box's user reaches only this socket, by its mount.
      await chmod(join(directory, "gateway.sock"), 0o666)
      for (const volume of Object.values(volumes))
        await docker("box volume", ["volume", "create", "--label", label, volume])
      await docker("box create", [
        "create", "--pull=never", "--name", name, "--label", label,
        "--init", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--read-only", "--pids-limit", "256", "--memory", "2g", "--memory-swap", "2g",
        "--network", boxNetwork.name, "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
        "--mount", `type=volume,source=${volumes.workspace},target=/workdir`,
        "--mount", `type=volume,source=${volumes.home},target=/home/agent`,
        "--mount", `type=bind,source=${join(directory, "gateway.sock")},target=/run/workflowd-gateway.sock,readonly`,
        "--entrypoint", "/bin/python3", image, "/opt/workflowd/claude-interactive.py", "serve",
      ])
      await docker("box start", ["start", name])
      // The entry listens soon after the start; the source fetch needs its port.
      for (let attempt = 1; ; attempt++) {
        try {
          await docker("box port", [
            "exec", name, "/bin/python3", "-c",
            `import socket; socket.create_connection(("127.0.0.1", ${boxPort}), 1).close()`,
          ])
          return
        } catch (error) {
          if (attempt >= 50) throw error
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
    },
    /** Runs `args` in the box as its user, in its workspace, and resolves to its output. */
    exec(step, args, options = {}) {
      return docker(step, ["exec", "--user", "1000:1000", "--workdir", "/workdir", name, ...args], options)
    },
    /**
     * Starts `args` in the box as its user, in its workspace, with `env` and `input` on its
     * standard input; gives the process, whose standard output is the caller's to read.
     */
    spawn(args, env, input) {
      const child = spawn(
        "/usr/bin/docker",
        [
          "exec", "--interactive", "--user", "1000:1000", "--workdir", "/workdir",
          ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
          name, ...args,
        ],
        { env: environment, stdio: ["pipe", "pipe", "pipe"] },
      )
      child.stdin.on("error", () => undefined)
      child.stdin.end(input)
      return child
    },
    /** Copies the box's `path` to the host's `target`, as the job's user. */
    copyOut(step, path, target) {
      return docker(step, ["cp", `${name}:${path}`, target])
    },
    /** Stops each process of the box. */
    async stop() {
      await docker("box stop", ["kill", "--signal=KILL", name]).catch(() => undefined)
      await docker("box wait", ["wait", name])
    },
    /**
     * Writes the stopped box's workspace to `file` as a tar archive of at most 96 MiB; the seal
     * reads it, and nothing of it is extracted by Docker or tar on the host.
     */
    async exportWorkspace(file) {
      const output = await open(file, "wx", 0o600)
      try {
        const child = spawn("/usr/bin/docker", ["cp", `${name}:/workdir/.`, "-"], {
          env: environment,
          stdio: ["ignore", "pipe", "ignore"],
        })
        const closed = new Promise((resolve) => child.once("close", resolve))
        const timer = setTimeout(() => child.kill("SIGKILL"), 120000)
        try {
          let size = 0
          for await (const chunk of child.stdout) {
            size += chunk.length
            if (size > 96 * 1048576) throw new Error("box export: capacity")
            await output.write(chunk)
          }
          if ((await closed) !== 0) throw new Error("box export: failed")
        } finally {
          clearTimeout(timer)
          child.kill("SIGKILL")
        }
      } finally {
        await output.close()
      }
    },
    /** Removes the box and its volumes. */
    async remove() {
      await docker("box remove", ["rm", "-f", "-v", name]).catch(() => undefined)
      await docker("box volumes", ["volume", "rm", "-f", ...Object.values(volumes)]).catch(
        () => undefined,
      )
    },
  }
}
