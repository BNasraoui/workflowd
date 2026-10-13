import { Schema } from "effect"
import { isNonToolItem, providerFailure, providerRetryDelay } from "../provider-failure"

const Event = Schema.Struct({
  type: Schema.String,
  thread_id: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
  item: Schema.optional(
    Schema.Struct({ type: Schema.String, message: Schema.optional(Schema.String) }),
  ),
})

/** Observes the full stream even when durable output has reached its byte limit. */
export class CodexRetryTurn {
  threadId: string | undefined
  message: string | undefined
  private unsafe = false
  private pending = ""
  private readonly decoder = new TextDecoder()

  chunk(bytes: Uint8Array) {
    this.pending += this.decoder.decode(bytes, { stream: true })
    for (;;) {
      const newline = this.pending.indexOf("\n")
      if (newline < 0) break
      this.line(this.pending.slice(0, newline))
      this.pending = this.pending.slice(newline + 1)
    }
    if (this.pending.length > 65536) {
      this.unsafe = true
      this.pending = ""
    }
  }

  private line(line: string) {
    try {
      const event = Schema.decodeUnknownSync(Event)(JSON.parse(line))
      if (
        ![
          "thread.started",
          "turn.started",
          "turn.completed",
          "turn.failed",
          "error",
          "item.started",
          "item.updated",
          "item.completed",
        ].includes(event.type)
      )
        this.unsafe = true
      if (event.type.startsWith("item.") && event.item === undefined) this.unsafe = true
      if (event.type === "turn.completed") this.unsafe = true
      if (event.type === "thread.started") this.threadId = event.thread_id
      if (
        event.item !== undefined &&
        !isNonToolItem(event.item.type) &&
        event.item.type !== "error"
      )
        this.unsafe = true
      const message = event.error?.message ?? event.message ?? event.item?.message
      if (message !== undefined) this.message = providerFailure(message)?.message
    } catch {
      this.unsafe = true
    }
  }

  retryDelay(attempt: number) {
    if (this.pending.trim() !== "") this.line(this.pending)
    return !this.unsafe && this.threadId !== undefined && this.message !== undefined
      ? providerRetryDelay(attempt)
      : undefined
  }
}
