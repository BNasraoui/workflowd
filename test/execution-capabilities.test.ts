import { expect, test } from "bun:test"
import { makeExecutionCapabilities } from "../src/execution-capabilities"

test("discovery keeps native identities and advertised thinking dialects separate", async () => {
  const { list } = makeExecutionCapabilities({
    host: "box-a",
    refreshMs: 10,
    timeoutMs: 100,
    sources: [
      {
        executor: "opencode",
        discover: async () => [
          {
            provider: "openai",
            model: "same",
            variants: [{ id: "deep" }],
            reasoning: { supported: true },
          },
        ],
      },
      {
        executor: "codex",
        discover: async () => [
          { provider: "openai", model: "same", efforts: [{ id: "high" }], defaultEffort: "high" },
        ],
      },
    ],
  })
  const result = await list()
  expect(result.sources.map((s) => s.status)).toEqual(["available", "available"])
  expect(
    result.capabilities.map((c) => [
      c.identity.host,
      c.identity.executor,
      c.identity.provider,
      c.identity.model,
    ]),
  ).toEqual([
    ["box-a", "opencode", "openai", "same"],
    ["box-a", "codex", "openai", "same"],
  ])
  expect(result.capabilities[0]?.thinking?.variants).toEqual([{ id: "deep" }])
  expect(result.capabilities[1]?.thinking?.defaultEffort).toBe("high")
})

test("bounded refresh reveals new models and never presents stale data as available", async () => {
  let now = 0
  let names = ["one"]
  let fail = false
  const { list } = makeExecutionCapabilities({
    host: "box-a",
    refreshMs: 10,
    timeoutMs: 10,
    now: () => now,
    sources: [
      {
        executor: "opencode",
        discover: async () => {
          if (fail) throw new Error("secret credential")
          return names.map((model) => ({ provider: "p", model }))
        },
      },
    ],
  })
  expect((await list()).capabilities.map((c) => c.identity.model)).toEqual(["one"])
  names = ["one", "two"]
  now = 11
  expect((await list()).capabilities.map((c) => c.identity.model)).toEqual(["one", "two"])
  fail = true
  now = 22
  const failed = await list()
  expect(failed.sources[0]?.status).toBe("unavailable")
  expect(failed.sources[0]?.stale).toBe(true)
  expect(failed.sources[0]?.observedAt).toBe(new Date(11).toISOString())
  expect(failed.capabilities).toEqual([])
  expect(JSON.stringify(failed)).not.toContain("secret credential")
})

test("concurrent readers share refresh and timed out discoveries are cancelled", async () => {
  let calls = 0
  let cancelled = false
  const { list } = makeExecutionCapabilities({
    host: "h",
    refreshMs: 10,
    timeoutMs: 5,
    sources: [
      {
        executor: "codex",
        discover: (signal) => {
          calls++
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true
            },
            { once: true },
          )
          return new Promise(() => undefined)
        },
      },
    ],
  })
  const results = await Promise.all([list(), list()])
  expect(calls).toBe(1)
  expect(cancelled).toBe(true)
  expect(results[0]).toEqual(results[1])
})

test("one failed or unsupported source does not hide healthy sources", async () => {
  const { list } = makeExecutionCapabilities({
    host: "h",
    refreshMs: 10,
    timeoutMs: 5,
    sources: [
      { executor: "codex", discover: async () => new Promise(() => undefined) },
      { executor: "claude", discover: async () => ({ status: "unsupported" as const }) },
      { executor: "opencode", discover: async () => [{ provider: "p", model: "m" }] },
    ],
  })
  const result = await list()
  expect(result.sources.map((s) => s.status)).toEqual(["unavailable", "unsupported", "available"])
  expect(result.capabilities).toHaveLength(1)
})

test("a synchronous source failure can recover on the next bounded refresh", async () => {
  let now = 0
  let failed = true
  const { list } = makeExecutionCapabilities({
    host: "h",
    refreshMs: 10,
    timeoutMs: 10,
    now: () => now,
    sources: [
      {
        executor: "test",
        discover: () => {
          if (failed) throw new Error("temporarily offline")
          return Promise.resolve([{ provider: "p", model: "recovered" }])
        },
      },
    ],
  })
  expect((await list()).sources[0]?.status).toBe("unavailable")
  now = 11
  failed = false
  expect((await list()).capabilities[0]?.identity.model).toBe("recovered")
})

test("cached capabilities that expire while another source refreshes are marked stale and omitted", async () => {
  let now = 0
  const delayed = Promise.withResolvers<ReadonlyArray<{ provider: string; model: string }>>()
  const { list } = makeExecutionCapabilities({
    host: "h",
    refreshMs: 10,
    timeoutMs: 10,
    now: () => now,
    sources: [
      {
        executor: "one",
        discover: async () => [{ provider: "p", model: "one", availability: "available" }],
      },
      { executor: "two", discover: () => delayed.promise },
    ],
  })
  const pending = list()
  await new Promise<void>((resolve) => setImmediate(resolve))
  now = 11
  delayed.resolve([{ provider: "p", model: "two" }])
  const result = await pending
  expect(result.sources[0]?.stale).toBe(true)
  expect(result.capabilities.map((model) => model.identity.model)).toEqual(["two"])
})

test("loss of authentication preserves observation time while withdrawing capabilities", async () => {
  let now = 0
  let authenticated = true
  const { list } = makeExecutionCapabilities({
    host: "h",
    refreshMs: 10,
    timeoutMs: 10,
    now: () => now,
    sources: [
      {
        executor: "test",
        discover: async () =>
          authenticated ? [{ provider: "p", model: "m" }] : { status: "unauthenticated" },
      },
    ],
  })
  await list()
  now = 11
  authenticated = false
  const result = await list()
  expect(result.capabilities).toEqual([])
  expect(result.sources[0]).toMatchObject({
    status: "unauthenticated",
    stale: true,
    observedAt: new Date(0).toISOString(),
  })
})

test("disposal joins native teardown after a bounded read has already timed out", async () => {
  const teardownStarted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  let now = 0
  let cleanupFinished = false
  const discovery = makeExecutionCapabilities({
    host: "h",
    refreshMs: 10,
    timeoutMs: 5,
    now: () => now,
    sources: [
      {
        executor: "fixture",
        discover: async (signal) => {
          calls++
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          )
          teardownStarted.resolve()
          await release.promise
          cleanupFinished = true
          throw new Error("cancelled")
        },
      },
    ],
  })
  try {
    expect((await discovery.list()).sources[0]?.status).toBe("unavailable")
    await teardownStarted.promise
    now = 11
    expect((await discovery.list()).sources[0]?.status).toBe("unavailable")
    expect(calls).toBe(1)
    let disposed = false
    const closing = discovery.close()
    void closing.then(() => {
      disposed = true
    })
    expect(discovery.close()).toBe(closing)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(disposed).toBe(false)
    expect(cleanupFinished).toBe(false)
    await expect(discovery.list()).rejects.toThrow("closed")
    release.resolve()
    await closing
    expect(cleanupFinished).toBe(true)
    expect(disposed).toBe(true)
  } finally {
    release.resolve()
    await discovery.close()
  }
})
