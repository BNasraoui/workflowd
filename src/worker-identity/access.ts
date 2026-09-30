export function authorizeWorker(
  run: { readonly state: string; readonly createdAt: Date } | null,
  now: number,
): boolean {
  return (
    run !== null &&
    ["spawning", "spawned", "verified"].includes(run.state) &&
    now >= run.createdAt.getTime() &&
    now < run.createdAt.getTime() + 86400000
  )
}
