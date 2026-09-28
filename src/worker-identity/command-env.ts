export function workerCommandEnvironment(
  parent: Record<string, string | undefined>,
  token: string,
): Record<string, string | undefined> {
  const env = { ...parent }
  delete env.GH_ENTERPRISE_TOKEN
  delete env.GITHUB_ENTERPRISE_TOKEN
  delete env.GH_DEBUG
  delete env.GIT_TRACE
  delete env.GIT_TRACE_CURL
  delete env.GIT_CURL_VERBOSE
  return {
    ...env,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  }
}
