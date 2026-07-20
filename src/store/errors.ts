import { Data } from "effect"

export class StoreDataError extends Data.TaggedError("StoreDataError")<{
  readonly field: "fix_result_json" | "review_json" | "row"
  readonly message: string
  readonly record: "command" | "job" | "publication" | "reconciliation"
  readonly recordId: number
}> {}
