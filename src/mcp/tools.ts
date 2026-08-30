import { Effect, Schema } from "effect"
import { RemoteProbeProducer } from "../remote/probe-producer"
import { RemoteHostId } from "../remote/contract"
import { McpQueries, MAX_RECENT_JOBS } from "./queries"
import {
  AgentWaitReceipt,
  AgentWaitRefusal,
  MAX_AGENT_WAIT_IDEMPOTENCY_KEY_BYTES,
  MAX_AGENT_WAIT_SESSION_ID_BYTES,
  MAX_RESUME_PROMPT_BYTES,
  utf8BoundedText,
} from "../agent-wait-contract"
import {
  AgentRunReceipt,
  MAX_AGENT_RUN_IDEMPOTENCY_KEY_BYTES,
  MAX_AGENT_RUN_PROMPT_BYTES,
  MAX_AGENT_RUN_REPOSITORY_BYTES,
  MAX_AGENT_RUN_ROUTE_BYTES,
} from "../agent-run-contract"

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/**
 * How the MCP process reaches the workflowd daemon. The read tools go
 * straight to SQLite, while registering an agent wait must atomically commit
 * kernel custody and wake completion work, so `wait_for_agent` posts to the
 * daemon's own ingress instead of duplicating that machinery here.
 * The MCP process therefore stays stateless.
 */
export type AgentWaitDaemon = {
  readonly baseUrl: string
  readonly token: string
  /** Seam for tests; defaults to the global fetch. */
  readonly send?: (input: URL, init: RequestInit) => Promise<Response>
}

export type ToolCallContext = {
  readonly writesAuthorized: boolean
  readonly writesConfigured: boolean
  readonly now: () => Date
  readonly agentWaitDaemon?: AgentWaitDaemon
  readonly agentRunDaemon?: AgentWaitDaemon
}

const JobStatusArguments = Schema.Struct({ job_id: Schema.NonEmptyString })
const ListRecentJobsArguments = Schema.Struct({
  limit: Schema.optional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_RECENT_JOBS }))),
  ),
})
const EnqueueProbeArguments = Schema.Struct({
  host: RemoteHostId,
  probe_id: Schema.optional(
    Schema.NonEmptyString.pipe(
      Schema.check(Schema.isMaxLength(128)),
      Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)),
    ),
  ),
})

const WaitForAgentArguments = Schema.Struct({
  parent_session_id: utf8BoundedText(MAX_AGENT_WAIT_SESSION_ID_BYTES),
  child_session_id: utf8BoundedText(MAX_AGENT_WAIT_SESSION_ID_BYTES),
  resume_prompt: utf8BoundedText(MAX_RESUME_PROMPT_BYTES),
  idempotency_key: Schema.optional(utf8BoundedText(MAX_AGENT_WAIT_IDEMPOTENCY_KEY_BYTES)),
})

const DispatchAgentArguments = Schema.Struct({
  route: utf8BoundedText(MAX_AGENT_RUN_ROUTE_BYTES),
  repository: utf8BoundedText(MAX_AGENT_RUN_REPOSITORY_BYTES),
  prompt: utf8BoundedText(MAX_AGENT_RUN_PROMPT_BYTES),
  parent_session_id: Schema.optional(utf8BoundedText(MAX_AGENT_WAIT_SESSION_ID_BYTES)),
  resume_prompt: Schema.optional(utf8BoundedText(MAX_AGENT_RUN_PROMPT_BYTES)),
  idempotency_key: Schema.optional(utf8BoundedText(MAX_AGENT_RUN_IDEMPOTENCY_KEY_BYTES)),
})

/**
 * Dispatch holds the HTTP request open through the daemon's bounded
 * first-token verification (up to ~2 minutes), so its timeout is far larger
 * than the agent-wait proxy's.
 */
const DISPATCH_AGENT_TIMEOUT_MS = 180_000

const structured = (value: Record<string, unknown>, rendering?: string): ToolResult => ({
  content: [{ type: "text", text: rendering ?? JSON.stringify(value, null, 2) }],
  structuredContent: value,
})
const failure = (value: string, refusal?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: value }],
  ...(refusal === undefined ? {} : { structuredContent: refusal }),
  isError: true,
})
const json = (value: Record<string, unknown>): ToolResult => structured(value)

const generatedProbeId = (now: Date) => {
  const stamp = now.toISOString().replace(/[-:.]/g, "").slice(0, 15)
  const suffix = crypto.randomUUID().slice(0, 8)
  return `mcp-${stamp}-${suffix}`
}

const decodeArguments = <A, I>(schema: Schema.Codec<A, I>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value ?? {}, { onExcessProperty: "error" })

/**
 * Executes one tool call. Every failure is reported as an in-band tool
 * error (never a protocol error) so agents see actionable text. Failure
 * text never contains credential material.
 */
export const callTool = (name: string, args: unknown, context: ToolCallContext) =>
  Effect.gen(function* () {
    switch (name) {
      case "job_status": {
        const queries = yield* McpQueries
        const input = yield* decodeArguments(JobStatusArguments, args).pipe(Effect.result)
        if (input._tag === "Failure")
          return failure("invalid arguments: job_id (string) is required")
        const status = yield* queries
          .jobStatus(input.success.job_id)
          .pipe(Effect.catch(() => Effect.succeed(null)))
        return status === null
          ? failure(`no job found with id ${input.success.job_id}`)
          : json(status)
      }
      case "list_recent_jobs": {
        const queries = yield* McpQueries
        const input = yield* decodeArguments(ListRecentJobsArguments, args).pipe(Effect.result)
        if (input._tag === "Failure") {
          return failure(`invalid arguments: limit must be an integer 1-${MAX_RECENT_JOBS}`)
        }
        const rows = yield* queries.listRecentJobs(input.success.limit ?? 20)
        return json({ jobs: rows })
      }
      case "host_health": {
        const queries = yield* McpQueries
        const hosts = yield* queries.hostHealth()
        return json({ hosts })
      }
      case "enqueue_probe":
        return yield* enqueueProbe(args, context)
      case "wait_for_agent":
        return yield* waitForAgent(args, context)
      case "dispatch_agent":
        return yield* dispatchAgent(args, context)
      default:
        return failure(`unknown tool: ${name}`)
    }
  })

const enqueueProbe = (args: unknown, context: ToolCallContext) =>
  Effect.gen(function* () {
    if (!context.writesConfigured) {
      return failure(
        "writes are disabled: no WORKFLOWD_MCP_TOKEN or WORKFLOWD_MCP_TOKEN_FILE is " +
          "configured on the server, so enqueue_probe refuses all calls",
      )
    }
    if (!context.writesAuthorized) {
      return failure("unauthorized: enqueue_probe requires a valid bearer token")
    }
    const input = yield* decodeArguments(EnqueueProbeArguments, args).pipe(Effect.result)
    if (input._tag === "Failure") {
      return failure(
        "invalid arguments: host must match a workflowd host id and probe_id, when " +
          "given, must start with an alphanumeric and use only [A-Za-z0-9_.-]",
      )
    }
    const now = context.now()
    const probeId = input.success.probe_id ?? generatedProbeId(now)
    const producer = yield* RemoteProbeProducer
    const enqueued = yield* producer
      .enqueue({ probeId, hostId: input.success.host }, now)
      .pipe(Effect.result)
    if (enqueued._tag === "Failure") {
      return failure(
        `enqueue failed for probe ${probeId} on host ${input.success.host}: the probe ` +
          "identity may already exist for a different host, or the store rejected the input",
      )
    }
    const received =
      enqueued.success.status === "duplicate"
        ? `Already received: probe ${probeId} was previously accepted as job ${enqueued.success.jobId}.`
        : `Received: probe ${probeId} accepted as durable job ${enqueued.success.jobId} for host ${input.success.host}.`
    return structured(
      {
        probe_id: probeId,
        job_id: enqueued.success.jobId,
        host: input.success.host,
        status: enqueued.success.status === "duplicate" ? "duplicate" : "enqueued",
      },
      `${received} This is a fire-and-ack receipt — the job runs asynchronously and ` +
        "no blocking wait exists. End your turn now. Use job_status " +
        `("${enqueued.success.jobId}") in a later turn to read the outcome.`,
    )
  })

/**
 * Posts one write to a daemon ingress and normalizes transport, non-JSON,
 * and refusal outcomes into in-band tool failures. Success returns the
 * decoded-later JSON payload.
 */
const postToDaemon = (
  daemon: AgentWaitDaemon,
  request: {
    readonly path: string
    readonly subject: string
    readonly timeoutMs: number
    readonly body: Record<string, unknown>
  },
) =>
  Effect.gen(function* () {
    const send = daemon.send ?? ((input: URL, init: RequestInit) => fetch(input, init))
    const response = yield* Effect.tryPromise(() =>
      send(new URL(request.path, daemon.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${daemon.token}`,
        },
        signal: AbortSignal.timeout(request.timeoutMs),
        body: JSON.stringify(request.body),
      }),
    ).pipe(Effect.timeout(request.timeoutMs), Effect.result)
    if (response._tag === "Failure") {
      return {
        failure: failure(
          `could not reach the workflowd daemon to register ${request.subject}; the daemon ` +
            "may be down or WORKFLOWD_DAEMON_URL may be wrong",
        ),
      }
    }
    const payload = yield* Effect.tryPromise(() => response.success.json()).pipe(Effect.result)
    if (payload._tag === "Failure") {
      return {
        failure: failure(
          `the workflowd daemon returned a non-JSON response (HTTP ${response.success.status})`,
        ),
      }
    }
    if (!response.success.ok) {
      const refusal = yield* decodeArguments(AgentWaitRefusal, payload.success).pipe(Effect.result)
      const detail =
        refusal._tag === "Success"
          ? (refusal.success.detail ?? refusal.success.reason ?? refusal.success.error)
          : `HTTP ${response.success.status}`
      return {
        failure: failure(
          `${request.subject} was refused: ${detail}`,
          refusal._tag === "Success" ? { ...refusal.success } : undefined,
        ),
      }
    }
    return { payload: payload.success }
  })

const waitForAgent = (args: unknown, context: ToolCallContext) =>
  Effect.gen(function* () {
    if (!context.writesConfigured) {
      return failure(
        "writes are disabled: no WORKFLOWD_MCP_TOKEN or WORKFLOWD_MCP_TOKEN_FILE is " +
          "configured on the server, so wait_for_agent refuses all calls",
      )
    }
    if (!context.writesAuthorized) {
      return failure("unauthorized: wait_for_agent requires a valid bearer token")
    }
    const daemon = context.agentWaitDaemon
    if (daemon === undefined) {
      return failure(
        "agent waits are not configured on this MCP server: set WORKFLOWD_DAEMON_URL and " +
          "WORKFLOWD_AGENT_WAIT_TOKEN (or WORKFLOWD_AGENT_WAIT_TOKEN_FILE) on the MCP unit " +
          "so wait_for_agent can reach the workflowd daemon's /workflows/agent-waits ingress",
      )
    }
    const input = yield* decodeArguments(WaitForAgentArguments, args).pipe(Effect.result)
    if (input._tag === "Failure") {
      return failure(
        "invalid arguments: parent_session_id, child_session_id and resume_prompt must be " +
          `non-empty strings (resume_prompt at most ${MAX_RESUME_PROMPT_BYTES} UTF-8 bytes), ` +
          "and idempotency_key, when given, must be a non-empty string",
      )
    }
    const outcome = yield* postToDaemon(daemon, {
      path: "/workflows/agent-waits",
      subject: "the wait",
      timeoutMs: 10_000,
      body: {
        parentSessionId: input.success.parent_session_id,
        childSessionId: input.success.child_session_id,
        resumePrompt: input.success.resume_prompt,
        ...(input.success.idempotency_key === undefined
          ? {}
          : { idempotencyKey: input.success.idempotency_key }),
      },
    })
    if ("failure" in outcome) return outcome.failure
    const receipt = yield* decodeArguments(AgentWaitReceipt, outcome.payload).pipe(Effect.result)
    if (receipt._tag === "Failure") {
      return failure("the workflowd daemon returned an unrecognized agent-wait receipt")
    }
    const received =
      receipt.success.status === "duplicate"
        ? `Already registered: this wait already exists as ${receipt.success.waitId}.`
        : `Received: watching ${input.success.child_session_id} on behalf of ` +
          `${input.success.parent_session_id} as wait ${receipt.success.waitId}.`
    return structured(
      {
        wait_id: receipt.success.waitId,
        instance_id: receipt.success.instanceId,
        status: receipt.success.status,
      },
      `${received} This is a fire-and-ack receipt — no blocking wait exists. End your turn ` +
        "now. workflowd will prompt the parent session when the child completes, or mark " +
        "the watch operator_required if the child cannot be observed. Do not poll.",
    )
  })

const dispatchAgent = (args: unknown, context: ToolCallContext) =>
  Effect.gen(function* () {
    if (!context.writesConfigured) {
      return failure(
        "writes are disabled: no WORKFLOWD_MCP_TOKEN or WORKFLOWD_MCP_TOKEN_FILE is " +
          "configured on the server, so dispatch_agent refuses all calls",
      )
    }
    if (!context.writesAuthorized) {
      return failure("unauthorized: dispatch_agent requires a valid bearer token")
    }
    const daemon = context.agentRunDaemon
    if (daemon === undefined) {
      return failure(
        "agent dispatch is not configured on this MCP server: set WORKFLOWD_DAEMON_URL and " +
          "WORKFLOWD_AGENT_RUN_TOKEN (or WORKFLOWD_AGENT_RUN_TOKEN_FILE) on the MCP unit " +
          "so dispatch_agent can reach the workflowd daemon's /workflows/agent-runs ingress",
      )
    }
    const input = yield* decodeArguments(DispatchAgentArguments, args).pipe(Effect.result)
    if (input._tag === "Failure") {
      return failure(
        "invalid arguments: route, repository and prompt must be non-empty strings " +
          `(prompt at most ${MAX_AGENT_RUN_PROMPT_BYTES} UTF-8 bytes), and ` +
          "parent_session_id/resume_prompt/idempotency_key, when given, must be non-empty strings",
      )
    }
    const outcome = yield* postToDaemon(daemon, {
      path: "/workflows/agent-runs",
      subject: "the dispatch",
      timeoutMs: DISPATCH_AGENT_TIMEOUT_MS,
      body: {
        route: input.success.route,
        repository: input.success.repository,
        prompt: input.success.prompt,
        ...(input.success.parent_session_id === undefined
          ? {}
          : { parentSessionId: input.success.parent_session_id }),
        ...(input.success.resume_prompt === undefined
          ? {}
          : { resumePrompt: input.success.resume_prompt }),
        ...(input.success.idempotency_key === undefined
          ? {}
          : { idempotencyKey: input.success.idempotency_key }),
      },
    })
    if ("failure" in outcome) return outcome.failure
    const receipt = yield* decodeArguments(AgentRunReceipt, outcome.payload).pipe(Effect.result)
    if (receipt._tag === "Failure") {
      return failure("the workflowd daemon returned an unrecognized agent-run receipt")
    }
    const verified =
      `session ${receipt.success.nativeSessionId} on route ` +
      `${input.success.route} is generating (${receipt.success.outputTokens} tokens observed)`
    const received =
      receipt.success.status === "duplicate"
        ? `Already dispatched: ${verified}.`
        : `Dispatched and verified: ${verified}.`
    return structured(
      {
        run_id: receipt.success.runId,
        session_id: receipt.success.sessionId,
        native_session_id: receipt.success.nativeSessionId,
        provider_id: receipt.success.providerId,
        model_id: receipt.success.modelId,
        output_tokens: receipt.success.outputTokens,
        status: receipt.success.status,
        wait: receipt.success.wait === undefined ? null : { ...receipt.success.wait },
      },
      `${received} This receipt is first-token-verified; the workflowd watchdog now ` +
        "supervises the run, auto-recovers stalls, and escalates to operator_required. " +
        "End your turn now" +
        (receipt.success.wait === undefined
          ? " and check back later via your own means; no wait was registered."
          : "; workflowd will prompt your session when the child completes.") +
        " Do not poll.",
    )
  })
