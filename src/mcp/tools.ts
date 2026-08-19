import { Effect, Schema } from "effect"
import { RemoteProbeProducer } from "../remote/probe-producer"
import { RemoteHostId } from "../remote/contract"
import { McpQueries, MAX_RECENT_JOBS } from "./queries"

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
  },
  {
    name: "host_health",
    description:
      "Per-host health derived from durable remote dispatch records: last " +
      "runner result time, pending dispatch counts, and consumer liveness " +
      "where it can be derived from the database. Read-only. A host that has " +
      "never received a dispatch will not appear.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
  },
] as const

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

export type ToolCallContext = {
  readonly writesAuthorized: boolean
  readonly writesConfigured: boolean
  readonly now: () => Date
}

const JobStatusArguments = Schema.Struct({ job_id: Schema.NonEmptyString })
const ListRecentJobsArguments = Schema.Struct({
  limit: Schema.optional(Schema.Int.pipe(Schema.between(1, MAX_RECENT_JOBS))),
})
const EnqueueProbeArguments = Schema.Struct({
  host: RemoteHostId,
  probe_id: Schema.optional(
    Schema.NonEmptyString.pipe(
      Schema.maxLength(128),
      Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    ),
  ),
})

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] })
const failure = (value: string): ToolResult => ({
  content: [{ type: "text", text: value }],
  isError: true,
})
const json = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2))

const generatedProbeId = (now: Date) => {
  const stamp = now.toISOString().replace(/[-:.]/g, "").slice(0, 15)
  const suffix = crypto.randomUUID().slice(0, 8)
  return `mcp-${stamp}-${suffix}`
}

const decodeArguments = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknown(schema)(value ?? {}, { onExcessProperty: "error" })

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
        const input = yield* decodeArguments(JobStatusArguments, args).pipe(Effect.either)
        if (input._tag === "Left") return failure("invalid arguments: job_id (string) is required")
        const status = yield* queries
          .jobStatus(input.right.job_id)
          .pipe(Effect.catchAll(() => Effect.succeed(null)))
        return status === null
          ? failure(`no job found with id ${input.right.job_id}`)
          : json(status)
      }
      case "list_recent_jobs": {
        const queries = yield* McpQueries
        const input = yield* decodeArguments(ListRecentJobsArguments, args).pipe(Effect.either)
        if (input._tag === "Left") {
          return failure(`invalid arguments: limit must be an integer 1-${MAX_RECENT_JOBS}`)
        }
        const rows = yield* queries.listRecentJobs(input.right.limit ?? 20)
        return json({ jobs: rows })
      }
      case "host_health": {
        const queries = yield* McpQueries
        const hosts = yield* queries.hostHealth()
        return json({ hosts })
      }
      case "enqueue_probe":
        return yield* enqueueProbe(args, context)
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
    const input = yield* decodeArguments(EnqueueProbeArguments, args).pipe(Effect.either)
    if (input._tag === "Left") {
      return failure(
        "invalid arguments: host must match a workflowd host id and probe_id, when " +
          "given, must start with an alphanumeric and use only [A-Za-z0-9_.-]",
      )
    }
    const now = context.now()
    const probeId = input.right.probe_id ?? generatedProbeId(now)
    const producer = yield* RemoteProbeProducer
    const enqueued = yield* producer
      .enqueue({ probeId, hostId: input.right.host }, now)
      .pipe(Effect.either)
    if (enqueued._tag === "Left") {
      return failure(
        `enqueue failed for probe ${probeId} on host ${input.right.host}: the probe ` +
          "identity may already exist for a different host, or the store rejected the input",
      )
    }
    const received =
      enqueued.right.status === "duplicate"
        ? `Already received: probe ${probeId} was previously accepted as job ${enqueued.right.jobId}.`
        : `Received: probe ${probeId} accepted as durable job ${enqueued.right.jobId} for host ${input.right.host}.`
    return text(
      `${received} This is a fire-and-ack receipt — the job runs asynchronously and ` +
        "no blocking wait exists. End your turn now. Use job_status " +
        `("${enqueued.right.jobId}") in a later turn to read the outcome.`,
    )
  })
