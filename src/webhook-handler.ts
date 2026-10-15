import { Effect, Schema } from "effect"
import { webhookInstallationId, webhookRepositoryAllowed } from "./webhook-installations"
import { decodeGitHubEvent } from "./github-event"
import { JsonText } from "./json"
import { WorkflowStore, type WorkflowStorePort } from "./store/contracts"
import type { IngestPullRequestResult } from "./store/model"
import { WorkSignal, type WorkSignalPort } from "./work-signal"
import { verifyWebhookSignature } from "./webhook"
import type { WebhookHandlerOptions } from "./http"

function wakePullRequestWork(signals: WorkSignalPort, result: IngestPullRequestResult) {
  if (result.status === "duplicate") return Effect.void
  const reconciliation = signals.wake("reconciliation")
  return result.status === "enqueued"
    ? signals.wake("job").pipe(Effect.andThen(reconciliation))
    : reconciliation
}

function wakeCommandWork(
  signals: WorkSignalPort,
  result: { readonly status: "duplicate" | "enqueued" },
) {
  return result.status === "enqueued" ? signals.wake("command") : Effect.void
}

function webhookAction(payload: unknown) {
  return typeof payload === "object" &&
    payload !== null &&
    "action" in payload &&
    typeof payload.action === "string"
    ? payload.action
    : null
}

function installationGateResponse(
  payload: unknown,
  options: WebhookHandlerOptions,
  deliveryId: string,
  eventName: string,
): Effect.Effect<Response | undefined> {
  return Effect.gen(function* () {
    const installationId = webhookInstallationId(payload)
    const configured = installationId !== undefined && options.installationIds.has(installationId)
    const repositories =
      eventName === "pull_request" ||
      eventName === "issue_comment" ||
      eventName === "check_run" ||
      (eventName === "check_suite" && webhookAction(payload) === "rerequested")
        ? (options.prRepositories ?? [])
        : eventName === "workflow_run" || eventName === "check_suite"
          ? (options.ciRepositories ?? [])
          : undefined
    const repositoryAllowed =
      repositories === undefined || webhookRepositoryAllowed(payload, installationId, repositories)
    if (!configured || !repositoryAllowed) {
      yield* Effect.logDebug({ deliveryId, installationId })
      return Response.json(
        {
          status: "ignored",
          reason:
            installationId === undefined
              ? "missing-installation"
              : !configured
                ? "installation-not-configured"
                : "repository-not-configured",
        },
        { status: 202 },
      )
    }
  })
}

export function handleGitHubWebhook(
  request: Request,
  options: WebhookHandlerOptions,
): Effect.Effect<Response, never, WorkflowStorePort | WorkSignalPort> {
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
    const payload = yield* Schema.decodeUnknownEffect(JsonText)(bodyText).pipe(
      Effect.catch(() => Effect.succeed(Response.json({ error: "invalid JSON" }, { status: 400 }))),
    )
    if (payload instanceof Response) return payload

    const action = webhookAction(payload)
    const delivery = {
      deliveryId,
      event: eventName,
      action,
      payload: bodyText,
      receivedAt: options.now,
    }
    if (options.installationGuard !== undefined) {
      const outcome = yield* options.installationGuard.handle(delivery, payload)
      if (outcome !== undefined) return Response.json({ status: outcome }, { status: 202 })
    }

    const ignored = yield* installationGateResponse(payload, options, deliveryId, eventName)
    if (ignored !== undefined) return ignored

    const checkIdentity = () =>
      options
        .checkAgentGitIdentity?.(eventName, payload)
        .pipe(Effect.catch(() => Effect.logError("Git identity check unavailable"))) ?? Effect.void
    const decode =
      options.ci === undefined && (eventName === "workflow_run" || eventName === "check_suite")
        ? Effect.succeed({ _tag: "Ignored" as const, reason: `unsupported:${eventName}` })
        : decodeGitHubEvent(eventName, payload, options.prRepositories)
    const decoded = yield* decode.pipe(
      Effect.catch((error) =>
        Effect.succeed(Response.json({ error: error.message }, { status: 400 })),
      ),
    )
    if (decoded instanceof Response) return decoded

    if (decoded._tag === "CiCompletion" && options.ci !== undefined) {
      const status = yield* options.ci.ingest(deliveryId, decoded, bodyText, options.now.getTime())
      return Response.json({ status }, { status: 202 })
    }
    const store = yield* WorkflowStore
    const signals = yield* WorkSignal

    if (decoded._tag === "PullRequest") {
      const result = yield* store.ingestPullRequest(delivery, decoded)
      yield* wakePullRequestWork(signals, result)
      yield* checkIdentity()
      return Response.json(result, { status: 202 })
    }
    if (decoded._tag === "Command") {
      const result = yield* store.ingestCommand(delivery, decoded)
      yield* wakeCommandWork(signals, result)
      return Response.json(result, { status: 202 })
    }

    const result = yield* store.recordDelivery(delivery)
    yield* checkIdentity()
    return Response.json(
      result === "duplicate"
        ? { status: "duplicate" }
        : {
            status: "ignored",
            reason: decoded._tag === "CiCompletion" ? "ci-disabled" : decoded.reason,
          },
      { status: 202 },
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Webhook ingestion failed", cause).pipe(
        Effect.as(Response.json({ error: "internal server error" }, { status: 500 })),
      ),
    ),
  )
}
