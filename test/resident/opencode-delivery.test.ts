import { expect, test } from "bun:test"
import { Effect } from "effect"
import { OpenCodeAdapterError, type OpenCodeAdapter } from "../../src/opencode/adapter"
import { deliverOpenCode } from "../../src/resident/opencode-delivery"

const message = {
  id: "subscription-1",
  thread_id: "ses_1",
  prompt: "completion",
  state: "prepared",
}
const run = { directory: "/isolated", agent: "build", providerId: "test", modelId: "model" }
for (const outcome of ["accepted", "gone", "refused", "failed", "sending"] as const) {
  test(`OpenCode mailbox ${outcome} is delivered or explicitly uncertain without replay`, async () => {
    const prompts: unknown[] = []
    const provider: Pick<OpenCodeAdapter, "sessionExists" | "promptSession"> = {
      sessionExists: () =>
        outcome === "failed"
          ? Effect.fail(
              new OpenCodeAdapterError({ operation: "probe", cause: new Error("offline") }),
            )
          : Effect.succeed(outcome !== "gone"),
      promptSession: (input) => {
        prompts.push(input)
        return outcome === "refused"
          ? Effect.fail(
              new OpenCodeAdapterError({ operation: "prompt", cause: new Error("refused") }),
            )
          : Effect.void
      },
    }
    expect(
      await Effect.runPromise(
        deliverOpenCode(
          provider,
          { ...message, state: outcome === "sending" ? "sending" : "prepared" },
          run,
        ),
      ),
    ).toBe(outcome === "accepted" ? "delivered" : "uncertain")
    expect(prompts).toHaveLength(outcome === "accepted" || outcome === "refused" ? 1 : 0)
    if (outcome === "accepted")
      expect(prompts[0]).toEqual({
        sessionID: "ses_1",
        directory: "/isolated",
        agent: "build",
        model: { providerID: "test", modelID: "model" },
        text: "completion",
      })
  })
}
