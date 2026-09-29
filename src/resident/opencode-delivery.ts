import { Effect } from "effect"
import type { OpenCodeAdapter } from "../opencode/adapter"
import type { AgentRunRecord } from "../kernel/agent-run-store"

/** A lost asynchronous prompt acknowledgement cannot be safely replayed. */
export const deliverOpenCode = Effect.fn("Resident.deliverOpenCode")(
  function* (
    provider: Pick<OpenCodeAdapter, "sessionExists" | "promptSession">,
    message: { readonly thread_id: string; readonly prompt: string; readonly state: string },
    run: Pick<AgentRunRecord, "directory" | "agent" | "providerId" | "modelId">,
  ) {
    if (message.state === "sending") return "uncertain" as const
    const reference = { sessionID: message.thread_id, directory: run.directory }
    if (!(yield* provider.sessionExists(reference))) return "uncertain" as const
    yield* provider.promptSession({
      ...reference,
      agent: run.agent,
      model: { providerID: run.providerId, modelID: run.modelId },
      text: message.prompt,
      delivery: "queue",
    })
    return "delivered" as const
  },
  Effect.timeout("15 seconds"),
  Effect.catch(() => Effect.succeed("uncertain" as const)),
)
