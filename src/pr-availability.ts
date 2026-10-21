import { Effect } from "effect"
import type { AutomationPort } from "./opencode"
import { startReviewAvailability } from "./review-availability"

export const startPullRequestAvailability = (
  automation: AutomationPort | undefined,
  enabled: boolean,
  fixWorkEnabled: boolean,
) =>
  Effect.gen(function* () {
    if (enabled && automation === undefined)
      return yield* Effect.die(new Error("Automation service is required"))
    const review = yield* startReviewAvailability(
      enabled
        ? automation?.validateAvailability({ fixWorkEnabled: false, kind: "review" })
        : undefined,
    )
    const fix = yield* startReviewAvailability(
      enabled && fixWorkEnabled
        ? automation?.validateAvailability({ fixWorkEnabled: true, kind: "fix" })
        : undefined,
      "fix",
    )
    const availableJobKinds = Effect.gen(function* () {
      const kinds: Array<"review" | "fix"> = []
      if ((yield* review.health).status === "available") kinds.push("review")
      // Disabled Fix Work still claims queued fixes so disableFixJob can retire them.
      if (!fixWorkEnabled || (yield* fix.health).status === "available") kinds.push("fix")
      return kinds
    })
    const recheckAvailability = (kind: "review" | "fix") =>
      (kind === "review" ? review : fix).recheck.pipe(
        Effect.map(({ status }) => status === "available"),
      )
    return { review, fix, availableJobKinds, recheckAvailability }
  })
