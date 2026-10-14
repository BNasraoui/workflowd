export interface AgentGitConfig {
  readonly name: string
  readonly email: string
  readonly blockedEmails: ReadonlyArray<string>
}

export function loadAgentGitConfig(
  env: Record<string, string | undefined>,
  required: boolean,
): AgentGitConfig | undefined {
  const name = env.WORKFLOWD_AGENT_GIT_NAME?.trim()
  const email = env.WORKFLOWD_AGENT_GIT_EMAIL?.trim()
  const blocked = env.WORKFLOWD_AGENT_GIT_BLOCKED_EMAILS?.trim()
  if (!required && !name && !email && !blocked) return undefined
  if (!name || /[\r\n\0<>]/.test(name))
    throw new Error("WORKFLOWD_AGENT_GIT_NAME must be a nonempty git identity name")
  const validEmail = (value: string) => /^[^\s<>@\0]+@[^\s<>@\0]+$/.test(value)
  if (!email || !validEmail(email))
    throw new Error("WORKFLOWD_AGENT_GIT_EMAIL must be a git identity email")
  const blockedEmails = blocked ? blocked.split(",").map((value) => value.trim().toLowerCase()) : []
  if (blockedEmails.some((value) => !validEmail(value)))
    throw new Error("WORKFLOWD_AGENT_GIT_BLOCKED_EMAILS must be comma-separated addresses")
  if (blockedEmails.includes(email.toLowerCase()))
    throw new Error("WORKFLOWD_AGENT_GIT_EMAIL is blocked by the agent git policy")
  return { name, email, blockedEmails: [...new Set(blockedEmails)] }
}

export const agentGitEnvironment = (config: AgentGitConfig | undefined): Record<string, string> =>
  config === undefined
    ? {}
    : {
        GIT_AUTHOR_NAME: config.name,
        GIT_AUTHOR_EMAIL: config.email,
        GIT_COMMITTER_NAME: config.name,
        GIT_COMMITTER_EMAIL: config.email,
      }
