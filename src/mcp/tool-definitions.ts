import { ThinkingSelection, RequestedSelection, ResolvedSelection } from "../execution-selection"
import { MAX_RECENT_JOBS } from "./queries"
import { MAX_RESUME_PROMPT_BYTES } from "../agent-wait-contract"
import { MAX_AGENT_RUN_PROMPT_BYTES } from "../agent-run-contract"
import { ExecutionCapabilities } from "../execution-capability-contract"
import { toJsonSchemaObject } from "../json"

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

const REFUSAL_CONTRACT =
  "Refusals come back in-band as a structured result with status 'refused', " +
  "a machine-readable reason, and a detail — never as a protocol error."

/**
 * The refused variant every write tool's output schema admits. MCP SDK 1.30
 * clients validate structuredContent against the advertised outputSchema even
 * on isError results, so a refusal payload outside the schema is reported to
 * the agent as a -32602 protocol error that masks the actual reason (this is
 * exactly how an orchestrator once lost a missing_parent_session refusal).
 * Refusals therefore ride this variant instead.
 */
const REFUSED_OUTPUT = {
  type: "object" as const,
  properties: {
    status: { type: "string" as const, enum: ["refused"] },
    reason: { type: "string" as const, description: "Machine-readable refusal reason." },
    detail: { type: "string" as const, description: "Human-readable refusal detail." },
    error: { type: "string" as const, description: "The daemon's refusal category." },
    mailbox_id: {
      type: "string" as const,
      description: "Mailbox for a child that spawned before refusal.",
    },
  },
  required: ["status", "reason"],
  additionalProperties: false,
} as const

type SuccessOutput = ReturnType<typeof objectSchema>

/** Success or refused: the two shapes a write tool's structured output takes. */
const withRefusal = (success: SuccessOutput) => ({ anyOf: [success, REFUSED_OUTPUT] })

export const TOOL_DEFINITIONS = [
  {
    name: "list_execution_capabilities",
    description:
      "List enabled local execution catalogs through authenticated daemon discovery. Identities separate host, executor, provider and native model. Advertised thinking variants, efforts, budgets and defaults are retained. Source timestamps and availability distinguish advertisement from verified access. Refresh is bounded; no route names are needed. Requires the MCP bearer token.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { ...toJsonSchemaObject(ExecutionCapabilities), type: "object" as const },
    annotations: readAnnotations,
  },
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
      "refused and names the missing custody — a session spawned through " +
      "dispatch_agent is always in custody, an arbitrary external session id " +
      "usually is not. " +
      RECEIPT_CONTRACT +
      " " +
      REFUSAL_CONTRACT +
      " Specifically: the returned wait_id is NOT a result and this tool does " +
      "NOT block. OpenCode, Codex CLI, and Claude CLI children are supported. " +
      "The workflowd resume worker prompts the parent session with " +
      "your resume_prompt and, for a dispatched child, its terminal mailbox " +
      "result (run_id, mailbox_id, status, end_reason, and final message or " +
      "session reference) when the child completes, or flips the watch to " +
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
            "Text delivered to the parent session on completion as the task " +
            "field of a JSON document. A dispatched child's terminal result " +
            `is included in its terminal field; maximum ${MAX_RESUME_PROMPT_BYTES} UTF-8 bytes.`,
        },
        idempotency_key: {
          type: "string",
          description: "Optional stable identity making re-registration a no-op.",
        },
      },
      required: ["parent_session_id", "child_session_id", "resume_prompt"],
      additionalProperties: false,
    },
    outputSchema: withRefusal(
      objectSchema(
        {
          wait_id: { type: "string" },
          instance_id: { type: "string" },
          status: { type: "string", enum: ["registered", "duplicate"] },
        },
        ["wait_id", "instance_id", "status"],
      ),
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
      "Dispatch a coding-agent run by intent. This is workflowd's durable " +
      "replacement for hand-rolled ssh/nohup dispatch of coding agents to " +
      "another host: the worktree, kernel custody, first-token verification, " +
      "and watchdog supervision described below are all handled by this one " +
      "call — never shell into a runner host to spawn an agent yourself. " +
      "Explicit selection: pass model, optional provider/executor/model_identity, thinking and allow_unknown_access. Omitted executor uses deterministic capability selection; native and catalog IDs are separate. Resolved selection is returned and preserved for retries. Unsupported thinking is refused. Or use a legacy route. " +
      "Pass a configured route name (e.g. 'implement', 'review') or a bare " +
      "model id — never a provider-prefixed id; the workflowd runner resolves " +
      "the route, pre-flights that the provider is authenticated and the model " +
      "exists, creates a fresh worktree of the named repository, spawns the " +
      "session, registers it into kernel custody, and only returns a receipt " +
      "after observing the session's first generated token (bounded wait). A " +
      "dead route is refused loudly at dispatch with a machine-readable " +
      "reason — no silent hangs. Requires bearer-token authorization. " +
      "Claude CLI and Codex CLI routes launch the respective local CLI directly, " +
      "using its own credentials and model selection; Claude CLI routes never " +
      "use an OpenCode provider. CLI runs have durable process custody and " +
      "inline completion supervision. " +
      "PARENT WAKES: optionally pass parent_session_id plus resume_prompt to " +
      "also register a durable wait, and workflowd prompts your session when " +
      "the child finishes. The parent must be in kernel custody: sessions " +
      "spawned through this tool always are; a foreign session id the kernel " +
      "does not hold is refused with reason missing_parent_session BEFORE " +
      "anything is spawned, so pass your own native OpenCode session id (or a " +
      "Claude Code session UUID with parent_kind 'claude' plus " +
      "parent_directory and optional parent_host on an allow-listed host). " +
      "Every accepted dispatch gets a durable caller mailbox by default, including " +
      "external sessions and every child executor. The receipt gives mailbox_id; " +
      "read_agent_mailbox reads its one terminal result. When you are an external session " +
      "the kernel does not hold, omit parent_session_id; the mailbox still works. " +
      "OpenCode, Claude CLI, and Codex CLI children can all wake a parent. " +
      "The wake JSON contains your resume_prompt as task and the unchanged " +
      "terminal mailbox result as terminal, including run_id, mailbox_id, " +
      "status, end_reason, and final message or session reference. " +
      REFUSAL_CONTRACT +
      " After the receipt, END YOUR TURN — the runner's watchdog supervises " +
      "progress, auto-recovers stalls, and escalates to operator_required; do " +
      "not poll.",
    inputSchema: {
      type: "object",
      properties: {
        route: {
          type: "string",
          description:
            "Configured route name (intent like 'implement') or bare model id. " +
            "Provider-prefixed ids are refused.",
        },
        model: {
          type: "string",
          description: "Explicit native model ID; independent of route aliases.",
        },
        provider: {
          type: ["string", "null"],
          description:
            "Exact model provider identity; null selects an unknown native provider identity.",
        },
        executor: {
          type: "string",
          description: "Optional exact executor identity from list_execution_capabilities.",
        },
        model_identity: {
          type: "string",
          enum: ["native", "catalog"],
          description: "Model namespace; native by default. Catalog selects selectionModel.",
        },
        thinking: toJsonSchemaObject(ThinkingSelection),
        allow_unknown_access: {
          type: "boolean",
          description:
            "Opt into an advertised model whose account access is unknown. Never grants access to an unavailable model.",
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
          description:
            "Optional native session id of the caller (OpenCode session id, or Claude Code " +
            "session UUID with parent_kind 'claude'); requires resume_prompt.",
        },
        parent_kind: {
          type: "string",
          enum: ["opencode", "claude"],
          description:
            "Harness holding the parent session. Default 'opencode'. With 'claude', the " +
            "wake is delivered by resuming the Claude Code session through the claude CLI " +
            "on the daemon host; parent_directory is required.",
        },
        parent_directory: {
          type: "string",
          description:
            "Working directory the Claude parent session was created in (its cwd). " +
            "Required with parent_kind 'claude'.",
        },
        parent_host: {
          type: "string",
          description:
            "Host owning the Claude parent session. Defaults to the daemon host; other " +
            "hosts must be on the server's claude-hosts allow-list, and their wakes are " +
            "delivered by that host's workflowd runner.",
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
      required: ["repository", "prompt"],
      oneOf: [
        { required: ["route"], not: { required: ["model"] } },
        { required: ["model"], not: { required: ["route"] } },
      ],
      additionalProperties: false,
    },
    outputSchema: withRefusal(
      objectSchema(
        {
          run_id: { type: "string" },
          mailbox_id: { type: "string" },
          mailbox_tool: { type: "string", enum: ["read_agent_mailbox"] },
          session_id: { type: "string" },
          native_session_id: { type: "string" },
          provider_id: { type: "string" },
          model_id: { type: "string" },
          requested_selection: {
            anyOf: [toJsonSchemaObject(RequestedSelection), { type: "null" }],
          },
          resolved_selection: { anyOf: [toJsonSchemaObject(ResolvedSelection), { type: "null" }] },
          output_tokens: { type: "integer" },
          status: { type: "string", enum: ["dispatched", "duplicate"] },
          wait: { type: ["object", "null"] },
        },
        [
          "run_id",
          "mailbox_id",
          "mailbox_tool",
          "session_id",
          "native_session_id",
          "provider_id",
          "model_id",
          "output_tokens",
          "status",
        ],
      ),
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "read_agent_mailbox",
    description:
      "Read the durable terminal message for a dispatch_agent caller mailbox. " +
      "Pass the opaque mailbox_id from the dispatch receipt. The result stays available " +
      "across workflowd restarts; reading does not consume it. Requires the MCP bearer token. " +
      "Messages include run and session ids, route and model, terminal status, end reason/time, " +
      "and final message text or a session reference.",
    inputSchema: objectSchema({ mailbox_id: { type: "string" } }, ["mailbox_id"]),
    outputSchema: objectSchema(
      {
        mailbox_id: { type: "string" },
        messages: { type: "array", items: { type: "object" } },
      },
      ["mailbox_id", "messages"],
    ),
    annotations: { ...readAnnotations },
  },
] as const
