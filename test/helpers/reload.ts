export async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  const poll = async (): Promise<void> => {
    if (await check()) return
    if (Date.now() >= deadline) throw new Error("Reload fixture did not reach the expected state")
    await Bun.sleep(20)
    return poll()
  }
  return poll()
}
