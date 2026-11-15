import type { Effect, Stream } from "effect"
import type { CliEvent } from "./cli-process-contract"
import type { SealedResult } from "./sealed-result"

/**
 * Where a repository's runs execute. `host` is the daemon's own host; `runner` is
 * a GitHub Actions job whose sealed result the daemon checks and publishes.
 */
export type Placement = "host" | "runner"

/** What a placement is given to start one run. */
export type ExecutorLaunch = {
  readonly runId: string
  readonly repository: string
  readonly imageDigest: string
  readonly sourceSha: string
  readonly prompt: string
  readonly model: string
  readonly deadline: Date
}

/**
 * One executor with a placement behind it: everything above this interface is the
 * same for each placement. A run's events come back as CLI events, and its work as
 * one sealed result that the daemon checks before anything is published.
 */
export interface Executor<Handle, E> {
  readonly placement: Placement
  readonly start: (launch: ExecutorLaunch) => Effect.Effect<Handle, E>
  readonly events: (handle: Handle) => Stream.Stream<CliEvent, E>
  readonly stop: (handle: Handle) => Effect.Effect<void, E>
  readonly result: (handle: Handle) => Effect.Effect<SealedResult, E>
}
