import { Context, Effect } from "effect"
import type { AgentRunSubmission } from "../agent-run-contract"
import type { AgentRunIngressError } from "../kernel/agent-run-ingress"
import type { AgentRunRecord } from "../kernel/agent-run-store"
import type { RemoteCommand, RemoteResult } from "./contract"

export const RemoteAgentDispatch = Context.Service<{
  readonly preflight: (host: string) => Effect.Effect<void, AgentRunIngressError>
  readonly dispatch: (
    run: AgentRunRecord,
    submission: AgentRunSubmission,
    now: Date,
  ) => Effect.Effect<
    {
      readonly nativeSessionId: string
      readonly outputTokens: number
      readonly kind: "opencode" | "codex" | "claude"
    },
    AgentRunIngressError
  >
  readonly cancel: (run: AgentRunRecord, now: Date) => Effect.Effect<void, AgentRunIngressError>
  readonly flush: () => Effect.Effect<void, AgentRunIngressError>
  readonly receive: (result: RemoteResult) => Effect.Effect<boolean, AgentRunIngressError>
}>("workflowd/remote/RemoteAgentDispatch")

export const RemoteAgentRunner = Context.Service<{
  readonly receive: (command: RemoteCommand) => Effect.Effect<void, AgentRunIngressError>
  readonly tick: () => Effect.Effect<void, AgentRunIngressError>
}>("workflowd/remote/RemoteAgentRunner")
