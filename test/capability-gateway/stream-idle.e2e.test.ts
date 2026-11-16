import { expect, test } from "bun:test"
import { client, gateways, proof, withGateway, type Origin } from "./gateway-process"

/** Opens the seeded run's session and gives its run token. */
async function runToken(at: Origin) {
  const runner = client(at)
  const { audience } = await runner.audience()
  return (await runner.grant(await runner.session(proof(audience, "jti-idle")))).token
}

/**
 * Reads a model call's answer to its end: "complete" when it is done, "interrupted" when the
 * read fails, with the number of ping events read and the milliseconds since the call.
 */
async function readAnswer(at: Origin, token: string) {
  const started = Date.now()
  const answer = await client(at).call(token)
  expect(answer.status).toBe(200)
  if (!answer.body) throw new Error("missing streaming body")
  const reader = answer.body.getReader()
  let received = 0
  for (;;) {
    const item = await reader.read().catch(() => undefined)
    if (!item) return { ending: "interrupted", received, elapsed: Date.now() - started }
    if (item.done) return { ending: "complete", received, elapsed: Date.now() - started }
    received += Buffer.from(item.value).toString("utf8").split("event: ping").length - 1
  }
}

/** The status of the next model call: its stream slot was released when this is 200. */
async function nextCall(at: Origin, token: string) {
  const answer = await client(at).call(token)
  await answer.body?.cancel()
  return answer.status
}

for (const [mode, start] of gateways) {
  test(`[${mode}] a stream that keeps sending bytes outlives many idle limits of the config`, async () => {
    await withGateway(
      start,
      async (f, gateway) => {
        const token = await runToken(gateway)
        // 30 chunks 100 ms apart: 3 s of stream, three times the idle limit of 1000 ms.
        f.setTrickle(30, 100)
        const result = await readAnswer(gateway, token)
        expect(result.ending).toBe("complete")
        expect(result.received).toBe(30)
        expect(result.elapsed).toBeGreaterThan(2500)
        f.setStall(false)
        expect(await nextCall(gateway, token)).toBe(200)
      },
      { streamIdleMs: 1000, maxStreamsPerRun: 1 },
    )
  }, 30000)

  test(`[${mode}] a stream silent for the idle limit of the config is aborted upstream and releases its slot`, async () => {
    await withGateway(
      start,
      async (f, gateway) => {
        const token = await runToken(gateway)
        f.setStall(true)
        // The upstream never ends this answer, so its end is the gateway's abort. Bun's fetch
        // reads a cut chunked answer as done, so the end is read as either.
        const result = await readAnswer(gateway, token)
        expect(result.elapsed).toBeGreaterThanOrEqual(300)
        expect(result.elapsed).toBeLessThan(5000)
        // The cancel crosses the upstream connection after the client's read has ended.
        for (let poll = 0; poll < 100 && f.upstreamCancels() === 0; poll++) await Bun.sleep(50)
        expect(f.upstreamCancels()).toBe(1)
        f.setStall(false)
        expect(await nextCall(gateway, token)).toBe(200)
      },
      { streamIdleMs: 300, maxStreamsPerRun: 1 },
    )
  }, 30000)
}
