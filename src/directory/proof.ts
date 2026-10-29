import { createHash, createPublicKey, verify } from "node:crypto"
import { Effect, Schema } from "effect"
import { canonicalJson } from "../kernel/session-store-support"
import { DirectoryError, type ExternalRegistration } from "./contract"
import type { JsonValue } from "../json"

export const externalRecipientId = (publicKey: string) =>
  `external:${createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex")}`

export const registrationDocument = ({
  signature: _signature,
  ...document
}: ExternalRegistration) => document

const verifies = (publicKey: string, document: JsonValue, signature: string) => {
  const bytes = Buffer.from(publicKey, "base64")
  const key = createPublicKey({ key: bytes, type: "spki", format: "der" })
  return (
    key.asymmetricKeyType === "ed25519" &&
    key.export({ type: "spki", format: "der" }).equals(bytes) &&
    Buffer.from(signature, "base64").length === 64 &&
    verify(null, Buffer.from(canonicalJson(document)), key, Buffer.from(signature, "base64"))
  )
}

export const verifyRegistration = Effect.fn("Directory.verifyRegistration")(function* (
  input: ExternalRegistration,
  hostId: string,
) {
  const valid = yield* Effect.try({
    try: () =>
      input.hostId === hostId &&
      verifies(input.publicKey, registrationDocument(input), input.signature),
    catch: () => new DirectoryError({ reason: "ownership_conflict" }),
  })
  if (!valid) return yield* Effect.fail(new DirectoryError({ reason: "ownership_conflict" }))
})

/** A fresh signed challenge proves that the owner controls this relay endpoint now.
 * Native session metadata is the relay owner's attestation, never process custody. */
export const verifyExternalEndpoint = Effect.fn("Directory.verifyExternalEndpoint")(function* (
  input: ExternalRegistration,
) {
  const challenge = {
    protocol: "workflowd-directory-endpoint-v1",
    nonce: crypto.randomUUID(),
    registration: registrationDocument(input),
  }
  const reply = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(input.endpoint.address, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: canonicalJson(challenge),
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      })
      if (!response.ok || response.body === null) throw new Error("Endpoint refused")
      const reader = response.body.getReader()
      let text = ""
      let size = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          const value: unknown = chunk.value
          if (!(value instanceof Uint8Array)) throw new Error("Invalid endpoint response")
          size += value.byteLength
          if (size > 4096) throw new Error("Endpoint response too large")
          text += new TextDecoder().decode(value)
        }
        return JSON.parse(text) as unknown
      } finally {
        await reader.cancel()
        reader.releaseLock()
      }
    },
    catch: () => new DirectoryError({ reason: "endpoint_unverified" }),
  })
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct({ signature: Schema.String }))(
    reply,
    { onExcessProperty: "error" },
  ).pipe(Effect.mapError(() => new DirectoryError({ reason: "endpoint_unverified" })))
  const valid = yield* Effect.try({
    try: () => verifies(input.publicKey, challenge, decoded.signature),
    catch: () => new DirectoryError({ reason: "endpoint_unverified" }),
  })
  if (!valid) return yield* Effect.fail(new DirectoryError({ reason: "endpoint_unverified" }))
})
