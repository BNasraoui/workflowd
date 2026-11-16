import { expect, test } from "bun:test"
import type { RunBudget } from "../../src/capability-control/protocol"
import { maxReportedTokens } from "../../src/capability-gateway/claude"
import { defaultRunBudget } from "../../src/sandbox/config"
import {
  client,
  fixture,
  gateways,
  processGateway,
  proof,
  streamEnd,
  usageStream,
  type Fixture,
  type Gateway,
  type Origin,
} from "./gateway-process"

/** The body of a model call that the run's budget refuses. */
const spentBody = {
  type: "error",
  error: { type: "permission_error", message: "workflowd run budget spent" },
}

/** Opens the seeded run's session and gives its run token. */
async function runToken(at: Origin, jti = "jti-budget") {
  const runner = client(at)
  const { audience } = await runner.audience()
  const opened = await runner.session(proof(audience, jti))
  expect(opened.status).toBe(200)
  return (await runner.grant(opened)).token
}

/** What the daemon reads of the seeded run on the control socket. */
const usage = (f: Fixture) => f.daemon((capability) => capability.usage("run"))

/** The open reservations in the gateway's store. */
const openReservations = (f: Fixture) =>
  f.gatewaySql(
    (sql) => sql<{ readonly n: number }>`SELECT count(*) AS n FROM capability_reservations`,
  )

/** Polls `check` until it holds, for at most five seconds. */
async function eventually(check: () => Promise<boolean>) {
  for (let poll = 0; poll < 100; poll++) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error("the condition did not hold within five seconds")
}

/** Reads an answer to its end, and gives its status and its text. */
async function answered(response: Promise<Response>) {
  const answer = await response
  return { status: answer.status, text: await answer.text() }
}

/** A gateway from `start` on a fixture whose daemon side gives a new run `budget`. */
async function withBudget(
  start: (f: Fixture) => Promise<Gateway>,
  budget: RunBudget,
  body: (f: Fixture, gateway: Gateway) => Promise<void>,
  keys: { readonly maxStreamsPerRun?: number; readonly streamIdleMs?: number } = {},
) {
  const f = await fixture(keys, undefined, budget)
  let gateway: Gateway | undefined
  try {
    gateway = await start(f)
    await body(f, gateway)
  } finally {
    await gateway?.stop()
    await f.close()
  }
}

const small = { calls: 100, outputTokens: 1000, maxTokens: 400 }

for (const [mode, start] of gateways) {
  test(`[${mode}] a model call whose max_tokens is above the cap, absent or not a positive integer gets the empty 403, and the upstream sees nothing`, async () => {
    await withBudget(start, defaultRunBudget, async (f, gateway) => {
      const token = await runToken(gateway)
      const runner = client(gateway)
      const body = (maxTokens: string | null) =>
        `{"model":"fixture-model","stream":true,"messages":[]${maxTokens === null ? "" : `,"max_tokens":${maxTokens}`}}`
      for (const refused of ["64001", null, "0", "-1", "1.5", '"64000"', "null", "[1]", "1e100"]) {
        const answer = await runner.provider(token, body(refused))
        expect({ refused, status: answer.status, text: await answer.text() }).toEqual({
          refused,
          status: 403,
          text: "",
        })
      }
      expect(f.upstreamRequests()).toEqual([])
      expect(await usage(f)).toMatchObject({ calls: 0, outputTokens: 0, spent: false })
      const served = await answered(runner.provider(token, body("64000")))
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
        f.setStall(true)
        const answers = await Promise.all(Array.from({ length: 4 }, () => runner.call(token, 300)))
        expect(answers.map((answer) => answer.status).sort()).toEqual([200, 200, 200, 403])
        expect(f.upstreamRequests().length).toBe(3)
        // The three open streams hold their reservations until they end; a stall reports no usage.
        for (const answer of answers) await answer.body?.cancel()
        await eventually(async () => (await openReservations(f))[0]?.n === 0)
        expect(await usage(f)).toMatchObject({ calls: 3, outputTokens: 900, spent: true })
      },
      { maxStreamsPerRun: 4 },
    )
  }, 30000)

  test(`[${mode}] a client that goes away in the middle of a stream is charged the max_tokens of its call`, async () => {
    await withBudget(start, small, async (f, gateway) => {
      const token = await runToken(gateway)
      f.setStall(true)
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
        expect(await streamEnd(answer.body!.getReader(), 5000)).toBe("ended")
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
