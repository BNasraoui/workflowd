export async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error("Reload fixture did not reach the expected state")
}
