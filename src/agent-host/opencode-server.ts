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
  if (!env.WORKFLOWD_AGENT_HOME || !env.OPENCODE_SERVER_PASSWORD)
    throw new Error("Agent OpenCode requires its own home and server authentication")
  return {
    ...workerEnvironment(env),
    ...agentGitEnvironment(loadAgentGitConfig(env, true)),
    OPENCODE_SERVER_PASSWORD: env.OPENCODE_SERVER_PASSWORD,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
  }
}

if (import.meta.main) {
  const child = Bun.spawn(
    ["/usr/local/bin/opencode2", "serve", "--hostname", "127.0.0.1", "--port", "4097"],
    {
      env: agentOpenCodeEnvironment(process.env),
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal))
  process.exitCode = await child.exited
}
