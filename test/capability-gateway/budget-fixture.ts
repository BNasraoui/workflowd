/** What the budget tests of the gateway share. */
import { expect } from "bun:test"
import type { RunBudget } from "../../src/capability-control/protocol"
import { client, fixture, proof, type Fixture, type Gateway, type Origin } from "./gateway-process"

/** The body of a model call that the run's budget refuses. */
export const spentBody = {
  type: "error",
  error: { type: "permission_error", message: "workflowd run budget spent" },
}

/** Opens the seeded run's session and gives its run token. */
export async function runToken(at: Origin, jti = "jti-budget") {
  const runner = client(at)
  const { audience } = await runner.audience()
  const opened = await runner.session(proof(audience, jti))
  expect(opened.status).toBe(200)
  return (await runner.grant(opened)).token
}

/** What the daemon reads of the seeded run on the control socket. */
export const usage = (f: Fixture) => f.daemon((capability) => capability.usage("run"))

/** The open reservations in the gateway's store. */
export const openReservations = (f: Fixture) =>
  f.gatewaySql(
    (sql) => sql<{ readonly n: number }>`SELECT count(*) AS n FROM capability_reservations`,
  )

/** Polls `check` until it holds, for at most five seconds. */
export async function eventually(check: () => Promise<boolean>) {
  for (let poll = 0; poll < 100; poll++) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error("the condition did not hold within five seconds")
}

/** Reads an answer to its end, and gives its status and its text. */
export async function answered(response: Promise<Response>) {
  const answer = await response
  return { status: answer.status, text: await answer.text() }
}

/** A gateway from `start` on a fixture whose daemon side gives a new run `budget`. */
export async function withBudget(
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

/** A budget that a few calls of 300 output tokens spend. */
export const small = { calls: 100, outputTokens: 1000, maxTokens: 400 }
