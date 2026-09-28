import { createHmac, createHash, timingSafeEqual } from "node:crypto"
export const workerCapability = (secret: string, runId: string) =>
  createHmac("sha256", secret).update(`worker-github:${runId}`).digest("hex")
export function authorizeWorker(
  secret: string,
  runId: string,
  supplied: string,
  run: { readonly state: string; readonly createdAt: Date } | null,
  now: number,
): boolean {
  const valid = timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(workerCapability(secret, runId)).digest(),
  )
  return (
    valid &&
    run !== null &&
    ["spawning", "spawned", "verified"].includes(run.state) &&
    now >= run.createdAt.getTime() &&
    now < run.createdAt.getTime() + 86400000
  )
}
