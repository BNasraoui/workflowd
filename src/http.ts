import { Effect, Schema } from "effect"
import type { ReviewAvailability } from "./review-availability"
import { createHash, timingSafeEqual } from "node:crypto"
import { AgentRunSubmission } from "./agent-run-contract"
import type { CiStore } from "./ci/store"
import type { ExecutionCapabilities } from "./execution-capability-contract"
import type { InstallationGuard } from "./installation-guard"
import { JsonText } from "./json"
import {
  AgentRunRefusalError,
  type AgentRunIngressError,
  type AgentRunIngressPort,
} from "./kernel/agent-run-ingress"
import { AgentRunStoreConflictError } from "./kernel/agent-run-store"
import {
  AgentWaitCustodyError,
  AgentWaitSubmission,
  type AgentWaitIngressError,
  type AgentWaitIngressPort,
} from "./kernel/agent-wait-ingress"
import type { DogfoodStorePort } from "./kernel/dogfood-store"
import { KernelStoreConflictError } from "./kernel/event-store"
import { KernelSessionStoreConflictError } from "./kernel/session-store"
import {
  TestJobCanaryConflict,
  TestJobCanaryNotFound,
  TestJobId,
  TestJobSubmission,
  type TestJobCanaryError,
  type TestJobCanaryPort,
} from "./kernel/test-job-canary"
import type { PrRepositories } from "./pr-automation-config"
import type { WorkflowStartError } from "./qrspi/workflow-start"
import type { WorkflowStorePort } from "./store/contracts"
import { handleGitHubWebhook } from "./webhook-handler"
import type { WorkSignalPort } from "./work-signal"
export { handleGitHubWebhook } from "./webhook-handler"

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

type AgentRunIngressBinding = Pick<AgentRunIngressPort, "register" | "cancel"> & {
  readonly token: string
}

type DogfoodBinding = Pick<DogfoodStorePort, "sessions"> & {
  readonly token: string
}

export type WebhookHandlerOptions = {
  readonly reviewAutomation?: Effect.Effect<ReviewAvailability>
  readonly fixAutomation?: Effect.Effect<ReviewAvailability>
  readonly installationGuard?: typeof InstallationGuard.Service
  readonly checkAgentGitIdentity?: (event: string, payload: unknown) => Effect.Effect<void, Error>
  readonly prAutomationEnabled?: boolean
  readonly installationIds: ReadonlySet<number>
  readonly prRepositories?: PrRepositories
  readonly ciRepositories?: PrRepositories
  readonly ci?: { readonly ingest: CiStore["ingest"] }
  readonly webhookSecret: string
  readonly now: Date
  readonly maxBodyBytes?: number
  readonly qrspi?: QrspiIngress
  readonly testJobs?: TestJobIngress
  readonly agentWaits?: AgentWaitIngressBinding
  readonly agentRuns?: AgentRunIngressBinding
  readonly dogfood?: DogfoodBinding
  readonly executionCapabilities?: {
    readonly token: string
    readonly list: () => Effect.Effect<ExecutionCapabilities, Error>
  }
}

function healthResponse(options: WebhookHandlerOptions) {
  return Effect.gen(function* () {
    const installationGuard = yield* options.installationGuard?.health() ??
      Effect.succeed(undefined)
    const reviewAutomation = yield* options.reviewAutomation ?? Effect.succeed(undefined)
    const fixAutomation = yield* options.fixAutomation ?? Effect.succeed(undefined)
    const reviewDegraded = [reviewAutomation, fixAutomation].some(
      (automation) =>
        automation !== undefined && !["available", "disabled"].includes(automation.status),
    )
    return Response.json({
      status: reviewDegraded ? "degraded" : (installationGuard?.status ?? "ok"),
      ...(installationGuard === undefined ? {} : { installationGuard }),
      ...(reviewAutomation === undefined ? {} : { reviewAutomation }),
      ...(fixAutomation === undefined ? {} : { fixAutomation }),
    })
  })
}

export function routeRequest(
  request: Request,
  options: WebhookHandlerOptions,
): Effect.Effect<Response, never, WorkflowStorePort | WorkSignalPort> {
  const { pathname } = new URL(request.url)
  if (
    pathname === "/execution-capabilities" &&
    request.method === "GET" &&
    options.executionCapabilities !== undefined
  ) {
    if (!authorized(request.headers.get("authorization"), options.executionCapabilities.token)) {
      return Effect.succeed(Response.json({ error: "unauthorized" }, { status: 401 }))
    }
    return options.executionCapabilities.list().pipe(
      Effect.match({
        onSuccess: (capabilities) => Response.json(capabilities),
        onFailure: () =>
          Response.json({ error: "capability discovery unavailable" }, { status: 503 }),
      }),
    )
  }
  if (pathname === "/health" && request.method === "GET") {
    return healthResponse(options)
  }
  if (pathname === "/hooks/github" && request.method === "POST") {
    return options.prAutomationEnabled === false
      ? Effect.succeed(Response.json({ error: "not found" }, { status: 404 }))
      : handleGitHubWebhook(request, options)
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
  const agentRunCancel = /^\/workflows\/agent-runs\/(agent-run-[a-zA-Z0-9_-]+)$/.exec(pathname)
  if (agentRunCancel !== null && request.method === "DELETE" && options.agentRuns !== undefined) {
    return handleAgentRunCancel(request, options.agentRuns, agentRunCancel[1]!, options.now)
  }
  if (
    pathname === "/workflows/agent-runs" &&
    request.method === "POST" &&
    options.agentRuns !== undefined
  ) {
    return handleAgentRunRegister(
      request,
      options.agentRuns,
      options.now,
      options.maxBodyBytes ?? 1_048_576,
    )
  }
  if (
    pathname === "/workflows/dogfood/sessions" &&
    request.method === "GET" &&
    options.dogfood !== undefined
  ) {
    return handleDogfoodSessions(request, options.dogfood)
  }
  const testJobResponse = routeTestJobRequest(request, pathname, options)
  if (testJobResponse !== undefined) return testJobResponse
  return Effect.succeed(Response.json({ error: "not found" }, { status: 404 }))
}

function handleAgentRunCancel(
  request: Request,
  ingress: AgentRunIngressBinding,
  runId: string,
  now: Date,
) {
  if (!authorized(request.headers.get("authorization"), ingress.token)) {
    return Effect.succeed(Response.json({ error: "unauthorized" }, { status: 401 }))
  }
  return ingress.cancel(runId, now).pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        const response = agentRunFailure(error)
        return response.status === 500
          ? Effect.logError("Agent-run cancellation failed", error).pipe(Effect.as(response))
          : Effect.succeed(response)
      },
      onSuccess: () => Effect.succeed(new Response(null, { status: 204 })),
    }),
    Effect.catchCause((cause) =>
      Effect.logError("Agent-run cancellation failed", cause).pipe(
        Effect.as(Response.json({ error: "internal server error" }, { status: 500 })),
      ),
    ),
  )
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
  if ("_tag" in error && error._tag === "SchemaError") {
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

function handleAgentRunRegister(
  request: Request,
  ingress: AgentRunIngressBinding,
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
    const input = yield* Schema.decodeUnknownEffect(AgentRunSubmission)(json, {
      onExcessProperty: "error",
    }).pipe(Effect.result)
    if (input._tag === "Failure") {
      return Response.json(
        {
          error:
            "invalid agent run: provide exactly one of route or model, plus repository and prompt " +
            "as non-empty strings; optional selection and parent fields must match the schema",
        },
        { status: 400 },
      )
    }
    return yield* ingress.register(input.success, now).pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          const response = agentRunFailure(error)
          // Opaque failures still need an operator trail; refusals and
          // conflicts are the caller's to read.
          return response.status === 500
            ? Effect.logError("Agent-run ingress failed", error).pipe(Effect.as(response))
            : Effect.succeed(response)
        },
        onSuccess: (receipt) => Effect.succeed(Response.json(receipt, { status: 202 })),
      }),
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Agent-run ingress failed", cause).pipe(
        Effect.as(Response.json({ error: "internal server error" }, { status: 500 })),
      ),
    ),
  )
}

/**
 * Read-only provenance ground truth: bearer-token guarded like the other
 * token-bearing surfaces, then a single store query shaped as the
 * `provenance-dogfood-enrichment/v1` document.
 */
function handleDogfoodSessions(request: Request, dogfood: DogfoodBinding) {
  if (!authorized(request.headers.get("authorization"), dogfood.token)) {
    return Effect.succeed(Response.json({ error: "unauthorized" }, { status: 401 }))
  }
  return dogfood.sessions().pipe(
    Effect.map((enrichment) => Response.json(enrichment)),
    Effect.catchCause((cause) =>
      Effect.logError("Dogfood enrichment failed", cause).pipe(
        Effect.as(Response.json({ error: "internal server error" }, { status: 500 })),
      ),
    ),
  )
}

/**
 * Refusals carry the machine-readable reason a dead or misnamed route was
 * rejected; every other failure is a store or provider fault and stays
 * opaque.
 */
function agentRunFailure(error: AgentRunIngressError): Response {
  if (error instanceof AgentRunRefusalError) {
    return Response.json(
      {
        error: "refused",
        reason: error.reason,
        detail: error.detail,
        ...(error.mailboxId === undefined ? {} : { mailboxId: error.mailboxId }),
      },
      { status: 409 },
    )
  }
  if (
    error instanceof AgentRunStoreConflictError ||
    error instanceof KernelStoreConflictError ||
    error instanceof KernelSessionStoreConflictError
  ) {
    return Response.json({ error: "conflict", reason: "idempotency_conflict" }, { status: 409 })
  }
  if (error instanceof AgentWaitCustodyError) {
    return Response.json(
      { error: "custody", reason: error.reason, detail: error.explanation },
      { status: 409 },
    )
  }
  return Response.json({ error: "internal server error" }, { status: 500 })
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
