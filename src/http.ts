import { createHash, timingSafeEqual } from "node:crypto"
import { Effect, Schema } from "effect"
import { decodeGitHubEvent } from "./github-event"
import { JsonText } from "./json"
import { WorkflowStore, type WorkflowStorePort } from "./store/contracts"
import type { IngestPullRequestResult } from "./store/model"
import { verifyWebhookSignature } from "./webhook"
import type { WorkflowStartError } from "./qrspi/workflow-start"
import { WorkSignal, type WorkSignalPort } from "./work-signal"
import {
  TestJobCanaryConflict,
  TestJobCanaryNotFound,
  TestJobSubmission,
  TestJobId,
  type TestJobCanaryError,
  type TestJobCanaryPort,
} from "./kernel/test-job-canary"
import {
  AgentWaitCustodyError,
  AgentWaitSubmission,
  type AgentWaitIngressError,
  type AgentWaitIngressPort,
} from "./kernel/agent-wait-ingress"
import { KernelStoreConflictError } from "./kernel/event-store"

type QrspiIngress = {
  readonly token: string
  readonly start: (input: unknown) => Effect.Effect<object, WorkflowStartError, never>
}

type TestJobIngress = Pick<TestJobCanaryPort, "submit" | "status"> & {
  readonly token: string
}

type AgentWaitIngressBinding = Pick<AgentWaitIngressPort, "register"> & {
  readonly token: string
}

export type WebhookHandlerOptions = {
  readonly webhookSecret: string
  readonly now: Date
  readonly maxBodyBytes?: number
  readonly qrspi?: QrspiIngress
  readonly testJobs?: TestJobIngress
  readonly agentWaits?: AgentWaitIngressBinding
}

export function routeRequest(
  request: Request,
  options: WebhookHandlerOptions,
): Effect.Effect<Response, never, WorkflowStorePort | WorkSignalPort> {
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
  if (
    pathname === "/workflows/agent-waits" &&
    request.method === "POST" &&
    options.agentWaits !== undefined
  ) {
    return handleAgentWaitRegister(
      request,
      options.agentWaits,
      options.now,
      options.maxBodyBytes ?? 1_048_576,
    )
  }
  const testJobResponse = routeTestJobRequest(request, pathname, options)
  if (testJobResponse !== undefined) return testJobResponse
  return Effect.succeed(Response.json({ error: "not found" }, { status: 404 }))
}

function routeTestJobRequest(
  request: Request,
  pathname: string,
  options: WebhookHandlerOptions,
): Effect.Effect<Response, never> | undefined {
  if (options.testJobs === undefined) return undefined
  if (pathname === "/workflows/test-jobs" && request.method === "POST") {
    return handleTestJobSubmit(
      request,
      options.testJobs,
      options.now,
      options.maxBodyBytes ?? 1_048_576,
    )
  }
  const match = /^\/workflows\/test-jobs\/([^/]+)$/.exec(pathname)
  if (match === null || request.method !== "GET") return undefined
  try {
    return handleTestJobStatus(request, options.testJobs, decodeURIComponent(match[1]!))
  } catch {
    return Effect.succeed(Response.json({ error: "invalid test job ID" }, { status: 400 }))
  }
}

function handleTestJobSubmit(
  request: Request,
  ingress: TestJobIngress,
  now: Date,
  maxBodyBytes: number,
) {
  return Effect.gen(function* () {
    if (!authorized(request.headers.get("authorization"), ingress.token)) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }
    const bytes = new Uint8Array(yield* Effect.tryPromise(() => request.arrayBuffer()))
    if (bytes.byteLength > maxBodyBytes) {
      return Response.json({ error: "payload too large" }, { status: 413 })
    }
    const json = yield* Schema.decodeUnknownEffect(JsonText)(new TextDecoder().decode(bytes)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (json === undefined) return Response.json({ error: "invalid JSON" }, { status: 400 })
    const input = yield* Schema.decodeUnknownEffect(TestJobSubmission)(json, {
      onExcessProperty: "error",
    }).pipe(Effect.result)
    if (input._tag === "Failure")
      return Response.json({ error: "invalid test job" }, { status: 400 })
    return yield* ingress.submit(input.success, now).pipe(
      Effect.match({
        onFailure: (error) =>
          error instanceof TestJobCanaryConflict
            ? Response.json({ error: "conflict" }, { status: 409 })
            : Response.json({ error: "internal server error" }, { status: 500 }),
        onSuccess: ({ newlyEnqueued: _, ...result }) => Response.json(result, { status: 202 }),
      }),
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Test-job ingress failed", cause).pipe(
        Effect.as(Response.json({ error: "internal server error" }, { status: 500 })),
      ),
    ),
  )
}

function handleTestJobStatus(request: Request, ingress: TestJobIngress, jobId: string) {
  if (!authorized(request.headers.get("authorization"), ingress.token)) {
    return Effect.succeed(Response.json({ error: "unauthorized" }, { status: 401 }))
  }
  return Schema.decodeUnknownEffect(TestJobId)(jobId).pipe(
    Effect.flatMap(ingress.status),
    Effect.match({
      onFailure: testJobStatusFailure,
      onSuccess: (result) => Response.json(result),
    }),
  )
}

function testJobStatusFailure(error: TestJobCanaryError): Response {
  if (error instanceof TestJobCanaryNotFound) {
    return Response.json({ error: "not found" }, { status: 404 })
  }
  if ("_tag" in error && error._tag === "ParseError") {
    return Response.json({ error: "invalid test job ID" }, { status: 400 })
  }
  return Response.json({ error: "internal server error" }, { status: 500 })
}

function handleAgentWaitRegister(
  request: Request,
  ingress: AgentWaitIngressBinding,
  now: Date,
  maxBodyBytes: number,
) {
  return Effect.gen(function* () {
    if (!authorized(request.headers.get("authorization"), ingress.token)) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }
    const bytes = new Uint8Array(yield* Effect.tryPromise(() => request.arrayBuffer()))
    if (bytes.byteLength > maxBodyBytes) {
      return Response.json({ error: "payload too large" }, { status: 413 })
    }
    const json = yield* Schema.decodeUnknownEffect(JsonText)(new TextDecoder().decode(bytes)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (json === undefined) return Response.json({ error: "invalid JSON" }, { status: 400 })
    const input = yield* Schema.decodeUnknownEffect(AgentWaitSubmission)(json, {
      onExcessProperty: "error",
    }).pipe(Effect.result)
    if (input._tag === "Failure") {
      return Response.json(
        {
          error:
            "invalid agent wait: parentSessionId, childSessionId and resumePrompt are " +
            "required non-empty strings, with an optional idempotencyKey",
        },
        { status: 400 },
      )
    }
    return yield* ingress.register(input.success, now).pipe(
      Effect.match({
        onFailure: agentWaitFailure,
        onSuccess: (receipt) => Response.json(receipt, { status: 202 }),
      }),
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Agent-wait ingress failed", cause).pipe(
        Effect.as(Response.json({ error: "internal server error" }, { status: 500 })),
      ),
    ),
  )
}

/**
 * Custody refusals are the caller's problem and name the exact missing
 * custody; every other failure is a store or provider fault and stays
 * opaque.
 */
function agentWaitFailure(error: AgentWaitIngressError): Response {
  if (error instanceof AgentWaitCustodyError) {
    return Response.json(
      { error: "custody", reason: error.reason, detail: error.explanation },
      { status: 409 },
    )
  }
  if (error instanceof KernelStoreConflictError) {
    return Response.json({ error: "conflict", reason: "idempotency_conflict" }, { status: 409 })
  }
  return Response.json({ error: "internal server error" }, { status: 500 })
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
    const payload = yield* Schema.decodeUnknownEffect(JsonText)(
      new TextDecoder().decode(bytes),
    ).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (payload === undefined) return Response.json({ error: "invalid JSON" }, { status: 400 })
    return yield* ingress.start(payload).pipe(
      Effect.match({
        onFailure: (error) =>
          Response.json({ error: error._tag }, { status: workflowStartStatus(error) }),
        onSuccess: (result) => Response.json(result, { status: 202 }),
      }),
    )
  }).pipe(
    Effect.catchCause((cause) =>
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
    case "WorkflowStartValidationError":
    case "SqlError":
      return 503
    case "QrspiStoreDataError":
      return 500
  }
}

function authorized(header: string | null, token: string) {
  if (header === null || !header.startsWith("Bearer ")) return false
  const supplied = createHash("sha256").update(header.slice("Bearer ".length)).digest()
  const expected = createHash("sha256").update(token).digest()
  return timingSafeEqual(supplied, expected)
}

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

    const decoded = yield* decodeGitHubEvent(eventName, payload).pipe(
      Effect.catch((error) =>
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
    const signals = yield* WorkSignal

    if (decoded._tag === "PullRequest") {
      const result = yield* store.ingestPullRequest(delivery, decoded)
      yield* wakePullRequestWork(signals, result)
      return Response.json(result, { status: 202 })
    }
    if (decoded._tag === "Command") {
      const result = yield* store.ingestCommand(delivery, decoded)
      yield* wakeCommandWork(signals, result)
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
    Effect.catchCause((cause) =>
      Effect.logError("Webhook ingestion failed", cause).pipe(
        Effect.as(Response.json({ error: "internal server error" }, { status: 500 })),
      ),
    ),
  )
}
