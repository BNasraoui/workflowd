import { Effect, Schema } from "effect"
import {
  SendMessage,
  MessageId,
  MessageReceipt,
  MessageRecord,
  SubscribeEvent,
  SubscriptionReceipt,
  PublishEvent,
} from "../messaging/contract"
import { toJsonSchemaObject } from "../json"
import type { ToolCallContext, ToolResult } from "./tools"

const Id = Schema.Struct({ id: MessageId })
const Subscription = Schema.Struct({
  ...SubscribeEvent.fields,
  state: SubscriptionReceipt.fields.state,
})
const Published = Schema.Struct({
  id: MessageId,
  status: Schema.Literals(["recorded", "duplicate"]),
})
const definitions = [
  {
    name: "send_message",
    path: "send",
    input: SendMessage,
    output: MessageReceipt,
    description:
      "Durably accept a typed message to an existing registered recipient. Supply a stable UUID id, sender, recipient, correlation, optional reply reference (null for none), and payload. Host operators use sender host:<daemon-host>; external agents prove their sender with their directory owner signature over the message. Acceptance and native delivery are separate; this receipt never means task completion.",
  },
  {
    name: "message_status",
    path: "messages",
    input: Id,
    output: MessageRecord,
    description:
      "Read a durable message and its delivery state. Delivered means native input acceptance, not task completion. Uncertain delivery retains custody and must not be resubmitted under a new ID.",
  },
  {
    name: "subscribe_to_event",
    path: "subscribe",
    input: SubscribeEvent,
    output: SubscriptionReceipt,
    description:
      "Register a durable one-shot subscription with stable UUID id, recipient and exact type/version/key/correlation condition. A matching event becomes one stable message. Does not launch a new agent or wait for task completion.",
  },
  {
    name: "event_subscription_status",
    path: "subscriptions",
    input: Id,
    output: Subscription,
    description: "Read the durable state of a one-shot event subscription.",
  },
  {
    name: "cancel_event_subscription",
    path: "cancel",
    input: Id,
    output: Subscription,
    description:
      "Cancel an unconsumed event subscription. Messages already accepted remain in durable delivery custody.",
  },
  {
    name: "publish_agent_event",
    path: "publish",
    input: PublishEvent,
    output: Published,
    description:
      "Publish a stable typed agent or external event under the authenticated daemon host authority. Exact condition correlations route to registered subscribers. Duplicate event IDs must retain the same event content.",
  },
] as const
export const messagingToolDefinitions = definitions.map((definition) => ({
  name: definition.name,
  description: definition.description,
  inputSchema: { ...toJsonSchemaObject(definition.input), type: "object" as const },
  outputSchema: { ...toJsonSchemaObject(definition.output), type: "object" as const },
  annotations: {
    readOnlyHint: definition.path === "messages" || definition.path === "subscriptions",
    openWorldHint: false,
  },
}))
const failure = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true })
export const callMessagingTool = Effect.fn("Mcp.messaging")(function* (
  name: string,
  args: unknown,
  context: ToolCallContext,
) {
  if (!context.writesConfigured || !context.writesAuthorized)
    return failure("unauthorized: messaging requires the MCP bearer token")
  const daemon = context.executionCapabilitiesDaemon
  if (daemon === undefined) return failure("messaging requires daemon discovery configuration")
  const definition = definitions.find((definition) => definition.name === name)
  if (definition === undefined) return failure("unknown messaging operation")
  const input = yield* Schema.decodeUnknownEffect(
    Schema.Union(definitions.map((value) => value.input)),
  )(args ?? {}, { onExcessProperty: "error" }).pipe(Effect.result)
  if (input._tag === "Failure") return failure("invalid messaging arguments")
  const valid = yield* Schema.decodeUnknownEffect(definition.input)(input.success, {
    onExcessProperty: "error",
  }).pipe(Effect.result)
  if (valid._tag === "Failure") return failure("invalid messaging arguments")
  const read = definition.path === "messages" || definition.path === "subscriptions"
  const response = yield* Effect.tryPromise({
    try: async (signal) => {
      const id = "id" in valid.success ? valid.success.id : ""
      const result = await (daemon.send ?? fetch)(
        new URL(
          `/messaging/${definition.path}${read ? `/${encodeURIComponent(id)}` : ""}`,
          daemon.baseUrl,
        ),
        {
          method: read ? "GET" : "POST",
          headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
          ...(read ? {} : { body: JSON.stringify(valid.success) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
        },
      )
      if (!result.ok) throw new Error("Messaging refused")
      return result.json()
    },
    catch: () => new Error("Messaging unavailable"),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(definition.output)), Effect.result)
  if (response._tag === "Failure")
    return failure("messaging refused or unavailable; query the original ID before retrying")
  return {
    content: [{ type: "text", text: JSON.stringify(response.success, null, 2) }],
    structuredContent: { ...response.success },
  } satisfies ToolResult
})
