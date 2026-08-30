import { MAX_RECENT_JOBS } from "./queries"
import { MAX_RESUME_PROMPT_BYTES } from "../agent-wait-contract"
import { MAX_AGENT_RUN_PROMPT_BYTES } from "../agent-run-contract"

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
  {
    name: "dispatch_agent",
    description:
      "Dispatch a coding-agent run by intent. Pass a configured route name " +
      "(e.g. 'implement', 'review') or a bare model id — never a " +
      "provider-prefixed id; the workflowd runner resolves the route, " +
      "pre-flights that the provider is authenticated and the model exists, " +
      "creates a fresh worktree of the named repository, spawns the session, " +
      "registers it into kernel custody, and only returns a receipt after " +
      "observing the session's first generated token (bounded wait). A dead " +
      "route is refused loudly at dispatch with a machine-readable reason — " +
      "no silent hangs. Requires bearer-token authorization. Optionally pass " +
      "parent_session_id (your own native OpenCode session id) plus " +
      "resume_prompt to also register a durable wait: workflowd prompts your " +
      "session when the child finishes. After the receipt, END YOUR TURN — " +
      "the runner's watchdog supervises progress, auto-recovers stalls, and " +
      "escalates to operator_required; do not poll.",
    inputSchema: {
      type: "object",
      properties: {
        route: {
          type: "string",
          description:
            "Configured route name (intent like 'implement') or bare model id. " +
            "Provider-prefixed ids are refused.",
        },
        repository: {
          type: "string",
          description: "Logical repository name from the server's dispatch allow-list.",
        },
        prompt: {
          type: "string",
          description: `Task for the agent; maximum ${MAX_AGENT_RUN_PROMPT_BYTES} UTF-8 bytes.`,
        },
        parent_session_id: {
          type: "string",
          description: "Optional native OpenCode session id of the caller; requires resume_prompt.",
        },
        resume_prompt: {
          type: "string",
          description: "Optional text delivered to the parent session when the child completes.",
        },
        idempotency_key: {
          type: "string",
          description: "Optional stable identity making re-dispatch safe.",
        },
      },
      required: ["route", "repository", "prompt"],
      additionalProperties: false,
    },
    outputSchema: objectSchema(
      {
        run_id: { type: "string" },
        session_id: { type: "string" },
        native_session_id: { type: "string" },
        provider_id: { type: "string" },
        model_id: { type: "string" },
        output_tokens: { type: "integer" },
        status: { type: "string", enum: ["dispatched", "duplicate"] },
        wait: { type: ["object", "null"] },
      },
      [
        "run_id",
        "session_id",
        "native_session_id",
        "provider_id",
        "model_id",
        "output_tokens",
        "status",
      ],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const
