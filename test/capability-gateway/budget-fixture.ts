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

/** The body of a model call that open calls of its run hold back. */
export const heldBody = {
  type: "error",
  error: { type: "rate_limit_error", message: "workflowd run budget held by open calls" },
}

/**
 * Polls `check` every 50 ms until it holds: a settlement is stored after the stream that it
 * settles has ended, and the timeout of the test bounds the wait.
 */
export async function eventually(check: () => Promise<boolean>) {
  while (!(await check())) await Bun.sleep(50)
}

/** Reads a stream until it ends or fails; the timeout of the test bounds the wait. */
export async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>) {
  for (;;) {
    const item = await reader.read().catch(() => undefined)
    if (item === undefined || item.done) return
  }
}

/**
 * Has the fixture upstream hold the next `count` requests that reach it before it answers them:
 * `holding` resolves once all of them wait, and `letGo(n)` lets the first `n` that still wait
 * be answered. Each later request is answered at once. Its disposal lets each one go, so a test
 * that fails leaves no request held when its gateway stops.
 */
export function heldUpstream(f: Fixture, count: number) {
  const waiting: Array<() => void> = []
  let arrived = 0
  let all: () => void = () => undefined
  const holding = new Promise<void>((resolve) => {
    all = resolve
  })
  f.onUpstream(async () => {
    if (arrived === count) return
    arrived++
    const answer = new Promise<void>((resolve) => waiting.push(resolve))
    if (arrived === count) all()
    await answer
  })
  const letGo = (n: number) => {
    for (const resolve of waiting.splice(0, n)) resolve()
  }
  return {
    holding,
    letGo,
    [Symbol.dispose]: () => {
      f.onUpstream(undefined)
      letGo(waiting.length)
    },
  }
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
