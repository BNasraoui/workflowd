import { expect, test } from "bun:test"
import { defaultRunBudget } from "../../src/sandbox/config"
import { client, gateways, inProcessGateway, processGateway, usageStream } from "./gateway-process"
import {
  answered,
  eventually,
  heldBody,
  heldUpstream,
  openReservations,
  readToEnd,
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

  test(`[${mode}] with 100000 charged and three calls of 128000 open, a fourth gets 429 with the rate limit body and counts nothing; once one settles, the call is served`, async () => {
    await withBudget(
      start,
      defaultRunBudget,
      async (f, gateway) => {
        const token = await runToken(gateway)
        const runner = client(gateway)
        f.setAnswerText(usageStream({ output_tokens: 1 }, { output_tokens: 100000 }))
        expect((await answered(runner.call(token, 128000))).status).toBe(200)
        // Three calls reserve and reach the upstream, which holds each until it is let go.
        using upstream = heldUpstream(f, 3)
        const open = Array.from({ length: 3 }, () => answered(runner.call(token, 128000)))
        await upstream.holding
        // 100000 charged and 384000 reserved: 128000 more passes 600000, 128000 alone does not.
        const held = await runner.call(token, 128000)
        expect(held.status).toBe(429)
        expect(held.headers.get("retry-after")).toBe("5")
        expect(held.headers.get("content-type")).toBe("application/json")
        expect(await held.json()).toEqual(heldBody)
        expect(await usage(f)).toMatchObject({ calls: 4, outputTokens: 100000, spent: false })
        expect((await openReservations(f))[0]?.n).toBe(3)
        // One open call ends with 2000 output tokens: 102000 charged and 256000 reserved.
        f.setAnswerText(usageStream({ output_tokens: 1 }, { output_tokens: 2000 }))
        upstream.letGo(1)
        await eventually(async () => (await openReservations(f))[0]?.n === 2)
        expect((await answered(runner.call(token, 128000))).status).toBe(200)
        upstream.letGo(2)
        for (const answer of await Promise.all(open)) expect(answer.status).toBe(200)
        await eventually(async () => (await openReservations(f))[0]?.n === 0)
        expect(await usage(f)).toMatchObject({ calls: 5, outputTokens: 108000, spent: false })
      },
      { maxStreamsPerRun: 4 },
    )
  }, 30000)

  test(`[${mode}] of four calls that start at once with a budget that holds three, three are served and one gets 429`, async () => {
    await withBudget(
      start,
      { ...small, outputTokens: 900 },
      async (f, gateway) => {
        const token = await runToken(gateway)
        const runner = client(gateway)
        using upstream = heldUpstream(f, 3)
        // The gateway counts and reserves each call under its run-lifetime permit, which one call
        // holds at a time, so each call that starts at once sees the reservations of the others.
        const answers = Array.from({ length: 4 }, () => runner.call(token, 300))
        await upstream.holding
        upstream.letGo(3)
        const statuses = (await Promise.all(answers.map(answered))).map(({ status }) => status)
        expect(statuses.sort()).toEqual([200, 200, 200, 429])
        expect(f.upstreamRequests().length).toBe(3)
        await eventually(async () => (await openReservations(f))[0]?.n === 0)
        expect(await usage(f)).toMatchObject({ calls: 3, outputTokens: 3, spent: false })
      },
      { maxStreamsPerRun: 4 },
    )
  }, 30000)

  test(`[${mode}] a call that the budget cannot hold even with no call open gets the budget body and spends the run, while one that open calls hold back gets 429`, async () => {
    await withBudget(
      start,
      small,
      async (f, gateway) => {
        const token = await runToken(gateway)
        const runner = client(gateway)
        f.setAnswerText(usageStream({ output_tokens: 1 }, { output_tokens: 350 }))
        for (let served = 0; served < 2; served++)
          expect((await answered(runner.call(token, 400))).status).toBe(200)
        using upstream = heldUpstream(f, 1)
        const open = answered(runner.call(token, 300))
        await upstream.holding
        // 700 charged and 300 reserved: 300 more fits once the open call settles.
        const held = await runner.call(token, 300)
        expect(held.status).toBe(429)
        expect(await held.json()).toEqual(heldBody)
        expect(await usage(f)).toMatchObject({ calls: 3, outputTokens: 700, spent: false })
        // 700 charged and 400 asked passes 1000 with no call open.
        const refused = await runner.call(token, 400)
        expect(refused.status).toBe(403)
        expect(await refused.json()).toEqual(spentBody)
        expect(await usage(f)).toMatchObject({ calls: 3, outputTokens: 700, spent: true })
        upstream.letGo(1)
        expect((await open).status).toBe(200)
        // The spent run refuses a call that would fit.
        await eventually(async () => (await openReservations(f))[0]?.n === 0)
        const after = await runner.call(token, 1)
        expect(after.status).toBe(403)
        expect(await after.json()).toEqual(spentBody)
      },
      { maxStreamsPerRun: 4 },
    )
  }, 30000)
}

test(`[in-process] a stream that the provider keeps open ends at its run token's expiry and settles its reservation, so open calls hold back a call of the run no longer than that`, async () => {
  // A run token lives at most 15 minutes, so a stream that its provider keeps sending ends then;
  // one with no byte for the idle limit ends sooner. A run that opens new calls as old ones end
  // stays held back only while it pays for those calls.
  await withBudget(inProcessGateway, small, async (f, gateway) => {
    await f.tokenSeconds(8)
    const token = await runToken(gateway)
    await f.tokenSeconds(null)
    // A ping every 100 ms for far longer than the token lives, well within the idle limit.
    f.setTrickle(100000, 100)
    const answer = await client(gateway).call(token, 300)
    expect(answer.status).toBe(200)
    await readToEnd(answer.body!.getReader())
    // The gateway ended the answer: the upstream sees its cancel.
    await eventually(async () => f.upstreamCancels() === 1)
    await eventually(async () => (await openReservations(f))[0]?.n === 0)
    expect(await usage(f)).toMatchObject({ calls: 1, outputTokens: 300 })
  })
}, 30000)

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
      (sql) => sql`SELECT calls,output_tokens,max_tokens FROM sandbox_run_budgets`,
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
