import { stat } from "node:fs/promises"
import { Effect } from "effect"
import { normalizeError } from "../errors"
import { WorkspaceError } from "./errors"

export function filesystemEffect<A>(
  operation: string,
  task: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, WorkspaceError> {
  return Effect.tryPromise({
    try: task,
    catch: (cause) => new WorkspaceError({ operation, cause: normalizeError(cause) }),
  })
}

export function filesystemTransition<A>(
  operation: string,
  task: () => Promise<A>,
): Effect.Effect<A, WorkspaceError> {
  return Effect.uninterruptible(filesystemEffect(operation, task))
}

export function pathExists(path: string): Effect.Effect<boolean> {
  return Effect.promise(() =>
    stat(path).then(
      () => true,
      () => false,
    ),
  )
}
