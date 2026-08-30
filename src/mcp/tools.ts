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

const objectSchema = (properties: Record<string, object>, required: ReadonlyArray<string>) => ({
  type: "object" as const,
  properties,
  required: [...required],
  additionalProperties: false,
})

const readAnnotations = { readOnlyHint: true, openWorldHint: false } as const

const RECEIPT_CONTRACT =
  "This tool returns a receipt, not a result: the work runs asynchronously " +
  "in workflowd's durable job queue. There is no tool that waits or blocks on " +
  "completion — none exists. After receiving the receipt, end your turn. " +
  "If a completion prompt is configured you will be prompted when the job " +
  "finishes; otherwise check job_status in a later turn."

export const TOOL_DEFINITIONS = [
  {
    name: "job_status",
    description:
      "Read the current durable state of one workflowd job by its job id " +
      "(state, attempt counts, schedule, and the recorded result when the job " +
      "has completed). Read-only; safe to call at any time. This reads the " +
      "authoritative SQLite store directly — nothing is cached.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The job id from an enqueue receipt." },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    outputSchema: objectSchema(
      {
        jobId: { type: "string" },
        state: { type: "string" },
        attempt: { type: "integer" },
        maxAttempts: { type: "integer" },
        runAt: { type: "string" },
        result: { type: ["object", "null"] },
      },
      ["jobId", "state", "attempt", "maxAttempts", "runAt", "result"],
    ),
    annotations: readAnnotations,
  },
  {
    name: "list_recent_jobs",
    description:
      "List the most recently updated workflowd jobs (newest first). " +
      `Read-only. Optional limit, 1-${MAX_RECENT_JOBS}, default 20.`,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: MAX_RECENT_JOBS },
      },
      additionalProperties: false,
    },
    outputSchema: objectSchema({ jobs: { type: "array", items: { type: "object" } } }, ["jobs"]),
    annotations: readAnnotations,
  },
  {
    name: "host_health",
    description:
      "Per-host health derived from durable remote dispatch records: last " +
      "runner result time, pending dispatch counts, and consumer liveness " +
      "where it can be derived from the database. Read-only. A host that has " +
      "never received a dispatch will not appear.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: objectSchema({ hosts: { type: "array", items: { type: "object" } } }, ["hosts"]),
    annotations: readAnnotations,
  },
  {
    name: "enqueue_probe",
    description:
      "Enqueue a durable remote probe job for a workflowd runner host. " +
      "Requires bearer-token authorization; without it this tool refuses. " +
      "The ack returns immediately with the job id. " +
      RECEIPT_CONTRACT +
      " Provide probe_id to make the enqueue idempotent (the same probe_id " +
      "always maps to the same job); omit it to get a fresh probe each call.",
    inputSchema: {
      type: "object",
      properties: {
        host: {
          type: "string",
          description: "Runner host id (e.g. 'mint'), as registered with workflowd.",
        },
        probe_id: {
          type: "string",
          description: "Optional stable probe identity for idempotent enqueue.",
        },
      },
      required: ["host"],
      additionalProperties: false,
    },
    outputSchema: objectSchema(
      {
        probe_id: { type: "string" },
        job_id: { type: "string" },
        host: { type: "string" },
        status: { type: "string", enum: ["enqueued", "duplicate"] },
      },
      ["probe_id", "job_id", "host", "status"],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "wait_for_agent",
    description:
      "Register a durable wait so a parent agent session is woken when a child " +
      "agent session finishes. Requires bearer-token authorization; without it " +
      "this tool refuses. Both sessions must already be in workflowd kernel " +
      "custody and in a ready or active state; if either is not, the call is " +
      "refused and names the missing custody. " +
      RECEIPT_CONTRACT +
      " Specifically: the returned wait_id is NOT a result and this tool does " +
      "NOT block. The workflowd resume worker prompts the parent session with " +
      "your resume_prompt when the child completes, or flips the watch to " +
      "operator_required if the child cannot be observed. Do not poll: register " +
      "the wait, then end your turn. Provide idempotency_key to make " +
      "re-registration safe; the same key always maps to the same wait.",
    inputSchema: {
      type: "object",
      properties: {
        parent_session_id: {
          type: "string",
          description: "Kernel custody id of the session to wake when the child finishes.",
        },
        child_session_id: {
          type: "string",
          description: "Kernel custody id of the session to watch for completion.",
        },
        resume_prompt: {
          type: "string",
          description:
            "Text delivered to the parent session on completion. The parent " +
            `receives it as the JSON document {"task":"<resume_prompt>"}; maximum ${MAX_RESUME_PROMPT_BYTES} UTF-8 bytes.`,
        },
        idempotency_key: {
          type: "string",
          description: "Optional stable identity making re-registration a no-op.",
        },
      },
      required: ["parent_session_id", "child_session_id", "resume_prompt"],
      additionalProperties: false,
    },
    outputSchema: objectSchema(
      {
        wait_id: { type: "string" },
        instance_id: { type: "string" },
        status: { type: "string", enum: ["registered", "duplicate"] },
      },
      ["wait_id", "instance_id", "status"],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const

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
    const body = JSON.stringify({
      parentSessionId: input.success.parent_session_id,
      childSessionId: input.success.child_session_id,
      resumePrompt: input.success.resume_prompt,
      ...(input.success.idempotency_key === undefined
        ? {}
        : { idempotencyKey: input.success.idempotency_key }),
    })
    const send = daemon.send ?? ((input: URL, init: RequestInit) => fetch(input, init))
    const response = yield* Effect.tryPromise(() =>
      send(new URL("/workflows/agent-waits", daemon.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${daemon.token}`,
        },
        signal: AbortSignal.timeout(10_000),
        body,
      }),
    ).pipe(Effect.timeout("10 seconds"), Effect.result)
    if (response._tag === "Failure") {
      return failure(
        "could not reach the workflowd daemon to register the wait; the daemon may be " +
          "down or WORKFLOWD_DAEMON_URL may be wrong",
      )
    }
    const payload = yield* Effect.tryPromise(() => response.success.json()).pipe(Effect.result)
    if (payload._tag === "Failure") {
      return failure(
        `the workflowd daemon returned a non-JSON response (HTTP ${response.success.status})`,
      )
    }
    if (!response.success.ok) {
      const refusal = yield* decodeArguments(AgentWaitRefusal, payload.success).pipe(Effect.result)
      const detail =
        refusal._tag === "Success"
          ? (refusal.success.detail ?? refusal.success.reason ?? refusal.success.error)
          : `HTTP ${response.success.status}`
      return failure(
        `the wait was refused: ${detail}`,
        refusal._tag === "Success" ? { ...refusal.success } : undefined,
      )
    }
    const receipt = yield* decodeArguments(AgentWaitReceipt, payload.success).pipe(Effect.result)
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
