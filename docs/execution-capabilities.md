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
