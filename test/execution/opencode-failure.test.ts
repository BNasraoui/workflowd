import { expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client/effect"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { makeOpenCodeDiscovery } from "../../src/execution/opencode"
import { makeExecutionCapabilities } from "../../src/execution-capabilities"

test("OpenCode incompatible discovery is unsupported, while server failure is isolated and redacted", async () => {
  let mode = "not-found"
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (mode === "malformed") return Response.json({ secret: "private-credential" })
      return new Response("private-credential", { status: mode === "not-found" ? 404 : 500 })
    },
  })
  try {
    const client = OpenCode.make({ baseUrl: server.url.toString() }).pipe(
      Effect.provide(FetchHttpClient.layer),
    )
    for (const [next, expected] of [
      ["not-found", "unsupported"],
      ["malformed", "unsupported"],
      ["failed", "unavailable"],
    ] as const) {
      mode = next
      const { list } = makeExecutionCapabilities({
        host: "box",
        refreshMs: 100,
        timeoutMs: 1000,
        sources: [makeOpenCodeDiscovery("oc", client)],
      })
      const result = await list()
      expect(result.sources[0]?.status).toBe(expected)
      expect(result.capabilities).toEqual([])
      expect(JSON.stringify(result)).not.toContain("private-credential")
    }
  } finally {
    await server.stop(true)
  }
})

test("OpenCode SDK typed and transport authentication rejections are unauthenticated and redacted", async () => {
  let mode = "typed"
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return mode === "typed"
        ? Response.json(
            { _tag: "UnauthorizedError", message: "private-credential" },
            { status: 401 },
          )
        : new Response("private-credential", { status: Number(mode) })
    },
  })
  try {
    const client = OpenCode.make({ baseUrl: server.url.toString() }).pipe(
      Effect.provide(FetchHttpClient.layer),
    )
    for (const next of ["typed", "401", "403"]) {
      mode = next
      const { list } = makeExecutionCapabilities({
        host: "box",
        refreshMs: 100,
        timeoutMs: 1000,
        sources: [makeOpenCodeDiscovery("oc", client)],
      })
      const result = await list()
      expect(result.sources[0]?.status).toBe("unauthenticated")
      expect(result.capabilities).toEqual([])
      expect(JSON.stringify(result)).not.toContain("private-credential")
    }
  } finally {
    await server.stop(true)
  }
})
