import { Schema } from "effect"
const Frame = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
})
/** Multiplexed JSON-RPC. Provider error payloads are never retained in diagnostics. */
export class RpcClient {
  private sequence = 0
  private closed = false
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  constructor(
    private readonly send: (line: string) => void,
    private readonly notify: (frame: { readonly method: string; readonly params: unknown }) => void,
    private readonly timeoutMs = 15000,
  ) {}
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex app-server disconnected"))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} timed out; delivery requires reconciliation`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send(JSON.stringify({ id, method, params }) + "\n")
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error("Codex app-server write failed"))
      }
    })
  }
  receive(line: string) {
    const frame = Schema.decodeUnknownSync(Frame)(JSON.parse(line))
    if (typeof frame.id === "number") {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending.delete(frame.id)
      if (frame.error !== undefined) pending.reject(new Error("Codex app-server rejected request"))
      else pending.resolve(frame.result)
    } else if (frame.method !== undefined)
      this.notify({ method: frame.method, params: frame.params })
  }
  close() {
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error("Codex app-server disconnected"))
    }
    this.pending.clear()
  }
}
