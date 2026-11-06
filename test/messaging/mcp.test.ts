import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { callTool } from "../../src/mcp/tools"
import { McpQueriesLive } from "../../src/mcp/queries"
import { RemoteProbeProducerLive } from "../../src/remote/probe-producer"
import { kernelLayer } from "../kernel/job-store-harness"
import { startDirectoryDaemon } from "./harness"
import { relay } from "./relay"

test("MCP send/status and event subscription tools use authenticated daemon persistence", async () => {
  const agent = relay()
  const daemon = await startDirectoryDaemon("host-a", ":memory:")
  const layer = Layer.merge(McpQueriesLive, RemoteProbeProducerLive).pipe(
    Layer.provide(kernelLayer(":memory:")),
  )
  const context = {
    writesAuthorized: true,
    writesConfigured: true,
    now: () => new Date(),
    executionCapabilitiesDaemon: { baseUrl: daemon.url.toString(), token: "directory-secret" },
  }
  const call = (name: string, args: unknown) =>
    Effect.runPromise(callTool(name, args, context).pipe(Effect.provide(layer)))
  try {
    await daemon.request("/directory/registrations", {
      method: "POST",
      body: JSON.stringify(agent.registration),
    })
    const message = {
      id: crypto.randomUUID(),
      sender: "host:host-a",
      recipient: agent.id,
      correlation: "conversation",
      replyTo: null,
      payload: { type: "note", version: 1, data: "hello" },
    }
    expect(await call("send_message", { message })).toMatchObject({
      structuredContent: { id: message.id, status: "accepted" },
    })
    expect(await call("message_status", { id: message.id })).toMatchObject({
      structuredContent: { message },
    })
    const subscription = {
      id: crypto.randomUUID(),
      recipient: agent.id,
      condition: { type: "ci.external", version: 1, key: "build", correlation: "conversation" },
    }
    expect(await call("subscribe_to_event", subscription)).toMatchObject({
      structuredContent: { id: subscription.id, status: "registered" },
    })
    expect(await call("cancel_event_subscription", { id: subscription.id })).toMatchObject({
      structuredContent: { state: "cancelled" },
    })
    expect(await call("send_message", { message, provider: "invented" })).toMatchObject({
      isError: true,
    })
    expect(
      await Effect.runPromise(
        callTool("send_message", { message }, { ...context, writesAuthorized: false }).pipe(
          Effect.provide(layer),
        ),
      ),
    ).toMatchObject({ isError: true })
  } finally {
    await daemon.stop()
    await agent.server.stop(true)
  }
})
