# Pinned native capability adapters (P3)

This source slice adds Codex and isolated OpenCode CLI execution to the existing
`actions-native` repository mode. Access is a configured choice with **unknown
entitlement** until a separately authorized real-provider check. Synthetic clients
and fixture publication do not establish deployed compatibility or quota.

## Supported matrix

| Client | Protocol and credential custody | Explicit supported profile |
| --- | --- | --- |
| Codex `0.159.1` | HTTP Responses; fixed `https://chatgpt.com/backend-api/codex/responses`; canonical ChatGPT access and account header supplied on Mint | `gpt-5.5`; configured subset of `low`, `medium`, `high`, `xhigh` |
| OpenCode CLI `0.0.0-beta-19242` (`opencode2`) | OpenAI Chat; fixed `https://api.openai.com/v1/chat/completions`; separately configured server-held API key | Explicit model IDs and effort subsets; no automatic provider or model fallback |
| Claude Code `2.1.301` | Existing interactive PTY / subscription OAuth | See P2; no print mode or Console fallback |

The application SDK remains separately pinned to `@opencode-ai/client`
`0.0.0-beta-18684`. It is not the OpenCode CLI version. Jobs neither mount Mint's
OpenCode database nor attach to its shared server. Other OpenCode protocols and
providers, including ZAI and Anthropic, are unsupported by this slice. Configuring
an alias cannot change either fixed upstream origin.

Codex uses an explicit custom provider with `requires_openai_auth=true`,
`wire_api="responses"`, and `supports_websockets=false`. The selected profile
executes real `exec_command` tools over HTTP. Newer bundled Code Mode-only models
need additional runtime/tool evidence and are refused by the custodian. There is
no WebSocket or API-billing fallback. Auxiliary model/account/settings/plugin
requests, compaction endpoints, and alternate models are denied. Plugins, apps,
analytics, remote compaction, and request compression are disabled in the isolated
profile. An unsupported auxiliary request can therefore end a long task; it does
not silently widen authority.

The pinned OpenCode CLI accepts `package: "aisdk:@ai-sdk/openai-compatible"`.
It emits Chat Completions and a same-model title request. Both use the selected
model and effort, with the same request budgets and authorization. Current online
documentation uses newer configuration forms; the exact binary's observed form
governs this profile. Public source-tag/provenance lookup did not establish an
exact OpenCode source commit; evidence identifies the registry archive and binary.

## Pins and isolated configuration

`nix/agent-image.nix` fetches immutable, hash-checked public platform archives.
`deploy/sandbox/native-client.py` checks executable SHA-256 before launch:

| Artifact | SHA-256 |
| --- | --- |
| Codex archive | `9d6476abf421afe566c7afade3bb3c4aa1586c6f673c6a9e346b625e6b19561f` |
| Codex executable | `f1cd7fa4ac866c724122f173d408a95385257cbcc9ac5ce5ddba42669c74ba97` |
| OpenCode archive | `72fda4bcc37d1ceb4d743d5d00e793a0b3a9f52452daea41f09fcf49f65d6e94` |
| OpenCode executable | `5e983fb693623f3ea500c63e4da9aa17e90490f120edf612e25c24a34bee405c` |
| Codex `rust-v0.159.1` source archive | `dbc5cad4ea2d7cf52996b05c275313e5f84418b3f3afb6a620aa491eadb6e6a1` |

The image contains no runtime credential/HOME. Each native invocation gets an
isolated configuration, a local sentinel, a loopback URL, clean Git identity, and
only repository tool permissions. Codex's local auth document is a non-authorizing
surrogate, not a copied login. Mint replaces its access/account headers. The local
sentinel cannot select a subject, account, provider origin, or grant.

`WORKFLOWD_CAPABILITY_GATEWAY.native` selects one explicit protocol and models:

```json
{
  "protocol": "codex-chatgpt",
  "models": [{ "id": "gpt-5.5", "efforts": ["high"] }]
}
```

Use `openai-chat` for the OpenCode profile. This augments the existing one-provider
gateway configuration; it does not create a credential registry. The existing
`providerId` names the configured capability route and `credentialRole` selects
the existing noscope provider command. Thinking metadata is **configured**, not
provider-advertised. Explicit model selection still requires acceptance of unknown
access. Repository aliases resolve to `codex:actions` or `opencode:actions` before
dispatch and never use local/shared-server credential preflight as native authority.

## Two independent credential lifecycles

The [credential owner](provider-access-owner.md) supports
`providerAccess.codex.clientId` for canonical ChatGPT auth, or
`providerAccess.opencode.canonical` for an explicit private JSON
`{"apiKey":"...","expiresAt":...}` file. `expiresAt` is Unix milliseconds and
must be an operator-selected real access bound. Expired static keys are refused;
they never trigger OAuth fallback. This path does not read OpenCode's database.

Codex refresh uses fixed `https://auth.openai.com/oauth/token` with verified TLS,
no redirects, ten-second timeout, and a 16-KiB response bound. The pinned public
client ID is `app_EMoamEEZ73f0CkXaXp7hrann`; deployment selects it explicitly.
Optional rotated refresh/ID tokens preserve their previous value when absent.
JWT `exp` supplies a conservative expiry bound on an already custodied credential;
it is not job authentication. Native auth shape, account, and unrelated fields are
preserved. Account/access snapshots remain on Mint, behind the authenticated host
socket and noscope. The existing flock, canonical reread, atomic fsync, cooldown,
and uncertain-rotation fence govern both rotating providers.

The run capability separately retains its 60-minute maximum, 45–55-minute renewal
jitter, absolute job cap, same binding/grants, and stable relay endpoint. Renewal
does not restart a client or replay an initial prompt. Every request checks current
SQL authority; revocation aborts active streams. There is no credential-return
endpoint on the runner gateway and no per-container 30-second lease.

## Lifecycle, results, and evidence

Codex uses `exec --json` / `exec resume`. OpenCode uses
`run --standalone --format json` / `--session`. A host-owned custodian observes the
native-assigned session once, then requires the same session on resume. Native
JSON is endpoint evidence only. The existing supervisor joins the real child,
stops and verifies the whole container, and joins SSH closure before result
freeze/capture/publication. Normal CLI exit waits for controller pause/finish;
native final prose or `finalize` is not completion authority. The OpenCode pin
duplicates text after `--`; the wrapper supplies one positional `Task:`-prefixed
prompt instead. No initial prompt is resent during explicit resume.

The existing corrected-result revision/CAS, source-relative capture, protected
publication, caller mailbox, and ccw.3 managed recipient are reused. Session
endpoints name `github-actions:<run>:<attempt>`, not Mint. The production publisher
remains blocked pending a separately reviewed fixed-v1 pin; the existing
`f74e0505155bc32aa2cedef00ba8b08ef1b90007` remains a legacy contract.

An explicit Actions child endpoint is separate from a parent host. Ordinary
OpenCode parents retain their shared server identity through wait registration
and wake. All native aliases, including Claude, require an available configured
executor before lease acquisition. Thinking restrictions are checked separately.

The custodian observes Linux child exit with `waitid(WNOWAIT)`: its unreaped
leader retains PID/process-group ownership while awaiting controller intent.
Group cleanup precedes the single reap; successful completion also requires
output stream closure. Native session acknowledgement atomically updates both
invocation and lease. Its top-level SQLite reservation is interruptible, while
inherited transactions retain the original rc.112 savepoint wrapper.

Native response metadata is captured before response filtering into two bounded
latest snapshots in the existing private run custody directory:
`provider-response.json` and `provider-error.json` (mode `0600`). The fixed
projection contains protocol, HTTP status, an ASCII request ID of at most 128
characters, and numeric quota fields. Codex retains primary/secondary used-percent,
window-minutes and reset-at; OpenAI Chat retains request/token limit and remaining
counts. Other headers, account/billing labels, malformed or overflowing values,
and known credential/account reflections are excluded. These files are neither
upstream headers returned to agents nor public publication/mailbox data; their
retention follows private run custody. No provider entitlement is inferred.

Run `scripts/check-capability-security.ts --suite adapters --upstream fixture`
with its required private evidence directory **through** the audited isolated
launcher and explicit pinned client mounts. It covers only its named local cases.
Owned image/controller/SSH/container/artifact receipts are separate evidence with
the existing 6-GiB, two-CPU, PID, and wall-clock limits. Private inner Docker uses
`overlay2` for native fixtures to avoid repeated VFS image copies; unsupported
storage fails without host-engine fallback. Cleanup serializes the controller and
reaper for the exact random owner and rechecks inventories under that lock.

Raw output stays bounded and private; public status uses the fixed projection.
Finite synthetic-canary checks do not establish general DLP for intentional public
source/PR content or internet egress. Effective deployed policy, live entitlement,
full CI/per-file complexity, and P4 capacity remain distinct gates. Production
restart/drain versus reviewed same-job reattachment remains Ben's open decision;
this slice does not claim production-scale continuity.
