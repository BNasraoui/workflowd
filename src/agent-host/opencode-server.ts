import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { agentGitEnvironment, loadAgentGitConfig } from "../agent-git/config"
import { workerEnvironment } from "../resident/environment"

/** The shared server receives its own configuration and no controller credential environment. */
export function agentOpenCodeEnvironment(
  env: Record<string, string | undefined>,
  identity = { uid: process.getuid!(), gid: process.getgid!(), groups: process.getgroups!() },
): Record<string, string> {
  const uid = Number(env.WORKFLOWD_AGENT_UID),
    gid = Number(env.WORKFLOWD_AGENT_GID)
  if (
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    uid !== identity.uid ||
    !Number.isSafeInteger(gid) ||
    gid <= 0 ||
    gid !== identity.gid ||
    identity.groups.some((group) => group !== gid)
  )
    throw new Error("Agent OpenCode UID or groups do not match the installed policy")
  if (!env.WORKFLOWD_AGENT_HOME) throw new Error("Agent OpenCode requires its own home")
  return {
    ...workerEnvironment(env),
    ...agentGitEnvironment(loadAgentGitConfig(env, true)),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
  }
}

if (import.meta.main) {
  const env = agentOpenCodeEnvironment(process.env)
  // --service reads this file itself; never export authentication into /proc environ.
  try {
    Schema.decodeUnknownSync(Schema.Struct({ password: Schema.String.check(Schema.isNonEmpty()) }))(
      JSON.parse(await readFile(join(env.XDG_CONFIG_HOME!, "opencode/service.json"), "utf8")),
    )
  } catch {
    throw new Error("Agent OpenCode requires a service.json with server authentication")
  }
  const child = Bun.spawn(
    ["/usr/local/bin/opencode2", "serve", "--service", "--hostname", "127.0.0.1", "--port", "4097"],
    {
      env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal))
  process.exitCode = await child.exited
}
