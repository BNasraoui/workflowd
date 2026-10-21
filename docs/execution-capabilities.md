# Local execution capability discovery

Bead `workflowd-ccw.1` adds an authenticated catalog independent of dispatch route aliases.
`GET /execution-capabilities` and MCP `list_execution_capabilities({})` return the same
contract. Discovery reads the enabled local adapters; it does not launch inference.

## Identity and metadata

Each capability carries:

- `identity.host`: the daemon's stable `WORKFLOWD_HOST_ID`.
- `identity.executor`: `opencode:<serverId>` or `codex:local`. This identifies the
  executor separately from the model provider.
- `identity.provider`: the adapter's observed provider ID, or `null` when its
  native protocol does not supply one. A null Codex `config.model_provider` stays null.
- `identity.model`: the native model ID. `selectionModel` retains the catalog's
  selection ID separately: OpenCode `id` can differ from `modelID`, and Codex `id`
  can differ from `model`.
- `thinking`: advertised variants, arbitrary effort strings and descriptions,
  numeric token budgets with their native parameter names, and advertised defaults.
  Missing metadata remains absent. `status: unknown` means the adapter has no
  thinking metadata; `unsupported` requires an explicit negative observation.
- Optional tool support, input/output modalities, context/output limits, and
  Responses WebSocket support where the adapter advertises them.
- `observedAt` and `availability`: `available`, `unavailable`, or `unknown`.

OpenCode uses the installed Effect SDK's `model.list`, `provider.list` and
`model.default`. It retains enabled flags, capabilities, variant IDs, safe thinking
settings and the default model. Enabled models on configured, active providers are
`available`; disabled models or models without a configured provider are
`unavailable`. This is execution eligibility based on local observations, not a
guarantee that a subsequent inference will succeed.

The OpenCode variant and model overlays can contain credentials. Discovery projects
only catalog fields and recognized thinking parameters (`reasoningEffort`, `reasoning_effort`,
`reasoning.effort`, `reasoningBudget`, `thinkingBudget`, `thinking.budgetTokens`,
`thinking.budget_tokens`, and `thinkingConfig.thinkingBudget`). It never exports
headers or arbitrary settings/body fields. Unrecognized settings remain unknown.
Defaults are observations from the model catalog, not a universal reasoning enum.
Model defaults and variants merge these projections from `settings` and raw `body`.
Budgets with distinct native parameter names are retained; `body` overrides `settings`
for matching parameters and effort defaults. Within one overlay, `reasoning_effort`
takes precedence over `reasoningEffort`, then `reasoning.effort`.

Codex uses a short-lived owned `app-server --listen stdio://`, initializes JSON-RPC,
then reads `config/read`, `account/read` and all pages of `model/list` (including
hidden models). The native contract was checked using Codex 0.159.1
`app-server generate-ts`. Effort names remain strings; `defaultReasoningEffort`
and `isDefault` are catalog defaults. The process closes after each observation
and is terminated on timeout or disposal of the owning discovery layer. It creates no thread or turn.

Codex model availability is `unknown` even when authenticated: its native catalog
may be bundled or cached and does not prove account access to each model.
[Official Codex documentation describes this distinction](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
An account requiring OpenAI authentication with no account returns an
`unauthenticated` source and no capabilities. An unsupported RPC method or an
incompatible native response returns `unsupported`, without a fallback catalog.

An enabled local Claude resume executor is reported as an `unsupported` source;
this slice has no supported Claude discovery protocol. `workflowd-5si` owns its
direct launch implementation.

## Cross-repository model identity

[`schemas/model-identity.schema.json`](../schemas/model-identity.schema.json) is
workflowd's cross-repo contract for model identity (JSON Schema draft 2020-12).
It is generated from `ModelIdentity`, which derives its five fields from
`ResolvedSelection` in `src/execution-selection.ts`, allowing an unknown executor
for legacy runs. Regenerate it with `bun run schema:model-identity`; verify the
committed bytes with `bun run schema:model-identity:check` (included in
`bun run check` and CI). Tests do not import the generator or run Prettier.

When `kernel_agent_runs.resolved_selection` exists, consumers must parse it and
project only `executor`, `executorKind`, `provider`, `model` and `selectionModel`.
The selection is authoritative, including null fields: **do not read `provider_id`
when a selection exists**, or fall back to `model_id` for a null selection model.
`provider_id` can contain a harness ID such as `codex-cli` or `claude-cli`, rather
than the selection's provider. `model` is the native model ID; `selectionModel` is
the catalog selection ID and can differ. `thinking` is a run setting and `host` is
a placement, so neither is part of the model identity.

### Legacy rows

For a null `resolved_selection`, project the following identity. This rule is
language independent; `modelIdentityFromRun` in `src/execution-selection.ts`
implements it for decoded runs (`executorKind`, `modelId`, `resolvedSelection`).

| Identity field | Legacy source / value |
| --- | --- |
| `executorKind` | `executor_kind` |
| `model` | `model_id` |
| `executor` | `null` (executor instance unknown) |
| `provider` | `null` (provider unknown; ignore `provider_id`) |
| `selectionModel` | `null` (catalog ID unknown; do not copy `model_id`) |

Read-only inspection on 2026-10-21 found 440 legacy rows: 338 Codex, 76 OpenCode
and 26 Claude, dated 2026-08-30 through 2026-10-04. Their harness/provider markers
do not establish a full selection. In particular, selected Codex rows with
`provider_id = "codex-cli"` include both `provider: "openai"` and `provider: null`,
so no unconditional `codex-cli` → `openai` mapping is published. This projection
does not backfill the database or infer historical executor instances.

For example, live legacy run
`agent-run-3f7bfebc20555af3aa67845415c69acdef0cb20597f4f8ab954d0079fc7a7fd3`
has `executor_kind = "codex"`, `provider_id = "codex-cli"`, `model_id = "gpt-6-sol"`
and `resolved_selection = NULL`. Its identity is committed as
[`model-identity.legacy.json`](../schemas/examples/model-identity.legacy.json):

```json
{
  "executor": null,
  "executorKind": "codex",
  "provider": null,
  "model": "gpt-6-sol",
  "selectionModel": null
}
```

### Comparing identities with unknown fields

Compare all five fields, distinguishing three outcomes:

- **Different:** any field has two known, unequal values. Two known providers of
  `glm-5.3-flash` remain distinct even when executor and model match.
- **Same:** every field is known and equal.
- **Indeterminate:** no known values conflict, but at least one field is null on
  either side. A null means unknown, including when both sides are null; it is
  neither a different provider nor proof of equality.

For `codex:local / gpt-6-astra`, inspection found 251 rows with provider `openai`
and four with provider null (explicit null requests, evidence `advertised`). These
are indeterminate relative to each other, not two confirmed providers. Preserve
unknowns in an unresolved accounting bucket; do not count that bucket as a distinct
provider or merge it into a known provider. Unknown compatibility is not an
equivalence relation: it cannot safely drive transitive grouping or deduplication.

### Consuming the schema

Consumers such as the Python trust-graph repo should fetch the committed schema
from a pinned workflowd commit (the same path as its stable `$id`, replacing `main`
with the commit SHA), then validate the projected JSON with a draft 2020-12 validator.
The schema requires all five fields and rejects extra properties. `ModelIdentity`
is the schema source; Effect decoders must use `onExcessProperty: "error"` for the
same strictness. Validation does not establish actual provider access or resolve
unknown IDs. `ResolvedSelection` and its persistence contract remain unchanged.

[`schemas/examples/`](../schemas/examples/) contains one selected identity per
executor kind (`codex`, `opencode`, `claude`) and the legacy example above, copied
on 2026-10-21 from the live database opened read-only. The OpenCode example is the
newest matching `zai-coding-plan / glm-5.3-flash` selection (2026-10-20); Codex and
Claude use their newest matching selections at capture time. Only the five identity
fields were copied or projected. Tests validate the snapshots without DB access.

## Freshness and failure

`sources` identifies each executor, its kind and discovery protocol, source status,
`checkedAt`, last successful `observedAt`, `freshUntil` and `stale`. Source status
`available` means discovery succeeded; model availability is a separate observation.

Reads share an in-flight refresh per source. A fresh observation is reused until
the refresh interval expires. The next read refreshes expired sources concurrently,
so a newly advertised native model appears without a route entry or daemon restart.
This is request-driven refresh, with no background polling or subscription.
The Effect layer owns shared refreshes. Interrupting one reader leaves the refresh
available to other readers; disposing the layer aborts every owned observation and
awaits native teardown, including teardown still running after a read timed out.
A source cannot start another observation while its previous teardown is unfinished.

Each source has a timeout and cancellation signal. Failure is isolated from healthy
sources. Failed refreshes retain the last successful timestamp but omit stale
models. An initial failure has `observedAt: null`. Failures and negative observations
are cached for the same bounded interval to avoid repeatedly starting failed
sources. Protocol error payloads, credentials and account details are not returned.
Codex pagination rejects repeated cursors and stops after at most 101 pages.
Its stdio transport bounds each frame or unterminated line to 2 MB and the total
observation output to 8 MB. OpenCode rejects incompatible SDK responses as
`unsupported` and distinguishes HTTP authentication rejection from server failure.

## Configuration and authorization

| Setting | Default / meaning |
| --- | --- |
| `WORKFLOWD_EXECUTION_CAPABILITIES_TOKEN` or `_TOKEN_FILE` | Dedicated daemon credential; falls back to the configured agent-run token. Set only one dedicated source. |
| `WORKFLOWD_EXECUTION_CAPABILITIES_REFRESH_MS` | 30,000; accepted range 1–300,000 ms. |
| `WORKFLOWD_EXECUTION_CAPABILITIES_TIMEOUT_MS` | 10,000; accepted range 1–30,000 ms per source. |
| `WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED` | True when agent runs or resident Codex is enabled; otherwise false. Explicit true/false overrides discovery composition. |
| `WORKFLOWD_AGENT_RUN_CODEX_BIN` | `codex`; discovery uses the same configured executable. |

OpenCode is required for the default automation consumer and absent in explicit
execution-only mode. See [local dispatch](execution-dispatch.md) for consumer
configuration and deterministic model/thinking selection. Codex uses the resident's configured
home when resident Codex is enabled, otherwise the daemon's inherited Codex home.
Without a discovery credential the HTTP route is unregistered (404). The credential
can enable discovery without configuring agent-run routes or repositories. An
invalid bearer returns 401; a failure of the listing interface returns a redacted
503. Ordinary source failures return a successful listing with explicit source status.

The MCP tool requires `WORKFLOWD_MCP_TOKEN` / `_TOKEN_FILE` authorization. Its unit
also needs `WORKFLOWD_DAEMON_URL` and the dedicated discovery token (or the existing
agent-run token), matching the daemon. MCP proxies the daemon and schema-decodes
the public response; it does not open its own model catalogs. Proxy failures return
an in-band error with no structured success payload. Its deadline is 35 seconds,
above the maximum source timeout. Interrupting the MCP request also aborts its
outgoing discovery fetch.

## Following slices

`workflowd-ccw.2` consumes this normalized contract for explicit executor/model
selection, including the native/selection ID distinction, and applies/persists thinking
settings. [Local dispatch](execution-dispatch.md) documents the interface. `.3` owns
runner registration and remote advertisements. No remote or messaging lifecycle is
introduced by this local read interface.
