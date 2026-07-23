import { timingSafeEqual } from "node:crypto"
import { Effect, Schema } from "effect"
import { decodeGitHubEvent } from "./github-event"
import { JsonText } from "./json"
import { WorkflowStore, type WorkflowStorePort } from "./store/contracts"
import { verifyWebhookSignature } from "./webhook"
import type { WorkflowStartError } from "./qrspi/workflow-start"

type QrspiIngress = {
  readonly token: string
  readonly start: (input: unknown) => Effect.Effect<object, WorkflowStartError, never>
}

export type WebhookHandlerOptions = {
  readonly webhookSecret: string
  readonly now: Date
  readonly maxBodyBytes?: number
  readonly qrspi?: QrspiIngress
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
  if (pathname === "/workflows/qrspi" && request.method === "POST" && options.qrspi !== undefined) {
    return handleQrspiStart(request, options.qrspi, options.maxBodyBytes ?? 1_048_576)
  }
  return Effect.succeed(Response.json({ error: "not found" }, { status: 404 }))
}

function handleQrspiStart(request: Request, ingress: QrspiIngress, maxBodyBytes: number) {
  return Effect.gen(function* () {
    if (!authorized(request.headers.get("authorization"), ingress.token)) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }
    const bytes = new Uint8Array(yield* Effect.tryPromise(() => request.arrayBuffer()))
    if (bytes.byteLength > maxBodyBytes) {
      return Response.json({ error: "payload too large" }, { status: 413 })
    }
    const payload = yield* Schema.decodeUnknown(JsonText)(new TextDecoder().decode(bytes)).pipe(
      Effect.catchAll(() => Effect.succeed(undefined)),
    )
    if (payload === undefined) return Response.json({ error: "invalid JSON" }, { status: 400 })
    return yield* ingress.start(payload).pipe(
      Effect.match({
        onFailure: (error) =>
          Response.json({ error: error._tag }, { status: workflowStartStatus(error) }),
        onSuccess: (result) => Response.json(result, { status: 202 }),
      }),
    )
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError("QRSPI ingress failed", cause).pipe(
        Effect.as(Response.json({ error: "internal server error" }, { status: 500 })),
      ),
    ),
  )
}

function workflowStartStatus(error: WorkflowStartError): number {
  switch (error._tag) {
    case "WorkflowStartUnauthorized":
    case "TicketReadError":
      return 400
    case "WorkflowStartConflict":
    case "WorkflowStartSuperseded":
    case "WorkflowStartBusy":
    case "WorkflowStartUncertain":
    case "WorkflowStartNeedsOperator":
    case "WorkflowStartRetryExhausted":
      return 409
    case "TicketSourceError":
    case "QrspiRepositoryError":
    case "StageCatalogError":
    case "AgentHarnessError":
    case "WorkflowDefinitionValidationError":
    case "SqlError":
      return 503
    case "QrspiStoreDataError":
      return 500
  }
}

function authorized(header: string | null, token: string) {
  if (header === null || !header.startsWith("Bearer ")) return false
  const supplied = Buffer.from(header.slice("Bearer ".length))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
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

    const body = new Uint8Array(yield* Effect.tryPromise(() => request.arrayBuffer()))
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
