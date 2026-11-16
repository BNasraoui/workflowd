// The command line of Claude Code in a runner run's box (native-runner.mjs).
import { resultRules } from "./result-rules.mjs"

/**
 * The command of Claude Code in the box: print mode with a stream of JSON lines, the launch's
 * model, no background task, no MCP server, and the rules of the run's result (`resultRules`)
 * added to its system prompt, so the agent knows what the seal takes.
 */
export const claudeCommand = (model) => [
  "/bin/claude", "-p", "--output-format", "stream-json", "--verbose",
  "--model", model,
  // Print-mode turns must finish their commands before the run is sealed.
  "--settings", '{"env":{"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS":"1"}}',
  "--setting-sources", "user", "--dangerously-skip-permissions",
  "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  "--append-system-prompt", resultRules,
]
