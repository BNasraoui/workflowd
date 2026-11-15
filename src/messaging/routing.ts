import { Effect } from "effect"
import type { DirectorySnapshot } from "../directory/contract"
import { MessagingError } from "./contract"

/** Input routing requires both a current endpoint and a compatible host consumer. */
export const resolveMessageTarget = (
  hostId: string,
  snapshot: DirectorySnapshot,
  recipient: string,
) => {
  const target = snapshot.agents.find((agent) => agent.recipientId === recipient)
  if (
    target?.endpoint?.transport === "cli-session" ||
    (target !== undefined &&
      target.hostId !== hostId &&
      !snapshot.runners.some(
        (runner) =>
          runner.hostId === target.hostId &&
          runner.status === "active" &&
          runner.messageProtocol === 1,
      ))
  )
    return Effect.fail(new MessagingError({ reason: "unsupported" }))
  if (target === undefined || !target.deliverable || target.endpoint === null)
    return Effect.fail(new MessagingError({ reason: "unavailable" }))
  return Effect.succeed(target)
}
