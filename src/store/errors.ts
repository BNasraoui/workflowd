import { Data } from "effect"

export class StoreDataError extends Data.TaggedError("StoreDataError")<{
  readonly field: "fix_result_json" | "review_json" | "row"
  readonly message: string
  readonly record:
    "agent_execution" | "command" | "job" | "publication" | "pull_request" | "reconciliation"
  readonly recordId: number
}> {}
