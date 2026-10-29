import { Effect, Schema } from "effect"
import { verifiesOwnerSignature } from "../directory/proof"
import type { ExternalRegistration } from "../directory/contract"
import { MessageRecord } from "./contract"

const RelayReceipt = Schema.Struct({
  status: Schema.Literals(["delivered", "unsupported", "unavailable", "unknown"]),
  signature: Schema.String.pipe(Schema.check(Schema.isMaxLength(256))),
})
/** Query and delivery are different operations. Unknown query results never
 * authorize replay of an operation that may already have entered a native queue. */
export const deliverRelay = Effect.fn("Messaging.deliverRelay")(
  function* (record: MessageRecord, owner: ExternalRegistration, query: boolean) {
    const endpoint = record.target.endpoint
    if (endpoint === null) return "uncertain" as const
    const delivery = {
      protocol: query ? "workflowd-message-query-v1" : "workflowd-message-deliver-v1",
      nonce: crypto.randomUUID(),
      message: record.message,
      bindingVersion: record.target.bindingVersion,
      nativeSessionId: endpoint.nativeSessionId,
    }
    const reply = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(owner.endpoint.address, {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(delivery),
          signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
        })
        if (!response.ok || response.body === null) throw new Error("Relay refused")
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            const bytes: unknown = chunk.value
            if (!(bytes instanceof Uint8Array)) throw new Error("Invalid relay receipt")
            size += bytes.byteLength
            if (size > 4096) throw new Error("Relay receipt too large")
            chunks.push(bytes)
          }
          return JSON.parse(Buffer.concat(chunks).toString()) as unknown
        } finally {
          await reader.cancel()
          reader.releaseLock()
        }
      },
      catch: () => new Error("Relay receipt unavailable"),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RelayReceipt)))
    const valid = yield* Effect.try(() =>
      verifiesOwnerSignature(owner.publicKey, { delivery, status: reply.status }, reply.signature),
    )
    return valid && reply.status !== "unknown" && (!query || reply.status === "delivered")
      ? reply.status
      : ("uncertain" as const)
  },
  Effect.catch(() => Effect.succeed("uncertain" as const)),
)
