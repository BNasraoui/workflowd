# Capability-based local dispatch

`workflowd-ccw.2` consumes the [local catalog](execution-capabilities.md).
POST `/workflows/agent-runs` accepts exactly one of `route` (a legacy alias)
or `model` (an explicit identity). Repository authorization and bearer credentials
are unchanged. MCP `dispatch_agent` has the same fields, with snake case for
`model_identity`, `allow_unknown_access`, parent fields and idempotency keys.

```json
{
  "model": "native-model-from-the-catalog",
  "provider": "observed-provider",
  "repository": "workflowd",
  "prompt": "Implement the ticket",
  "thinking": { "effort": "xhigh" },
  "allowUnknownAccess": true,
  "idempotencyKey": "ticket-attempt-1"
}
```

`modelIdentity` defaults to `native`, matching `identity.model`. Set it to `catalog`
to match `selectionModel`. These namespaces never implicitly cross-match. `provider`
is optional; an explicit null matches an unknown native provider. `executor` is the
exact advertised identity, such as `codex:local` or `opencode:primary`, rather than
the model provider. A newly advertised model needs no route configuration.

Resolution first filters the requested model/provider/executor, access and thinking
compatibility. Unavailable models are refused. Unknown access requires
`allowUnknownAccess: true`; it does not grant credentials or prove entitlement.
Different compatible provider/native-model identities are ambiguous and require
explicit qualification. For the same identity, available access precedes unknown
access, then executor kinds rank Codex, Claude, OpenCode, then executor and catalog
IDs sort lexically. The order is independent of discovery response ordering.
Failures return bounded reasons including `unknown_model`, `ambiguous_model`,
`executor_unavailable`, `model_access_unknown`, `model_not_available` and
`unsupported_thinking`. No fallback model or lower effort is selected. A CLI-default alias that pins no model
refuses explicit thinking as `unsupported_thinking`; it cannot verify the native
default model in advance.

## Thinking inputs

`thinking` accepts `variant`, `effort` and `budgets` (native parameter/value/unit
records). Strings and numeric budgets retain provider-specific meanings.

- OpenCode v2 applies the exact advertised variant in `Model.Ref` at session
  creation and model switching before prompts. Effort/budget requests must match
  exactly one advertised variant; an explicit variant must also satisfy any supplied
  effort/budget constraints. Arbitrary raw provider overlays are not accepted.
- Codex applies an advertised effort with `model_reasoning_effort` in CLI exec
  config and resident thread start/resume config. The resident queue inherits those
  thread settings for its turns; queue acknowledgements and uncertain delivery
  recovery retain their existing semantics. Native thread responses confirm effort
  before the initial turn; a different or missing requested effort is refused and
  its process is closed. Resume mismatch escalates without another turn. Variants
  and numeric budgets have no verified native Codex input here and are refused.
- Direct Claude model discovery remains unsupported. Explicit model requests cannot
  invent a Claude catalog and are refused; use configured Claude aliases/defaults
  for the existing direct launch path. Explicit thinking requests on aliases are
  also refused: CLI help verifies `--effort` syntax but cannot prove per-model support
  or organization caps. Claude documents that caps can silently clamp effort in
  [JSON/stream-JSON output](https://code.claude.com/docs/en/model-config#configure-effort-level).
  Native initialization model evidence replaces configured aliases in the resolved
  selection when available. Default thinking remains unknown.

Protocol evidence: installed OpenCode client `0.0.0-beta-18684` Effect declarations
(`Model.Ref.variant`, session create and switch-model), Codex CLI `0.159.1` generated
v2 bindings (`ThreadStartParams.config`, `ThreadResumeParams.config`, native response
`reasoningEffort`, and `TurnStartParams.effort`), and Claude Code `2.1.286` help.
No inference was needed to inspect these inputs. The resident continues to use its
existing durable queue, rather than introducing a second turn-delivery protocol.

## Durable choices and receipts

Receipts include `requestedSelection` and `resolvedSelection`; MCP returns
`requested_selection` and `resolved_selection`. The resolved document separates
host, executor, executor kind, model provider, native model, catalog ID, thinking,
access and evidence (`configured`, `advertised`, or `runtime`). These labels describe
selection evidence; first-token verification does not prove completion or future
account entitlement. Defaults are recorded where advertised; absent defaults remain
unknown. Legacy `providerId` / `modelId` receipt fields retain their routing meanings
for compatibility; the new resolved document is authoritative for model identity.

Migration `0024_execution_selection` adds executor kind and requested/resolved JSON
documents to run rows. Old executor markers migrate to kinds; old selection JSON
stays null. It does not invent historical model or thinking evidence. Historical
alias duplicates replay the original persisted provider/catalog model, even if the
alias changes provider, model or executor or the catalog is unavailable. Custodied
host/server identity comes from the original session. Their receipts omit the
unknown requested document and report unknown native OpenCode model/thinking
rather than substituting the current alias. Explicit model/thinking changes conflict.
Runtime recovery, cancellation and watchdog filtering use executor kind; provider
names such as `codex-cli` and `claude-cli` remain valid OpenCode model providers.
Only genuine pre-contract rows use those markers as an executor migration fallback.

Accepted selections are immutable across catalog refresh, duplicate calls,
watchdog retries and native recovery. OpenCode retries/mailbox prompts carry the
saved catalog model and variant; resident Codex resumes carry its saved native
model/provider/effort. A reused idempotency key with changed model or thinking
conflicts before launch. Unkeyed explicit choices have distinct durable identities.
Use an idempotency key when replaying across alias configuration changes. Native
CLI completion, cancellation, leases and process custody retain their existing
semantics; native CLI failures still escalate rather than introducing automatic
CLI turn replay. A launch command error, timeout or subsequent inspection failure
retains the manifest and spawning row, fences duplicate launches and permits restart
reconciliation with the same invocation. An absent unit before invocation adoption
is still uncertain unless a durable terminal record exists; recovery escalates to
`operator_required` while retaining custody, so a late launch can still be cancelled.
First-token refusal records terminal `failed` only after native termination/result
is confirmed. Failed or uncertain cleanup retains `operator_required` custody and
the actual cleanup diagnostic; it never permits another launch of that run.
Explicit native cancellation reports attach/stop uncertainty as typed `run_conflict`
while retaining custody and the current diagnostic, including repeated attempts.
An absent unadopted unit is never declared cancelled solely because it is absent;
a later-visible execution can still be cancelled through the same manifest.
Resident Codex cancellation resolves its durable run/thread ownership before first
output, revokes pending inbox delivery, and awaits the owned app-server's closure.
Closure failure or missing ownership returns typed `run_conflict` with operator
custody and the actual diagnostic. Background operator cleanup follows the same
ownership path. Migration `0025_resident_closure` records confirmed closure; old
rows default to unconfirmed. That proof is cleared before reacquiring an app-server,
so a restart cannot mistake an old close for termination of a new execution.
Unverified old custody without closure proof is retained for operator attention;
recovery does not queue a replacement turn. Fully verified native duplicate receipts
replay the accepted model/thinking without a currently enabled executor. An incomplete
native replay requiring a disabled executor returns `executor_unavailable`.
Parent wakes continue to require an OpenCode child.

## Execution-only daemon

`WORKFLOWD_MODE=execution` explicitly composes native dispatch/discovery and storage,
with no OpenCode, GitHub PR automation, validation or workers. For example:

```sh
WORKFLOWD_MODE=execution
WORKFLOWD_AGENT_RUN_TOKEN=your-daemon-secret
WORKFLOWD_AGENT_RUN_REPOSITORIES=workflowd=/absolute/repository
WORKFLOWD_HOST_ID=your-host
```

Codex is enabled by default when agent runs are configured. Its local authentication
and user-systemd custody requirements still apply to launch. New native launches
refresh current preflight with a five-second bound, so authentication/readiness can
recover or become unavailable without a daemon restart. Already-launched duplicates
replay their accepted choice without requiring current authentication or discovery.
Capability discovery can be separately disabled with its existing Codex flag. No flat aliases, OpenCode
server/password or GitHub App/private key/webhook secret are required. Optional
`WORKFLOWD_AGENT_RUN_CODEX_ROUTES` and `WORKFLOWD_AGENT_RUN_CLAUDE_ROUTES` preserve
configured conveniences. The GitHub webhook route returns 404 in this mode.

The default `automation` mode preserves existing PR policies, credentials, OpenCode
availability validation, CI/resident integrations, QRSPI and workers. Those consumers,
OpenCode routes, parent waits and test-job canaries require automation mode; explicitly
configuring them in execution mode fails instead of acquiring a substitute provider.
This slice introduces no general messaging, remote launch or service cutover.

## Reused Claude implementation

The direct CLI parser, print worker, process driver, shared custody/verification/
recovery/cancellation changes, alias config and fixture coverage were integrated from
the supervisor's captured completed **workflowd-5si** source delta, based on
`670f82458fd86699b17bc4246d431e610ddfcb86`. Snapshot SHA256:
`30e5757641ad62d972da7c2d424a130f2e3f3313fdd968ee183d4bf38ee4c89b`.
Original implementation belongs to workflowd-5si. This branch adapts that code to a
neutral CLI contract and explicit selection/thinking while preserving newer .1
discovery ownership. Deployment source, environment, CI configuration and services
were not modified.
