import { expect, test } from "bun:test"
import { makeExecutionCapabilities } from "../../src/execution-capabilities"
import { makeCodexDiscovery } from "../../src/execution/codex"

const fixture = (mode = "normal") =>
  makeCodexDiscovery("codex-local", {
    command: [process.execPath, `${import.meta.dir}/fixtures/codex-app-server.mjs`, mode],
  })

test("Codex supported model/list protocol paginates and retains effort/default and native identity", async () => {
  const list = makeExecutionCapabilities({
    host: "box",
    refreshMs: 10,
    timeoutMs: 1000,
    sources: [fixture()],
  })
  const result = await list()
  expect(result.capabilities.map((model) => model.identity.model)).toEqual(["first", "second"])
  expect(result.capabilities[0]).toMatchObject({
    identity: { executor: "codex-local", provider: "fixture-provider", model: "first" },
    selectionModel: "picker-first",
    defaultModel: true,
    availability: "unknown",
    thinking: {
      efforts: [
        { id: "deliberate", description: "provider-defined" },
        { id: "max", description: "more" },
      ],
      defaultEffort: "deliberate",
    },
  })
  expect(JSON.stringify(result)).not.toContain("credential-secret")
  expect(JSON.stringify(result)).not.toContain("private@example.com")
})

test("Codex discovery reports auth, unsupported and malformed native sources without inventing catalogs", async () => {
  for (const [mode, status] of [
    ["unauthenticated", "unauthenticated"],
    ["unsupported", "unsupported"],
    ["malformed", "unsupported"],
    ["cycle", "unavailable"],
  ] as const) {
    const list = makeExecutionCapabilities({
      host: "box",
      refreshMs: 10,
      timeoutMs: 1000,
      sources: [fixture(mode)],
    })
    const result = await list()
    expect(result.sources[0]?.status).toBe(status)
    expect(result.capabilities).toEqual([])
    expect(JSON.stringify(result)).not.toContain("credential-secret")
  }
})

test("Codex discovery terminates the owned app-server on refresh timeout", async () => {
  const list = makeExecutionCapabilities({
    host: "box",
    refreshMs: 10,
    timeoutMs: 40,
    sources: [fixture("hang")],
  })
  expect((await list()).sources[0]?.status).toBe("unavailable")
})

test("Codex malformed output without a newline is bounded before the refresh deadline", async () => {
  const signal = AbortSignal.timeout(1500)
  await expect(fixture("oversized").discover(signal)).rejects.toThrow("disconnected")
  expect(signal.aborted).toBe(false)
})
