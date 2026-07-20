import { Effect, Schema } from "effect"
import { decodeGitHubEvent } from "./github-event"
import { JsonText } from "./json"
import { WorkflowStore, type WorkflowStorePort } from "./store/contracts"
import { verifyWebhookSignature } from "./webhook"

export type WebhookHandlerOptions = {
  readonly webhookSecret: string
  readonly now: Date
  readonly maxBodyBytes?: number
}

export function routeRequest(
  request: Request,
  options: WebhookHandlerOptions,
): Effect.Effect<Response, never, WorkflowStorePort> {
  const { pathname } = new URL(request.url)
  if (pathname === "/health" && request.method === "GET") {
    return Effect.succeed(Response.json({ status: "ok" }))
  }
  if (pathname === "/hooks/github" && request.method === "POST") {
    return handleGitHubWebhook(request, options)
  }
  return Effect.succeed(Response.json({ error: "not found" }, { status: 404 }))
}

export function handleGitHubWebhook(
  request: Request,
  options: WebhookHandlerOptions,
): Effect.Effect<Response, never, WorkflowStorePort> {
  return Effect.gen(function* () {
    const deliveryId = request.headers.get("x-github-delivery")
    const eventName = request.headers.get("x-github-event")
    const signature = request.headers.get("x-hub-signature-256")
    if (deliveryId === null || eventName === null) {
      return Response.json({ error: "missing GitHub delivery headers" }, { status: 400 })
    }

    const body = new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()))
    if (body.byteLength > (options.maxBodyBytes ?? 1_048_576)) {
      return Response.json({ error: "payload too large" }, { status: 413 })
    }
    if (
      !verifyWebhookSignature({
        body,
        secret: options.webhookSecret,
        signature,
      })
    ) {
      return Response.json({ error: "invalid signature" }, { status: 401 })
    }

    const bodyText = new TextDecoder().decode(body)
    const payload = yield* Schema.decodeUnknown(JsonText)(bodyText).pipe(
      Effect.catchAll(() =>
        Effect.succeed(Response.json({ error: "invalid JSON" }, { status: 400 })),
      ),
    )
    if (payload instanceof Response) return payload

    const decoded = yield* decodeGitHubEvent(eventName, payload).pipe(
      Effect.catchAll((error) =>
        Effect.succeed(Response.json({ error: error.message }, { status: 400 })),
      ),
    )
    if (decoded instanceof Response) return decoded

    const action =
      typeof payload === "object" &&
      payload !== null &&
      "action" in payload &&
      typeof payload.action === "string"
        ? payload.action
        : null
    const delivery = {
      deliveryId,
      event: eventName,
      action,
      payload: bodyText,
      receivedAt: options.now,
    }
    const store = yield* WorkflowStore

    if (decoded._tag === "PullRequest") {
      const result = yield* store.ingestPullRequest(delivery, decoded)
      return Response.json(result, { status: 202 })
    }
    if (decoded._tag === "Command") {
      const result = yield* store.ingestCommand(delivery, decoded)
      return Response.json(result, { status: 202 })
    }

    const result = yield* store.recordDelivery(delivery)
    return Response.json(
      result === "duplicate"
        ? { status: "duplicate" }
        : { status: "ignored", reason: decoded.reason },
      { status: 202 },
    )
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError("Webhook ingestion failed", cause).pipe(
        Effect.as(Response.json({ error: "internal server error" }, { status: 500 })),
      ),
    ),
  )
}
