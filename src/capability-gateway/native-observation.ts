import { Schema } from "effect"

const Event = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    message: Schema.optionalKey(Schema.Struct({ model: Schema.String, role: Schema.String })),
    usage: Schema.optionalKey(Schema.Struct({ output_tokens: Schema.Int })),
  }),
)
const ResponsesEvent = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    response: Schema.optionalKey(
      Schema.Struct({
        model: Schema.optionalKey(Schema.String),
        usage: Schema.optionalKey(Schema.Struct({ output_tokens: Schema.Int })),
      }),
    ),
  }),
)
const ChatEvent = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    usage: Schema.optionalKey(Schema.NullOr(Schema.Struct({ completion_tokens: Schema.Int }))),
  }),
)

/** Content-free evidence from an authenticated upstream response. This proves
 * run-bound provider output, not native process identity or semantic completion. */
export function nativeResponseObservation(
  model: string,
  observed: (tokens: number) => Promise<void>,
  protocol?: "codex-chatgpt" | "openai-chat",
) {
  let buffer = "",
    started = false,
    tokens = 0,
    stopped = false
  const decoder = new TextDecoder("utf-8", { fatal: true })
  return async (chunk: Uint8Array) => {
    if (stopped) return
    buffer += decoder.decode(chunk, { stream: true })
    if (Buffer.byteLength(buffer) > 1048576) throw new Error("Provider observation capacity")
    let boundary
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const record = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const raw = record
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n")
      if (!raw) continue
      if (protocol !== undefined) {
        let complete = false
        if (protocol === "codex-chatgpt") {
          const value = Schema.decodeUnknownSync(ResponsesEvent)(raw)
          if (value.type !== "response.completed") continue
          if (value.response?.model !== model || value.response.usage === undefined)
            throw new Error("Provider selection mismatch")
          tokens = value.response.usage.output_tokens
          complete = true
        } else if (raw === "[DONE]") complete = true
        else {
          const value = Schema.decodeUnknownSync(ChatEvent)(raw)
          if (value.model !== model) throw new Error("Provider selection mismatch")
          tokens = value.usage?.completion_tokens ?? tokens
        }
        if (tokens < 0 || tokens > 10000000) throw new Error("Provider usage refused")
        if (complete) {
          stopped = true
          if (tokens > 0) await observed(tokens)
          return
        }
        continue
      }
      const value = Schema.decodeUnknownSync(Event)(raw)
      if (value.type === "message_start") {
        if (started || value.message?.model !== model || value.message?.role !== "assistant")
          throw new Error("Provider selection mismatch")
        started = true
      } else if (value.type === "message_delta") {
        const count = value.usage?.output_tokens
        if (!started || count === undefined || count < tokens || count > 10000000)
          throw new Error("Provider usage refused")
        tokens = count
      } else if (value.type === "message_stop") {
        if (!started || stopped) throw new Error("Provider response refused")
        stopped = true
        if (tokens > 0) await observed(tokens)
      }
    }
  }
}
