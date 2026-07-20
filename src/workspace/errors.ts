import { Data } from "effect"

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly operation: string
  readonly cause: Error
}> {}
