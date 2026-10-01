import { Effect } from "effect"
import type { OpenCodeAdapter } from "../opencode/adapter"
import type { AgentRunRecord } from "../kernel/agent-run-store"

/** A lost asynchronous prompt acknowledgement cannot be safely replayed. */
export const deliverOpenCode = Effect.fn("Resident.deliverOpenCode")(
  function* (
    provider: Pick<OpenCodeAdapter, "sessionExists" | "promptSession">,
    message: { readonly thread_id: string; readonly prompt: string; readonly state: string },
    run: Pick<
      AgentRunRecord,
      "directory" | "agent" | "providerId" | "modelId" | "resolvedSelection"
    >,
  ) {
    if (message.state === "sending") return "uncertain" as const
    const reference = { sessionID: message.thread_id, directory: run.directory }
    if (!(yield* provider.sessionExists(reference))) return "uncertain" as const
    yield* provider.promptSession({
      ...reference,
      agent: run.agent,
      model: {
        providerID: run.resolvedSelection?.provider ?? run.providerId,
        modelID: run.resolvedSelection?.selectionModel ?? run.modelId,
        ...(run.resolvedSelection?.thinking.variant === undefined
          ? {}
          : { variant: run.resolvedSelection.thinking.variant }),
      },
      text: message.prompt,
      delivery: "queue",
    })
    return "delivered" as const
  },
  Effect.timeout("15 seconds"),
  Effect.matchEffect({
    onSuccess: Effect.succeed,
    onFailure: () => Effect.succeed("uncertain" as const),
  }),
)
