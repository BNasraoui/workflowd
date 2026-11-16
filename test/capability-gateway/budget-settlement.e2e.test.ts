import { expect, test } from "bun:test"
import {
  client,
  fixture,
  gateways,
  processGateway,
  usageStream,
  type Gateway,
} from "./gateway-process"
import {
  answered,
  eventually,
  openReservations,
  readToEnd,
  runToken,
  small,
  spentBody,
  usage,
  withBudget,
} from "./budget-fixture"

/** The largest token count that the gateway takes from a usage the provider reports. */
const maxReportedTokens = 10_000_000

for (const [mode, start] of gateways) {
  test(`[${mode}] a client that goes away in the middle of a stream is charged the max_tokens of its call`, async () => {
    await withBudget(start, small, async (f, gateway) => {
      const token = await runToken(gateway)
      // The upstream's answer ends after 3 s. A gateway whose HTTP server reports a client that
      // left releases the stream then; a server that does not report a client that left has it
      // released at the end of the answer. Either way the stream's reservation is settled once.
      f.setTrickle(60, 50)
      const answer = await client(gateway).call(token, 300)
      expect(answer.status).toBe(200)
      const reader = answer.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      expect((await openReservations(f))[0]?.n).toBe(1)
      await reader.cancel()
      await eventually(async () => (await openReservations(f))[0]?.n === 0)
      expect(await usage(f)).toMatchObject({ calls: 1, outputTokens: 300, spent: false })
    })
  }, 30000)

  test(`[${mode}] a stream that the idle limit ends is charged the max_tokens of its call`, async () => {
    await withBudget(
      start,
      small,
      async (f, gateway) => {
        const token = await runToken(gateway)
        f.setStall(true)
        const answer = await client(gateway).call(token, 300)
        expect(answer.status).toBe(200)
        await readToEnd(answer.body!.getReader())
        await eventually(async () => (await openReservations(f))[0]?.n === 0)
        expect(await usage(f)).toMatchObject({ calls: 1, outputTokens: 300 })
      },
      { streamIdleMs: 300 },
    )
  }, 30000)

  test(`[${mode}] a stream that ends with no message_delta is charged its max_tokens and records the input of its message_start`, async () => {
    await withBudget(start, small, async (f, gateway) => {
      const token = await runToken(gateway)
      const stream = usageStream({ input_tokens: 11, output_tokens: 1 }, null)
      f.setAnswerText(stream)
      expect(await answered(client(gateway).call(token, 300))).toEqual({
        status: 200,
        text: stream,
      })
      await eventually(async () => (await openReservations(f))[0]?.n === 0)
      expect(await usage(f)).toMatchObject({ calls: 1, inputTokens: 11, outputTokens: 300 })
    })
  }, 30000)

  test(`[${mode}] a usage count that is negative, not an integer or above the bound charges the call its max_tokens and records no input`, async () => {
    await withBudget(start, { ...small, outputTokens: 100000 }, async (f, gateway) => {
      const token = await runToken(gateway)
      const runner = client(gateway)
      const bad: ReadonlyArray<Record<string, unknown>> = [
        { output_tokens: -1 },
        { output_tokens: 1.5 },
        { output_tokens: "250" },
        { output_tokens: null },
        { output_tokens: maxReportedTokens + 1 },
        { output_tokens: 5, input_tokens: -3 },
        { output_tokens: 5, cache_read_input_tokens: 2.5 },
        { output_tokens: 5, cache_creation_input_tokens: maxReportedTokens + 1 },
      ]
      for (const end of bad) {
        f.setAnswerText(usageStream({ output_tokens: 1 }, { input_tokens: 4, ...end }))
        expect((await answered(runner.call(token, 300))).status).toBe(200)
      }
      await eventually(async () => (await openReservations(f))[0]?.n === 0)
      expect(await usage(f)).toEqual({
        calls: bad.length,
        inputTokens: 0,
        outputTokens: 300 * bad.length,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        spent: false,
      })
      // The bound itself is a count; a null input count is no count.
      f.setAnswerText(
        usageStream(
          { input_tokens: 9, cache_creation_input_tokens: null },
          { output_tokens: 7, cache_read_input_tokens: maxReportedTokens, input_tokens: null },
        ),
      )
      expect((await answered(runner.call(token, 300))).status).toBe(200)
      await eventually(async () => (await openReservations(f))[0]?.n === 0)
      expect(await usage(f)).toMatchObject({
        inputTokens: 9,
        outputTokens: 300 * bad.length + 7,
        cacheReadInputTokens: maxReportedTokens,
      })
    })
  }, 30000)

  test(`[${mode}] a provider that reports more output tokens than the call reserved is charged what it reports, and the next call sees that charge`, async () => {
    await withBudget(start, small, async (f, gateway) => {
      const token = await runToken(gateway)
      const runner = client(gateway)
      f.setAnswerText(usageStream({ output_tokens: 1 }, { output_tokens: 500 }))
      // 300 reserved, 500 reported.
      expect((await answered(runner.call(token, 300))).status).toBe(200)
      await eventually(async () => (await openReservations(f))[0]?.n === 0)
      expect(await usage(f)).toMatchObject({ calls: 1, outputTokens: 500, spent: false })
      // 500 charged and 400 asked fits 1000; it reports 500 too.
      expect((await answered(runner.call(token, 400))).status).toBe(200)
      await eventually(async () => (await openReservations(f))[0]?.n === 0)
      expect(await usage(f)).toMatchObject({ calls: 2, outputTokens: 1000, spent: false })
      const refused = await runner.call(token, 1)
      expect(refused.status).toBe(403)
      expect(await refused.json()).toEqual(spentBody)
      expect(await usage(f)).toMatchObject({ calls: 2, outputTokens: 1000, spent: true })
    })
  }, 30000)

  test(`[${mode}] an answer that is not a stream is read for its usage, and the client gets its bytes`, async () => {
    await withBudget(start, small, async (f, gateway) => {
      const token = await runToken(gateway)
      const runner = client(gateway)
      const json = JSON.stringify({
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 7,
          output_tokens: 42,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 5,
        },
      })
      f.setAnswerJson(json)
      expect(await answered(runner.call(token, 300))).toEqual({ status: 200, text: json })
      // An answer that does not parse reports no usage.
      f.setAnswerJson(`${json.slice(0, -1)},`)
      expect((await answered(runner.call(token, 300))).status).toBe(200)
      // An error answer of the provider made no output: it is a call and charges nothing.
      const error = JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      })
      f.setAnswerJson(error, 529)
      expect(await answered(runner.call(token, 300))).toEqual({ status: 529, text: error })
      await eventually(async () => (await openReservations(f))[0]?.n === 0)
      expect(await usage(f)).toEqual({
        calls: 3,
        inputTokens: 7,
        outputTokens: 42 + 300,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 5,
        spent: false,
      })
    })
  }, 30000)

  test(`[${mode}] a stop of the gateway settles each open reservation in full`, async () => {
    const f = await fixture({}, undefined, small)
    let gateway: Gateway | undefined = await start(f)
    try {
      const token = await runToken(gateway)
      f.setStall(true)
      const answer = await client(gateway).call(token, 300)
      expect(answer.status).toBe(200)
      expect((await openReservations(f))[0]?.n).toBe(1)
      await (gateway.terminate ?? gateway.stop)()
      gateway = undefined
      expect((await openReservations(f))[0]?.n).toBe(0)
      gateway = await start(f)
      expect(await usage(f)).toMatchObject({ calls: 1, outputTokens: 300 })
    } finally {
      await gateway?.stop()
      await f.close()
    }
  }, 30000)

  test(`[${mode}] the counts survive a restart, and a reservation left open in the store is charged in full at the start`, async () => {
    const f = await fixture({}, undefined, small)
    let gateway: Gateway | undefined = await start(f)
    try {
      const token = await runToken(gateway)
      expect((await answered(client(gateway).call(token, 300))).status).toBe(200)
      await gateway.stop()
      gateway = undefined
      // A reservation that no stop settled, as a gateway that was killed leaves it.
      await f.gatewaySql(
        (sql) =>
          sql`INSERT INTO capability_reservations(id,run_id,tokens) VALUES(${"e".repeat(32)},'run',200)`,
      )
      gateway = await start(f)
      expect((await openReservations(f))[0]?.n).toBe(0)
      expect(await usage(f)).toMatchObject({ calls: 1, outputTokens: 201 })
      expect((await answered(client(gateway).call(token, 300))).status).toBe(200)
      expect(await usage(f)).toMatchObject({ calls: 2 })
    } finally {
      await gateway?.stop()
      await f.close()
    }
  }, 30000)
}

test("[process] a gateway killed with an open stream charges its reservation in full when it starts again", async () => {
  const f = await fixture({}, undefined, small)
  let gateway: Gateway | undefined = await processGateway(f)
  try {
    const token = await runToken(gateway)
    f.setStall(true)
    const answer = await client(gateway).call(token, 300)
    expect(answer.status).toBe(200)
    expect((await openReservations(f))[0]?.n).toBe(1)
    // SIGKILL: no finalizer of the gateway runs.
    await gateway.stop()
    gateway = undefined
    expect((await openReservations(f))[0]?.n).toBe(1)
    gateway = await processGateway(f)
    expect((await openReservations(f))[0]?.n).toBe(0)
    expect(await usage(f)).toMatchObject({ calls: 1, outputTokens: 300 })
  } finally {
    await gateway?.stop()
    await f.close()
  }
}, 30000)
