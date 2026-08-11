import { Data } from "effect"

export class KernelStoreInputError extends Data.TaggedError("KernelStoreInputError")<{
  readonly message: string
}> {}

export class KernelStoreConflictError extends Data.TaggedError("KernelStoreConflictError")<{
  readonly record: "event" | "instance" | "wait"
  readonly instanceId: string
  readonly key: string
}> {}

export class KernelStoreDataError extends Data.TaggedError("KernelStoreDataError")<{
  readonly record: "delivery" | "event" | "instance" | "wait"
  readonly instanceId: string
  readonly key: string
  readonly message: string
}> {}
