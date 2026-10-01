import { makeAgentRunCliDispatcher, type AgentRunCliStore } from "./agent-run-cli"
import { codexSessionCustodyId } from "./codex-session"
import type { CliPort } from "./cli-process-contract"
export type AgentRunCodexStore = AgentRunCliStore
/** Compatibility constructor for existing Codex integration tests and consumers. */
export const makeAgentRunCodexDispatcher = (
  input: Omit<Parameters<typeof makeAgentRunCliDispatcher>[0], "cli" | "executor"> & {
    readonly codex: CliPort
  },
) => {
  const { codex, ...dependencies } = input
  return makeAgentRunCliDispatcher({
    ...dependencies,
    cli: codex,
    executor: {
      kind: "codex",
      sessionCustodyId: codexSessionCustodyId,
    },
  })
}
