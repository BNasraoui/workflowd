import { Effect } from "effect"
import type { AgentHarnessPort, AgentHarnessRef } from "./agent-harness"

export const reviewServerId = "opencode-reviewer"
export const reviewEndpointAlias = "private-opencode-reviewer"

/** Route the complete PR session lifecycle, while stage work stays on the agent server. */
export function routeReviewHarness(
  agents: AgentHarnessPort,
  reviewer: AgentHarnessPort,
): AgentHarnessPort {
  const forRef = (ref: AgentHarnessRef) =>
    ref.name === "opencode.pr-review" || ref.name === "opencode.pr-fix" ? reviewer : agents
  return {
    describe: (ref) => forRef(ref).describe(ref),
    validateAvailability: (input) =>
      Effect.forEach(
        input.selections,
        (selection) =>
          forRef(selection.ref).validateAvailability({ ...input, selections: [selection] }),
        { discard: true },
      ),
    prepare: (definition, input, context, settings) =>
      forRef(definition.ref).prepare(definition, input, context, settings),
    createSession: (prepared) => forRef(prepared.launchIntent.harness).createSession(prepared),
    resumeSession: (prepared, reference) =>
      (reference.serverId === reviewServerId ? reviewer : agents).resumeSession(
        prepared,
        reference,
      ),
    abortSession: (reference) =>
      (reference.serverId === reviewServerId ? reviewer : agents).abortSession(reference),
  }
}
