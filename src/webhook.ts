export interface VerifyWebhookSignatureInput {
  readonly body: string | Uint8Array
  readonly secret: string
  readonly signature: string | null
}

export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
  if (!input.signature || !/^sha256=[0-9a-fA-F]{64}$/.test(input.signature)) {
    return false
  }

  const expected = createHmac("sha256", input.secret).update(input.body).digest()
  const received = Buffer.from(input.signature.slice("sha256=".length), "hex")

  return received.length === expected.length && timingSafeEqual(received, expected)
}
import { createHmac, timingSafeEqual } from "node:crypto"
