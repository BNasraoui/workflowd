import { expect, test } from "bun:test"
import { Context, Effect } from "effect"
import { AgentRunIngress } from "../../src/kernel/agent-run-ingress"
import { remoteFixture } from "./agent-fixture"

test("production runner OpenCode wiring uses its local server credential and refuses auth failure before launching", async () => {
  const calls: Array<{ path: string; method: string; authorization: string | null }> = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      calls.push({
        path: new URL(request.url).pathname,
        method: request.method,
        authorization: request.headers.get("authorization"),
      })
      return new Response("fixture unauthorized", { status: 401 })
    },
  })
  const fixture = await remoteFixture({
    runtime: true,
    kind: "opencode",
    openCodeUrl: server.url.toString(),
    openCodePassword: "runner-local-fixture",
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { centralContext } = yield* fixture.contexts
          const result = yield* Context.get(centralContext, AgentRunIngress)
            .register(
              {
                family: "fable",
                harness: "opencode",
                host: "runner-b",
                repository: "fixture",
                prompt: "Remote task",
              },
              new Date(),
            )
            .pipe(Effect.result)
          expect(result._tag).toBe("Failure")
          expect(calls.length).toBeGreaterThan(0)
          for (const call of calls) {
            expect(call.method).toBe("GET")
            expect(call.authorization).toBe(
              `Basic ${Buffer.from("opencode:runner-local-fixture").toString("base64")}`,
            )
          }
          expect(fixture.trees).toHaveLength(0)
        }),
      ),
    )
  } finally {
    await fixture.cleanup()
    await server.stop(true)
  }
}, 15000)
