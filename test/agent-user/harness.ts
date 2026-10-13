import { spawnSync } from "node:child_process"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

function probeEnvironment(home: string, path = "/usr/bin:/bin") {
  return {
    PATH: path,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
  }
}

function runtimePath() {
  const node = process.env.WORKFLOWD_AGENT_PROBE_NODE ?? Bun.which("node")
  if (!node) throw new Error("client_runtime_missing")
  return `${dirname(node)}:/usr/bin:/bin`
}

/** Only allow-listed metadata leaves the version subprocess; never raw CLI output. */
export async function probeClientVersions() {
  const root = await mkdtemp(join(tmpdir(), "workflowd-client-versions-"))
  const clients = [
    ["codex", "codex-cli 0.159.1", /^codex-cli \d+\.\d+\.\d+$/],
    ["claude", "2.1.296 (Claude Code)", /^\d+\.\d+\.\d+ \(Claude Code\)$/],
    ["opencode2", "opencode2 v0.0.0-beta-19242", /^opencode2 v\d+\.\d+\.\d+-beta-\d+$/],
  ] as const
  try {
    const versions = []
    for (const [client, expected, pattern] of clients) {
      const binary = Bun.which(client)
      if (!binary) throw new Error(`${client}: client_binary_missing`)
      const entrypoint = await realpath(binary)
      const inspect = (path: string) => {
        const result = spawnSync(binary, ["--version"], {
          cwd: root,
          env: probeEnvironment(root, path),
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 64 * 1024,
        })
        const output = result.stdout?.trim() ?? ""
        return {
          exitCode: result.status,
          signal: result.signal,
          spawnFailed: result.error !== undefined,
          nodeAvailable: Bun.which("node", { PATH: path }) !== null,
          version: pattern.test(output) ? output : null,
        }
      }
      const original = inspect("/usr/bin:/bin")
      const pinned = inspect(runtimePath())
      console.log(JSON.stringify({ client, entrypoint, original, pinned }))
      if (pinned.spawnFailed || pinned.signal || pinned.exitCode !== 0)
        throw new Error(`${client}: client_abnormal_exit`)
      if (pinned.version !== expected) throw new Error(`${client}: client_version_mismatch`)
      versions.push({ client, version: pinned.version, exitCode: pinned.exitCode })
    }
    return versions
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Installed-client prerequisite probe. All credentials and homes are synthetic. */
export async function probeCodexCredentialSharing() {
  const binary = Bun.which("codex")
  if (binary === null) throw new Error("Credential probe requires installed Codex")
  const root = await mkdtemp(join(tmpdir(), "workflowd-agent-credentials-"))
  const controller = join(root, "controller")
  const agent = join(root, "agent")
  const canonical = join(root, "auth.json")
  const authPath = (home: string) => join(home, ".codex", "auth.json")
  const command = (home: string, args: string[], input?: string) => {
    const result = spawnSync(binary, args, {
      cwd: root,
      env: probeEnvironment(home, runtimePath()),
      input,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    })
    if (result.error || result.signal !== null || result.status === null)
      throw new Error("Installed Codex probe did not finish normally")
    return result
  }
  const login = (home: string, value: string) => {
    const result = command(
      home,
      ["-c", 'cli_auth_credentials_store="file"', "login", "--with-api-key"],
      `${value}\n`,
    )
    if (result.status !== 0) throw new Error("Synthetic credential persistence failed")
  }
  const contains = async (path: string, value: string) => {
    const contents: unknown = JSON.parse(await readFile(path, "utf8"))
    return (
      typeof contents === "object" &&
      contents !== null &&
      "OPENAI_API_KEY" in contents &&
      contents.OPENAI_API_KEY === value
    )
  }
  try {
    for (const home of [controller, agent]) {
      await mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 })
      await symlink(canonical, authPath(home))
    }
    await writeFile(canonical, JSON.stringify({ OPENAI_API_KEY: "synthetic-initial" }))
    await chmod(canonical, 0o660)
    const versionResult = command(controller, ["--version"])
    const version = versionResult.stdout.trim()
    if (versionResult.status !== 0) throw new Error("codex: client_abnormal_exit")
    if (version !== "codex-cli 0.159.1") throw new Error("codex: client_version_mismatch")

    login(controller, "synthetic-update")
    const directUpdateShared =
      (await contains(canonical, "synthetic-update")) &&
      (await contains(authPath(agent), "synthetic-update")) &&
      (await lstat(authPath(controller))).isSymbolicLink()

    if (command(controller, ["-c", 'cli_auth_credentials_store="file"', "logout"]).status !== 0)
      throw new Error("Synthetic credential logout failed")
    login(controller, "synthetic-relogin")
    return {
      provider: "codex",
      version,
      uidCount: 1,
      directUpdateShared,
      relogin: {
        controllerLinkPreserved: (await lstat(authPath(controller))).isSymbolicLink(),
        controllerSeesReplacement: await contains(authPath(controller), "synthetic-relogin"),
        canonicalSeesReplacement: await contains(canonical, "synthetic-relogin"),
        agentSeesReplacement: await contains(authPath(agent), "synthetic-relogin"),
      },
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
