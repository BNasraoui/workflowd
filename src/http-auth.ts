import { createHash, timingSafeEqual } from "node:crypto"

export function authorized(header: string | null, token: string) {
  if (header === null || !header.startsWith("Bearer ")) return false
  const supplied = createHash("sha256").update(header.slice("Bearer ".length)).digest()
  const expected = createHash("sha256").update(token).digest()
  return timingSafeEqual(supplied, expected)
}
