import { generateKeyPairSync, sign } from "node:crypto"
import { canonicalJson } from "../../src/kernel/session-store-support"
import { externalRecipientId } from "../../src/directory/proof"
import { JsonValueSchema } from "../../src/json"
import { Schema } from "effect"

export function relay(
  hostId = "host-a",
  loseReceipt = false,
  receipt: {
    readonly status?: "delivered" | "unsupported" | "unavailable" | "unknown"
    readonly invalidSignature?: boolean
  } = {},
) {
  const owner = generateKeyPairSync("ed25519")
  const publicKey = owner.publicKey.export({ type: "spki", format: "der" }).toString("base64")
  const signature = (value: unknown) =>
    sign(
      null,
      Buffer.from(canonicalJson(Schema.decodeUnknownSync(JsonValueSchema)(value))),
      owner.privateKey,
    ).toString("base64")
  const received: unknown[] = []
  const queries: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, JsonValueSchema))(
        await request.json(),
      )
      if (body.protocol === "workflowd-directory-endpoint-v1")
        return Response.json({ signature: signature(body) })
      if (body.protocol === "workflowd-message-deliver-v1") {
        received.push(body)
        if (loseReceipt) return new Response(null, { status: 503 })
      }
      if (body.protocol === "workflowd-message-query-v1") queries.push(body)
      const status = receipt.status ?? "delivered"
      return Response.json({
        status,
        signature: signature(receipt.invalidSignature ? body : { delivery: body, status }),
      })
    },
  })
  const document = {
    protocol: "workflowd-directory-register-v1",
    hostId,
    publicKey,
    revision: 1,
    endpoint: {
      harness: "claude",
      transport: "relay-http",
      address: server.url.toString(),
      nativeSessionId: "external-session",
    },
  }
  return {
    server,
    received,
    queries,
    signature,
    publicKey,
    id: externalRecipientId(publicKey),
    registration: { ...document, signature: signature(document) },
  }
}
