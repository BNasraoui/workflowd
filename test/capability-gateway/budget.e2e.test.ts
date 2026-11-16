import { expect, test } from "bun:test"
import { defaultRunBudget } from "../../src/sandbox/config"
import { client, gateways, processGateway, usageStream } from "./gateway-process"
import {
  answered,
  eventually,
  openReservations,
  runToken,
  small,
  spentBody,
  usage,
  withBudget,
} from "./budget-fixture"

for (const [mode, start] of gateways) {
  test(`[${mode}] a model call whose max_tokens is above the default cap of 128000, absent or not a positive integer gets the empty 403, and the upstream sees nothing; 128000 passes`, async () => {
    await withBudget(start, defaultRunBudget, async (f, gateway) => {
      const token = await runToken(gateway)
      const runner = client(gateway)
      const body = (maxTokens: string | null) =>
        `{"model":"fixture-model","stream":true,"messages":[]${maxTokens === null ? "" : `,"max_tokens":${maxTokens}`}}`
      for (const refused of [
        "128001",
        null,
        "0",
        "-1",
        "1.5",
        '"128000"',
        "null",
        "[1]",
        "1e100",
      ]) {
        const answer = await runner.provider(token, body(refused))
        expect({ refused, status: answer.status, text: await answer.text() }).toEqual({
          refused,
          status: 403,
          text: "",
        })
      }
      expect(f.upstreamRequests()).toEqual([])
      expect(await usage(f)).toMatchObject({ calls: 0, outputTokens: 0, spent: false })
      const served = await answered(runner.provider(token, body("128000")))
      expect(served.status).toBe(200)
      expect(f.upstreamRequests().length).toBe(1)
    })
  }, 30000)

  test(`[${mode}] calls are served while their reservation fits, then each model call gets 403 with the budget body`, async () => {
    await withBudget(start, small, async (f, gateway) => {
      await f.tokenSeconds(180)
      const token = await runToken(gateway)
      await f.tokenSeconds(null)
      const runner = client(gateway)
      const stream = usageStream(
        { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 2 },
        { output_tokens: 250, cache_read_input_tokens: 3 },
        "x".repeat(2000),
      )
      // The events reach the gateway in pieces of 7 bytes, so each event spans many reads.
      f.setAnswerText(stream, { bytes: 7, gapMs: 1 })
      // Reserved 300 of 1000 each time: 0, 250 and 500 are charged before the three calls that fit.
      for (let served = 0; served < 3; served++) {
        const answer = await answered(runner.call(token, 300))
        expect(answer).toEqual({ status: 200, text: stream })
      }
      expect(await usage(f)).toEqual({
        calls: 3,
        inputTokens: 30,
        outputTokens: 750,
        cacheCreationInputTokens: 6,
        cacheReadInputTokens: 9,
        spent: false,
      })
      // 750 charged and 300 asked is above 1000.
      const refused = await runner.call(token, 300)
      expect(refused.status).toBe(403)
      expect(refused.headers.get("content-type")).toBe("application/json")
      expect(await refused.json()).toEqual(spentBody)
      // A spent budget refuses each later model call, one that would fit and a count of tokens too.
      expect((await answered(runner.call(token, 100))).status).toBe(403)
      const counted = await runner.request(
        "/capabilities/v1/providers/anthropic/v1/messages/count_tokens",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
          },
          body: JSON.stringify({ model: "fixture-model", messages: [] }),
        },
      )
      expect(await counted.json()).toEqual(spentBody)
      expect(f.upstreamRequests().length).toBe(3)
      expect(await usage(f)).toMatchObject({ calls: 3, outputTokens: 750, spent: true })
      // The run token stays valid: the renew route still answers it.
      expect((await runner.renew(token)).status).toBe(200)
    })
  }, 30000)

  test(`[${mode}] each request sent to the provider counts as a call, and the call after the limit gets the budget body`, async () => {
    await withBudget(start, { ...small, calls: 2 }, async (f, gateway) => {
      const token = await runToken(gateway)
      const runner = client(gateway)
      expect((await answered(runner.call(token, 100))).status).toBe(200)
      // A count of tokens asks no output tokens and needs no max_tokens; it is a call.
      const counted = await runner.request(
        "/capabilities/v1/providers/anthropic/v1/messages/count_tokens?beta=true",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
          },
          body: JSON.stringify({ model: "fixture-model", messages: [] }),
        },
      )
      expect(counted.status).toBe(200)
      await counted.text()
      const refused = await runner.call(token, 100)
      expect(refused.status).toBe(403)
      expect(await refused.json()).toEqual(spentBody)
      expect(f.upstreamRequests().length).toBe(2)
      // The fixture's stream reports 1 output token; the count of tokens reports none.
      expect(await usage(f)).toMatchObject({ calls: 2, outputTokens: 1, spent: true })
    })
  }, 30000)

  test(`[${mode}] four streams that start at once with a budget that fits three: one gets the budget body`, async () => {
    await withBudget(
      start,
      { ...small, outputTokens: 900 },
      async (f, gateway) => {
        const token = await runToken(gateway)
        const runner = client(gateway)
        // The upstream's answer ends after 3 s. A gateway that its HTTP server tells that the client
        // went away releases the stream then; one that it does not tell (Bun 1.3.14) releases it at
        // the end of the answer. Either way the stream's reservation is settled once.
        f.setTrickle(60, 50)
        const answers = await Promise.all(Array.from({ length: 4 }, () => runner.call(token, 300)))
        expect(answers.map((answer) => answer.status).sort()).toEqual([200, 200, 200, 403])
        expect(f.upstreamRequests().length).toBe(3)
        // The three open streams hold their reservations until they end; a ping reports no usage.
        for (const answer of answers) await answer.body?.cancel()
        await eventually(async () => (await openReservations(f))[0]?.n === 0)
        expect(await usage(f)).toMatchObject({ calls: 3, outputTokens: 900, spent: true })
      },
      { maxStreamsPerRun: 4 },
    )
  }, 30000)
}

test("[process] a change of the config's budget changes no run that workflowd has authorized", async () => {
  await withBudget(processGateway, { ...small, calls: 1 }, async (f, gateway) => {
    const token = await runToken(gateway)
    // The config now names a larger budget; workflowd grants the run again, by itself and with
    // every other live run.
    f.setBudget(defaultRunBudget)
    await f.daemon((capability) => capability.authorize("run"))
    await f.reconcile()
    const runner = client(gateway)
    // The run is not revoked, and keeps the one call of its first budget.
    expect((await answered(runner.call(token, 100))).status).toBe(200)
    const refused = await runner.call(token, 100)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual(spentBody)
    const stored = await f.sql(
      (sql) => sql`SELECT calls,output_tokens,max_tokens FROM capability_run_budgets`,
    )
    expect(stored).toEqual([{ calls: 1, output_tokens: 1000, max_tokens: 400 }])
  })
}, 30000)

for (const [mode, start] of gateways) {
  test(`[${mode}] with the default budget a call is accepted while charged + reserved + max_tokens is at most 600000 output tokens, and the call at 600001 gets the budget body`, async () => {
    expect(defaultRunBudget).toEqual({ calls: 2000, outputTokens: 600000, maxTokens: 128000 })
    await withBudget(start, defaultRunBudget, async (f, gateway) => {
      const token = await runToken(gateway)
      const runner = client(gateway)
      // Four calls that each reserve 128000 and report 118000: 472000 charged.
      f.setAnswerText(usageStream({ output_tokens: 1 }, { output_tokens: 118000 }))
      for (let served = 0; served < 4; served++)
        expect((await answered(runner.call(token, 128000))).status).toBe(200)
      expect(await usage(f)).toMatchObject({ calls: 4, outputTokens: 472000, spent: false })
      // 472000 charged and 128000 asked is 600000: the last call that fits. It reports 1.
      f.setAnswerText(usageStream({ output_tokens: 1 }, { output_tokens: 1 }))
      expect((await answered(runner.call(token, 128000))).status).toBe(200)
      expect(await usage(f)).toMatchObject({ calls: 5, outputTokens: 472001, spent: false })
      // 472001 charged and 128000 asked is 600001: the first call that does not fit.
      const refused = await runner.call(token, 128000)
      expect(refused.status).toBe(403)
      expect(refused.headers.get("content-type")).toBe("application/json")
      expect(await refused.json()).toEqual(spentBody)
      expect(f.upstreamRequests().length).toBe(5)
      expect(await usage(f)).toMatchObject({ calls: 5, outputTokens: 472001, spent: true })
    })
  }, 30000)
}
