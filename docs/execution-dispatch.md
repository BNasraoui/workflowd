# Capability-based local and remote dispatch

Dispatch consumes the [local catalog](execution-capabilities.md).
POST `/workflows/agent-runs` accepts `family`, `model` (an explicit identity),
`intent` (a configured preset), or `route` (a legacy alias). Repository authorization and bearer credentials
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

## Family, version, host and intent

```json
{
  "host": "mint",
  "family": "opus",
  "repository": "workflowd",
  "prompt": "Investigate the intermittent worker crash",
  "idempotencyKey": "worker-crash-attempt-1"
}
```

`family` selects the newest eligible stable numeric release through its native
harness: Claude families use Claude Code; OpenAI sol/luna/terra/astra use Codex.
Recognition uses canonical native IDs, never display-name substring matching.
Custom families use the policy below. Unknown names remain exact-addressable.
An explicit `harness` (`claude`, `codex`, `opencode`) scopes the catalog before
version selection. Native-harness unavailability refuses; there is no implicit
cross-harness fallback. Caller harness does not choose the child harness.

`version` is a numeric family version such as `5.5`, not a native ID; it requires
`family` and pins that release. Numeric ordering puts `6.10` after `6.9`.
Preview/noncanonical IDs are excluded from built-in recognition. Picker-hidden
Codex entries are excluded from automatic latest but retain exact-ID access.
Indistinguishable date/context variants or provider identities refuse as
`ambiguous_family`. Unsupported settings on latest refuse rather than selecting
an older release. `family` and `model` are exclusive; `route` excludes the new
selectors. Intent supplies defaults, with explicit caller settings winning.

All hosts are assumed to have the same harnesses, models and advertised settings.
Family/latest selection uses the common local catalog independently of execution
host; no per-host model inventory or policy opt-in is required. `host` records the
binding execution target, while `catalogHost`, catalog timestamp and adapter protocol
identify the actual observation. Source health remains local observation evidence.
`list_models({host: "other"})` and previews can select for another host without
claiming that its runner is reachable or ready.

**Explicit remote hosts launch through the existing durable runner transport.**
The coordinator's execution-host allow-list and a fresh protocol readiness probe
are checked before accepting a new run. Old/disabled runners refuse explicitly.
Omitted host uses the policy's preferred host or the local catalog host. There is
no local fallback when the named runner is unavailable.
OpenCode, Claude CLI and Codex CLI children support parent wakes through the
existing completion/watch path. Execution host and parent wake host are independent.
Dispatch `run_id` values identify agent-run rows. Authenticated
`job_status({"job_id":"<run_id>"})` returns the run state, frozen selection,
host-local directory/native session, caller mailbox and recorded terminal result.
`GET /workflows/agent-runs/:run_id` returns authenticated run metadata without
the task text. `workflowd job status RUN_ID` uses that endpoint;
`workflowd job cancel RUN_ID` uses the existing authenticated DELETE endpoint.
Caller mailbox reads remain non-consuming and are the terminal-result interface.

### Remote execution setup and recovery

On the coordinator (mint), keep the existing NATS coordinator configuration and
set the execution-host allow-list:

```sh
WORKFLOWD_AGENT_RUN_HOSTS=mint,ben-arch
WORKFLOWD_AGENT_RUN_REPOSITORIES=workflowd=/home/ben/Documents/repos/workflowd
```

Each upgraded runner opts into execution independently using host-local paths:

```sh
WORKFLOWD_REMOTE_HOST_ID=ben-arch
WORKFLOWD_RUNNER_AGENT_REPOSITORIES=workflowd=/home/ben/Documents/repos/workflowd
WORKFLOWD_RUNNER_AGENT_WORKTREE_ROOT=/home/ben/.local/state/workflowd-runner/worktrees
WORKFLOWD_AGENT_RUN_CODEX_BIN=codex
WORKFLOWD_AGENT_RUN_CLAUDE_BIN=claude
# Needed only for OpenCode execution, targeting this runner's local v2 server:
WORKFLOWD_RUNNER_OPENCODE_URL=http://127.0.0.1:4096
WORKFLOWD_OPENCODE_PASSWORD=<host-local-secret>
# Or use WORKFLOWD_OPENCODE_PASSWORD_FILE with a runner-local credential file.
```

Repository names must match the coordinator's logical allow-list; paths need not.
The runner creates the worktree, validates its local provider authentication and
executes the frozen native model/effort/speed through the existing ingress and
durable native process custody. Native CLI logins are local to each host; no
coordinator credentials, repository paths or provisioned worker secrets travel
in the launch payload. Without `WORKFLOWD_RUNNER_AGENT_REPOSITORIES`, probes and
Claude resumes remain enabled but agent execution is not advertised.

Deploy the same reviewed revision and frozen Bun dependencies to coordinator and
runners. Existing `workflowd.v1.commands.<host>` / `workflowd.v1.results` grants and
16 KiB JetStream stream limits are reused; no broker stream migration is required.
Runner units need a functioning user systemd manager, native CLI binaries, writable
runner DB/process-custody/worktree paths, and read access to their repository.
Extend sandbox `ReadWritePaths` for those host-local directories where necessary.
OpenCode runners need a compatible local server and its own provider credentials.
For a minimal smoke after rollout:

```sh
workflowd job ben-arch codex sol --repository workflowd --prompt 'Reply with OK.'
workflowd job status <run_id>
```

A readiness receipt is not launch acceptance. `dispatch_agent` returns dispatched
only after target-runner first-token verification and coordinator custody import.
Launch documents and terminal states use bounded, SHA-256 checked base64 fragments,
including maximum 32 KiB UTF-8 tasks with JSON escaping. Durable inbox/outbox rows
survive reordered/duplicate delivery, partitions and restart. A stable launch claim
is spent before any external action; missing custody after a spent claim reports
`execution_interrupted`/operator-required rather than launching a replacement.
Cancellation is addressed to the selected host, can fence an incomplete transfer
before launch, and confirms native termination through the same owned adapter.
Verification/cancellation timeouts retain the run/mailbox and custody and report
uncertainty. Retry the same run identity rather than launching a replacement.
Pending launches that expire before execution are refused without starting a child.

Terminal answers up to 128 KiB (and within the encoded transfer budget) travel in
fragments; larger answers retain a native-session reference. Parent wake payloads
retain the upstream bounded-message behavior and caller mailbox reference.

### Operator policy

Set `WORKFLOWD_EXECUTION_POLICY_FILE` to a typed JSON file loaded at startup:

```json
{
  "revision": "local-v1",
  "preferredHost": "mint",
  "allowUnknownAccess": true,
  "allowUnconfirmedClaudeThinking": false,
  "intents": [
    { "name": "research", "family": "opus" },
    { "name": "implement", "family": "sol", "thinking": { "effort": "high" } }
  ],
  "families": [
    {
      "name": "custom",
      "harness": "codex",
      "models": [{ "model": "operator-native-id", "version": "1.0" }]
    }
  ]
}
```

The file requires a revision; intent/family names must be unique. Each intent
requires one family or exact model and may set host, harness, version, thinking
and speed. Custom mappings may qualify provider; they never manufacture model
availability. Policy changes require startup reload, while native catalogs refresh
on demand. `allowUnknownAccess` supplies the access opt-in for family/intent calls
only; exact-ID requests retain strict defaults. Explicit false overrides policy.
Known unavailable models always refuse. No built-in intent presets are assumed.

### CLI and preview

Configure `WORKFLOWD_DAEMON_URL` and `WORKFLOWD_AGENT_RUN_TOKEN` or `_TOKEN_FILE`.
Listing/preview may instead use the dedicated execution-capabilities credential.

```sh
bun run cli -- models list --host mint --harness claude
bun run cli -- job mint opus --dry-run
bun run cli -- job mint codex sol --repository workflowd --prompt "Fix the queue bug"
bun run cli -- job mint --intent research --repository workflowd --prompt-file task.txt
```

The installed `workflowd` entrypoint accepts the same arguments. `--thinking`
sets native effort; `--speed`, `--version` and `--idempotency-key` are supported.
Repository and task are required for launch. `--dry-run` calls authenticated
`POST /execution-selections/resolve` with selectors only: no run, worktree or
inference is created. It is an advisory catalog resolution, not a reservation or
execution-readiness check. Another host can be previewed using the common catalog;
launch still checks supported execution transport before acceptance.
All commands print JSON results and return a nonzero exit status on refusal.

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
- Claude discovers concrete native models and effort options through SDK
  `supportedModels()`. Exact-ID and legacy-route thinking remain strict and refuse
  explicit effort because support does not prove effective effort under organization
  caps. Family/intent effort is permitted only with the named
  `allowUnconfirmedClaudeThinking: true` policy; the receipt marks
  `thinkingEvidence: native-unconfirmed`. It passes per-run `--effort` without
  claiming effective effort. Claude documents that caps can silently clamp effort in
  [JSON/stream-JSON output](https://code.claude.com/docs/en/model-config#configure-effort-level).
  Native initialization model evidence can resolve legacy configured aliases.
  A native substitution of an advertised accepted model retains that snapshot,
  records an operator diagnostic, stops the owned execution and refuses with
  `model_not_available`; no replacement is launched. Default thinking remains unknown.

## Speed inputs

`speed` is independent of reasoning effort and must be advertised. Codex catalog
`serviceTiers` maps native `priority` to convenience `fast`; the transient worker
uses `service_tier="fast"`, while resident start/resume uses native `serviceTier`.
`standard` explicitly clears the priority override (`"default"` in CLI config,
null on the resident protocol). Resident responses must confirm requested tier
before a turn; mismatch closes execution and retains existing custody semantics.
Claude fast support comes from `supportsFastMode`; per-run inline `--settings`
sets `fastMode` true/false, so standard overrides inherited fast mode without
changing global configuration. OpenCode speed remains unknown and explicit speed
refuses: a reasoning variant named fast is not service-tier evidence.

Accepted speed is marked `speedEvidence: native-unconfirmed`. This describes the
submitted native setting, not effective priority on every generated request.
Claude fallback and caps are not observable as a guaranteed tier/effort here.

Protocol evidence: installed OpenCode client `0.0.0-beta-18684` Effect declarations
(`Model.Ref.variant`, session create and switch-model), Codex CLI `0.159.1` generated
v2 bindings (`ThreadStartParams.config`, `ThreadResumeParams.config`, native response
`reasoningEffort`, and `TurnStartParams.effort`), and Claude Code `2.1.286` help.
No inference was needed to inspect these inputs. The resident continues to use its
existing durable queue, rather than introducing a second turn-delivery protocol.

## Durable choices and receipts

Receipts include `requestedSelection` and `resolvedSelection`; MCP returns
`requested_selection` and `resolved_selection`. The resolved document separates
host, executor, executor kind, model provider, native model, catalog ID, thinking, speed,
access and evidence (`configured`, `advertised`, or `runtime`). These labels describe
selection evidence; first-token verification does not prove completion or future
account entitlement. Defaults are recorded where advertised; absent defaults remain
unknown. Legacy `providerId` / `modelId` receipt fields retain their routing meanings
for compatibility; the new resolved document is authoritative for model identity.
Family/version, policy revision (when configured), catalog observation host/timestamp
and adapter protocol are saved with the choice. Requested selectors remain
distinct from expanded policy defaults.

Every accepted run has a durable `mailboxId` (`mailbox_id` in MCP). MCP also returns
`mailbox_tool: "read_agent_mailbox"`. Authenticated reads return the terminal message
without consuming it, including run/session identity, model, end status/reason/time,
and final message or session reference. An empty mailbox is not completion evidence.
Matching accepted duplicates reuse the mailbox; post-spawn refusals and their
replays retain its handle. A refusal before run creation has no mailbox.
Parent wakes carry the caller's resume prompt as `task` and the terminal result as
`terminal`; upstream completion supervision retains CLI final messages and SIGTERM
diagnostics. These terminal results do not make `run_id` a legacy job ID.

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
model/provider/effort/speed. Family latest is resolved once per accepted run; a
new logical job identity selects a newly advertised release. A reused idempotency
key with changed host, harness, family, version, intent, model, thinking or speed
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
Parent wakes support OpenCode, Codex CLI and Claude CLI children with verified
parent custody; durable terminal mailbox results survive restart and replay.

## Execution-only daemon

`WORKFLOWD_MODE=execution` explicitly composes native dispatch/discovery and storage,
with no OpenCode, GitHub PR automation, validation or workers. For example:

```sh
WORKFLOWD_MODE=execution
WORKFLOWD_AGENT_RUN_TOKEN=your-daemon-secret
WORKFLOWD_AGENT_RUN_REPOSITORIES=workflowd=/absolute/repository
WORKFLOWD_HOST_ID=your-host
```

Codex and Claude discovery are enabled by default when agent runs are configured.
Each has an independent explicit discovery-disable flag. Codex local authentication
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
Remote launch/cancel reuse the existing runner command plane; service cutover is
an owner-operated deployment step.

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
