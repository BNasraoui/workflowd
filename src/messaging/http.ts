import { Effect, Schema } from "effect"
import { authorized } from "../http-auth"
import {
  SendMessage,
  SubscribeEvent,
  PublishEvent,
  MessageId,
  type MessagingError,
} from "./contract"
import type { AgentMessaging } from "./service"

export type MessagingHttpBinding = typeof AgentMessaging.Service & { readonly token: string }
const failure = (error: MessagingError) =>
  Response.json(
    { error: "messaging refused", reason: error.reason },
    {
      status:
        error.reason === "unauthorized"
          ? 403
          : error.reason === "invalid"
            ? 400
            : error.reason === "not_found"
              ? 404
              : error.reason === "unavailable"
                ? 503
                : 409,
    },
  )
export function routeMessaging(
  request: Request,
  binding: MessagingHttpBinding | undefined,
  maximum = 16384,
) {
  const url = new URL(request.url)
  if (binding === undefined || !url.pathname.startsWith("/messaging/")) return undefined
  if (!authorized(request.headers.get("authorization"), binding.token))
    return Effect.succeed(Response.json({ error: "unauthorized" }, { status: 401 }))
  if (request.method === "GET" && url.pathname.startsWith("/messaging/messages/"))
    return binding
      .read(url.pathname.slice("/messaging/messages/".length))
      .pipe(Effect.match({ onSuccess: (value) => Response.json(value), onFailure: failure }))
  if (request.method === "GET" && url.pathname.startsWith("/messaging/subscriptions/"))
    return binding
      .subscription(url.pathname.slice("/messaging/subscriptions/".length))
      .pipe(Effect.match({ onSuccess: (value) => Response.json(value), onFailure: failure }))
  if (request.method === "POST") {
    switch (url.pathname) {
      case "/messaging/send":
        return post(request, SendMessage, binding.send, maximum, 202)
      case "/messaging/subscribe":
        return post(request, SubscribeEvent, binding.subscribe, maximum, 202)
      case "/messaging/publish":
        return post(request, PublishEvent, binding.publish, maximum, 202)
      case "/messaging/cancel":
        return post(
          request,
          Schema.Struct({ id: MessageId }),
          (input) => binding.cancel(input.id),
          maximum,
          200,
        )
    }
  }
  return Effect.succeed(new Response(null, { status: 404 }))
}

const post = <A>(
  request: Request,
  schema: Schema.Codec<A>,
  operation: (input: A) => Effect.Effect<object, MessagingError>,
  maximum: number,
  status: number,
) =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise(() => request.text()).pipe(Effect.result)
    if (text._tag === "Failure") return Response.json({ error: "invalid body" }, { status: 400 })
    if (Buffer.byteLength(text.success) > Math.min(maximum, 16384))
      return Response.json({ error: "body too large" }, { status: 413 })
    const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text.success, {
      onExcessProperty: "error",
    }).pipe(Effect.result)
    if (input._tag === "Failure")
      return Response.json({ error: "invalid request" }, { status: 400 })
    return yield* operation(input.success).pipe(
      Effect.match({ onSuccess: (value) => Response.json(value, { status }), onFailure: failure }),
    )
  })
