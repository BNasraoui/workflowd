import { spawnSync } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        CODEX_HOME: join(home, ".codex"),
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_STATE_HOME: join(home, "state"),
      },
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
    if (versionResult.status !== 0 || !/^codex-cli \d+\.\d+\.\d+$/.test(version))
      throw new Error("Unrecognized installed Codex version")

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
