# Dynamic agent routing: host, harness, model family, and intent

## Goal and implementation baseline

Let a caller ask for “an Opus agent on mint”, “mint job codex sol”, or “a research agent on mint” without remembering provider IDs, executor IDs, release numbers, native CLI flags, or the caller's own harness. Workflowd owns discovery, defaults, resolution, durable launch, and a receipt explaining the concrete choice.

- Research date: **2026-10-04**.
- Research task: **workflowd-1q8**. Implementation follow-up: **workflowd-7kr**.
- Worktree: `/tmp/opencode/workflowd-dynamic-agent-routing`.
- Branch: `research/dynamic-agent-routing`.
- Baseline: locally available `origin/main`, **f1f4e179c5b3375633c12f96905e899365a1728c**. No remote fetch was performed, so this is not a claim about the latest upstream or deployed revision.
- Relevant history: **eeff0a7**, PR #61, introduced live local execution discovery; **f1f4e17**, PR #62, introduced capability-based dispatch and persisted thinking selection.
- All repository line references below describe this baseline. Future paths are explicitly labeled **proposed**.
- The original checkout was `fix/workflowd-3sj-sse-cleanup` at **a80014d**, considerably older. Its existing `.beads/interactions.jsonl` change was present before this task.
- This worktree pins **Effect 4.0.0-rc.112** and `@opencode-ai/client` beta-18684, not the original checkout's Effect 3 stack (`package.json:32–42`). Implementation must use the checked-out declarations and applicable instructions rather than an outdated stack-specific skill.

Estimated complexity: **high overall**, mostly because cross-host execution and truthful native capability evidence have existing lifecycle requirements. Family selection and compact discovery can ship locally before fleet execution is ready.

### Integration revision

The active integration worktree is `/tmp/opencode/workflowd-dynamic-agent-routing-integration`,
branch `feature/workflowd-7kr-dynamic-agent-routing`, now based on **3a259ee**. The original
`f1f4e17` worktree remains an intact validated backup. Upstream #63/#64/#67 supply
durable caller mailboxes, native-child parent wakes and remote-parent wake simulation.
Family/intent dispatch consumes those paths. Upstream resident credential-rotation
and restart fixes (#66) and RPI skills (#65) are preserved.

The user's updated requirement assumes **every host has the same harnesses, models
and advertised settings**. Selection uses the common/local catalog independently
of execution host. `host` remains the requested binding execution target;
`catalogHost`, source timestamps and protocol retain actual observation provenance.
Another host can be listed, previewed and launched without a remote model
advertisement. Under the user's expanded authority, 7kr implements the narrow
explicit-host launch/cancel/status seam using the existing durable runner transport.
Per-host inventory, generic messaging and automatic balancing are not prerequisites.
The target runner must be configured for execution and answer a fresh protocol probe;
its own repository/workspace policy and credentials are authoritative. Research
findings below describe the original baseline and ownership before that authorization.
Active behavior and rollout requirements are documented in
[execution dispatch](../execution-dispatch.md#remote-execution-setup-and-recovery).

## Research findings

| Finding | Repository evidence | Consequence |
| --- | --- | --- |
| Local discovery is already implemented for OpenCode and Codex. | `src/execution/opencode.ts:10–97`; `src/execution/codex.ts:32–95`; `src/execution-capabilities.ts:43–200` | Extend the delivered catalog rather than build a competing model registry. |
| Host, executor, provider, native model, and catalog selector are separate identities. | `src/execution-capability-contract.ts:29–57`; `src/execution-selection.ts:34–44` | Family names are selectors, not replacement identities. |
| Existing explicit dispatch matches exact native/catalog IDs and validates thinking. | `src/execution-selection.ts:60–99,103–184`; `docs/execution-dispatch.md:21–63` | Preserve the exact-ID interface; add a simpler family/intent interface above the same resolver. |
| Existing same-model executor ranking is availability, then Codex, Claude, OpenCode. | `src/execution-selection.ts:161–168` | New family defaults need model-specific native-harness preference; changing the old exact-ID ordering would be a compatibility change. |
| Discovery is bounded, coalesced, and owns subprocess teardown; failed sources withdraw models. | `src/execution-capabilities.ts:60–114,124–153,192–200` | Claude and remote observations must retain these resource and freshness semantics. |
| Codex advertisement is not entitlement proof. | `src/execution/codex.ts:43–74` | Separate authenticated discovery, model support, and known account access. Avoid requiring agents to reason about this on every dispatch. |
| Claude launch exists, but its discovery source is a placeholder. | `src/execution/local.ts:24–33`; `src/kernel/claude-worker.ts:4–15` | Add native observation independently of the existing launch/custody implementation. |
| Thinking exists; speed, family, release ordering, and child-host selection do not. | `src/execution-selection.ts:14–44`; `src/execution-capability-contract.ts:13–57` | These are the incremental contract changes. |
| Choices are persisted and duplicate requests bypass current catalog resolution. | `src/kernel/agent-run-ingress.ts:553–616`; `src/kernel/agent-run-store.ts:279–318` | Resolve latest once per accepted run; never upgrade a retry or duplicate. |
| Spawn is guarded before external effects. | `src/kernel/agent-run-store.ts:320–331` | Family and remote dispatch must feed the same custody rules. |
| Existing remote commands support probes and Claude parent resumes. | `src/remote/contract.ts:30–80` | `parent_host` cannot stand in for child execution host; generic remote launch is a separate dependency. |
| Parent wakes currently require an OpenCode child. | `docs/execution-dispatch.md:95–126`; `src/mcp/tool-definitions.ts:238–250` | Native-harness defaults need completion/wake integration to provide the desired end-to-end UX. |
| MCP discovery and explicit dispatch already exist in source. | `src/mcp/tool-definitions.ts:55–59,218–337`; `src/mcp/execution-capabilities.ts:8–46` | Add filtered compact discovery; improve the existing dispatch tool instead of adding one launch tool per harness. |
| This session's attached workflowd tools expose the older route-only schema. | Attached tool schema compared with `src/mcp/tool-definitions.ts:264–286` | Source work alone will not improve agents until deployment and client tool-schema refresh occur. |

### Existing work and ownership

The **workflowd-ccw** epic already directs that static routes cease to define the capability universe. It has a separate supervisor and active implementation ownership. Its permission to merge work is not authority for this research session to commit, push, merge, or deploy.

| Bead | Researched state | Reuse in this proposal |
| --- | --- | --- |
| workflowd-ccw.1 | Closed, PR #61 merged | Local discovery and its freshness/teardown contract. |
| workflowd-ccw.2 | Closed, PR #62 merged | Explicit resolution, thinking, custody, and immutable replay. |
| workflowd-ccw.3 | In progress, separately owned worktree | Runner identity, liveness, advertisements, authenticated inventory. |
| workflowd-ccw.4 | Open | Durable generic messaging/lifecycle transport. |
| workflowd-ccw.5 | Open, depends on .4 | Requested-host/automatic remote launch, cancellation, generation fencing, workspace policy. |
| workflowd-ccw.6 | Open | Harness-neutral completion, status, and inventory. |
| workflowd-ccw.7 | Open | Migration, deployment, compatibility, and end-to-end rollout. |

**workflowd-7kr owns family/latest policy, native-harness defaults, Claude discovery, speed projection, compact UX, and the newly authorized explicit-host remote integration.** The narrow .5/.6 seam is recorded in canonical Beads. Broader inventory, generic messaging and automatic-host work remain independently owned; do not edit another worker's worktree.

## Recommended caller experience

### MCP

Keep `dispatch_agent`; expose one compact `list_models` discovery tool backed by the existing catalog. These are proposed calls, not currently deployed tool inputs:

```json
{ "tool": "list_models", "arguments": { "host": "mint", "harness": "claude" } }
```

```json
{
  "tool": "dispatch_agent",
  "arguments": {
    "host": "mint",
    "family": "opus",
    "repository": "workflowd",
    "prompt": "Investigate the intermittent worker crash"
  }
}
```

```json
{
  "tool": "dispatch_agent",
  "arguments": {
    "host": "mint",
    "harness": "claude",
    "family": "opus",
    "version": "5.5",
    "thinking": { "effort": "high" },
    "speed": "fast",
    "repository": "workflowd",
    "prompt": "Fix the bug and verify the fix"
  }
}
```

```json
{
  "tool": "dispatch_agent",
  "arguments": {
    "host": "mint",
    "intent": "research",
    "repository": "workflowd",
    "prompt": "Compare approaches to the queue bug"
  }
}
```

Version omitted means **latest stable supported release of that family in the common harness/provider catalog scope**. Execution host is independent. Listing returns the concrete version, preferred harness, source/freshness, thinking choices, speed choices, access evidence, and available intent defaults. Provider/executor IDs remain available for advanced qualification.

Do not add separate `claude_dispatch`, `codex_dispatch`, and `opencode_dispatch` tools. Filtering `list_models` by harness provides the requested “Claude models list” and “OpenCode models list” without duplicating interfaces.

### CLI

Proposed canonical commands:

```sh
workflowd models list --host mint --harness opencode
workflowd models list --host mint --harness claude
workflowd job mint codex sol --repository workflowd --prompt "Fix the queue bug"
workflowd job mint claude opus --repository workflowd --prompt "Research the failure"
workflowd job mint claude opus --version 5.5 --thinking high --speed fast \
  --repository workflowd --prompt "Fix the failure"
workflowd job mint --intent research --repository workflowd --prompt "Compare approaches"
```

The full command includes a task and repository. An optional operator shell wrapper can expose the user's shorthand **`mint job codex sol`**, forwarding arguments to the canonical command. Do not require one executable per hostname. CLI inference of repository from cwd is permitted only when it matches one authorized logical repository unambiguously.

The current session's harness does not determine the child harness. Parent handoff configuration is independent and should be inferred from verified recipient/session registration supplied by .3/.6 when available.

## Design: one deep selection module

Place the seam at the existing execution-selection module. Internally compose discovery adapters, family classification, policy/defaults, release ordering, and native translation. Callers learn selectors and receipts rather than every adapter's rules.

### Request and result

Add optional request fields: `host`, `harness`, `family`, `version`, `intent`, and `speed`.

- A legacy `route` is exclusive with the new family/model/intent selection forms.
- `model` and `family` are exclusive. `version` is valid only with `family`.
- `intent` may be used alone to supply defaults or alongside explicit family/model/settings overrides.
- Existing `provider`, `executor`, `modelIdentity`, and thinking fields remain advanced exact qualifiers. Conflicting harness/executor/host qualifiers refuse rather than override one another.
- No model/family is required when a valid intent supplies one; no intent or target means `invalid_selection`.
- Keep requested input distinct from expanded defaults and resolved identity.

An accepted selection includes exact execution host, catalog observation host, executor, harness kind, provider, native model, catalog selection ID, resolved thinking/speed, family/version evidence, policy revision, and catalog observation identity. Store native translated settings or an adapter-contract revision sufficient to replay them exactly. Do not persist credentials or arbitrary raw provider settings.

Runtime observations are separate evidence: which model/settings were actually reported, whether each setting was applied/observed/unconfirmed, and any native fallback. A runtime discrepancy must not rewrite what the caller requested or what workflowd accepted.

### Family and latest resolution

1. Read an existing run by idempotency identity first. A matching duplicate returns the accepted selection without consulting new defaults/catalogs; changed request fields conflict.
2. Expand a versioned intent and operator defaults. Explicit fields win over preset defaults; authorization/workspace constraints always apply.
3. Scope the common catalog by provider and harness/executor. Requested host is a separate binding execution target; no per-host model advertisement is required. Omitted host uses configured preferred-host policy or the daemon host; automatic live-host selection remains owned by .5.
4. Prefer the family's native harness: Claude families through Claude Code; supported OpenAI families through Codex. Other families use observed capabilities or configured preferred harnesses. This is independent of the parent harness.
5. An explicitly selected harness is binding. Automatic cross-harness fallback happens only when an operator/intent policy explicitly permits it; the receipt explains it. Do not silently move a named host's job elsewhere.
6. Classify family/version from structured native metadata where available; otherwise use bounded provider-specific canonical-ID rules or explicit operator mappings. Never fuzzy-match arbitrary names containing `opus`/`sol`.
7. Select the newest eligible stable release within that family/scope. Hide retired, unavailable, and picker-hidden models from automatic latest selection when the native catalog advertises those states. Preserve exact-ID access to advertised hidden entries under existing policy.
8. Prefer trustworthy release metadata; use vendor-specific numeric version/date rules when unambiguous. Compare numeric components, not lexical strings: `6.10` must sort after `6.9`. Never compare releases across unrelated families/providers.
9. Native aliases that resolve to a concrete ID are useful evidence, but may be operator-pinned or older than the latest catalog release. Label these facts separately; “recommended/default” is not synonymous with “latest”.
10. Unknown release ordering or multiple indistinguishable candidates produces an actionable refusal; explicit IDs remain usable. Unknown families remain visible in discovery even when no automatic family resolver exists.
11. Resolve an explicit version only within its family. Never replace an unavailable `opus@5.5` with another release. Date/context variants require explicit qualification if metadata does not establish a canonical selection.
12. Validate requested thinking/speed on the chosen release. Do not silently choose an older version because the latest lacks a requested setting.
13. Verify supported execution transport, then persist the accepted concrete choice before external launch. A future target runner validates that exact choice and its execution readiness, not the meaning of `latest`. A stale race refuses without downgrading or re-resolving a launched run.

Built-in family recognition can cover the user's named families **when the actual native catalog confirms canonical IDs**. Do not hard-code their current release numbers. A typed, versioned JSON policy file (proposed environment pointer `WORKFLOWD_EXECUTION_POLICY_FILE`) provides custom family aliases, preferred harness/host, intent defaults, preview policy, and ambiguous release mappings. It is not an availability list: a mapped model must still pass live discovery. Initial config loads at startup; native catalog refresh does not require a restart. Live policy reload is optional follow-up work, not necessary for dynamic release discovery.

For low-friction Codex calls, allow an operator-configured authenticated-advertisement access policy for high-level selectors to supply the existing unknown-access opt-in. Preserve existing exact-ID request semantics and truthfully report unknown entitlement. This is configuration once, not a repeated question to the agent; known-unavailable models still refuse.

### Thinking and speed

- Retain native effort strings, variants, and budget parameters. No global effort enum or normalization that changes their meaning.
- Add speed metadata with `advertised`, `unsupported`, or `unknown` status and native tier IDs/translation evidence. Convenience `standard`/`fast` values work only through verified adapter mappings; preserve additional advertised tiers.
- A low-reasoning variant named `fast` is not proof of a priority/fast service tier.
- Validate combinations, not just independent flags: the OpenCode variant must satisfy both selected thinking and speed settings without one overlay overwriting the other.
- Omitted settings use documented policy/native defaults and record what is known. `speed: standard` must override a host's inherited fast setting when the adapter supports doing so.
- Codex: extend transient worker and resident thread/turn settings together; evaluate native `service_tier` and fast-mode configuration against the installed generated contract.
- Claude: discover effort/fast support, pass `--effort` and per-run inline `--settings` as supported. Do not change global Claude settings to run one job. Avoid model switches caused by enabling fast mode on an unsupported model.
- Claude documents effort clamping and speed fallback. Preserve the current exact-thinking refusal until the adapter can substantiate application under its policy. If the product permits supported-but-unconfirmed native settings, make that a named operator policy and mark the receipt unconfirmed; never weaken the existing strict interface silently. Known clamping/model substitution yields a typed mismatch and retains any acquired custody.
- Observe fallback notifications where provided. Neither first output nor a model-support flag proves the effective speed of every request during a long run.

### Discovery and wire compatibility

Extend normalized capability metadata with family/release provenance, native alias resolution, picker eligibility, and speed options, only when observed. Native catalogs and configured assertions have separate provenance.

`list_models({host?, harness?, family?})` returns a compact default view plus concrete selectors, supported options, intent summaries and source status. `list_execution_capabilities` remains the detailed compatible view. CLI and MCP use the same daemon resolver and catalogs.

Catalog sources retain **observation host + executor** identity and truthful health. Under the uniform-catalog assumption, requested-host listing projects an execution target while retaining the original observation host; it does not fabricate remote advertisements. Preserve source health even when model filters produce no models.

Remote capability advertisements and generic launch envelopes have a deployed **16 KiB** transport limit (`src/remote/contract.ts:3–10`). Do not embed an unbounded catalog or the 32 KiB dispatch prompt in one message. Reuse the bounded/paged or durable-payload-reference protocol chosen by .3/.4/.5. Old runners must explicitly report unsupported selectors/settings/protocols.

## Upstream evidence and implementation gates

Sources were retrieved during research on 2026-10-04. Their examples describe public documentation, not confirmed availability on mint or another host.

### OpenCode V2

- [Models](https://opencode.ai/v2/docs/models/): project-scoped catalog from provider integrations, models.dev, and configuration; catalog aliases have a separate native `modelID`; variants are provider-specific.
- [API](https://opencode.ai/v2/docs/api/) and [OpenAPI](https://opencode.ai/v2/openapi.json): native model/provider/default discovery. Check the installed pinned client's declarations before changing request fields; published and pinned prerelease contracts can differ.
- Automatic latest selection must use the target repository/location's enabled provider configuration, not assume global credentials or a catalog observed for another project.

### Claude Code

- [Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript#query-object): `Query.supportedModels()` and `initializationResult()`.
- [ModelInfo](https://platform.claude.com/docs/en/agent-sdk/typescript#modelinfo): `value`, optional `resolvedModel`, effort levels, adaptive thinking, and fast-mode support. Missing metadata remains unknown.
- [Model configuration](https://code.claude.com/docs/en/model-config): native family aliases already update, but resolution varies by provider, CLI version, operator overrides, and policy. Full IDs pin versions. Effort/model settings may be clamped/substituted.
- [Fast mode](https://code.claude.com/docs/en/fast-mode): independent of effort, per-run `--settings` support, model-switch/fallback behavior.

**Important discovery spike:** `startup()` returns a `WarmQuery` whose public interface has only `query()`/`close()`, not `supportedModels()`. Do not assume `startup().supportedModels()` works. Verify a supported `Query` initialization with blocked streaming input or another documented observation seam, without sending a user prompt or generating output. Confirm close/abort/reaping, project hooks/MCP startup effects, model refresh, and binary/SDK version compatibility. Use the configured host Claude binary via `pathToClaudeCodeExecutable`, rather than silently discovering with a different SDK-bundled binary. If no supported no-inference observation path works, keep discovery explicitly unsupported and record the blocker.

### Codex

- [App-server](https://developers.openai.com/codex/app-server.md): `model/list`, efforts/defaults, optional upgrade metadata, and installed-version schema generation.
- [CLI reference](https://developers.openai.com/codex/cli/reference.md): evaluate `codex debug models` on versions supporting it; bundled catalogs are not account access checks.
- [Speed](https://developers.openai.com/codex/agent-configuration/speed.md): speed is a separate catalog-dependent tier, not lower reasoning effort.
- [Configuration reference](https://developers.openai.com/codex/config-file/config-reference.md): native reasoning and service-tier configuration.

**Speed spike:** inspect installed generated/raw catalog types for tier support and provider capability bounds. The current workflowd projection drops fields beyond its selected schema (`src/execution/codex.ts:8–23`); public prose alone is insufficient to invent a tier-advertisement shape. Keep unknown speed explicitly unknown when the installed CLI provides no reliable observation.

## Implementation phases

### Phase 1 — Pin contracts and validate native observation seams

Changes:

- Confirm available runner/transport interfaces before planning remote launch integration; common-catalog routing has no per-host model-inventory prerequisite.
- Capture redacted native contract fixtures for OpenCode, Claude initialization, and Codex catalog/settings using installed versions. Validate per-repository discovery context.
- Establish the no-inference Claude discovery path and speed-setting evidence described above.
- Record agreed latest-stable, native-harness, unknown-access, and intent policy semantics in repository design documentation.

Automated verification: contract fixture decoding, no prompt/turn messages emitted during observation, abort/timeout and process-reaping tests through the discovery interface.

Manual verification: inspect the actual host/harness versions and project-scoped lists; compare Claude native picker/SDK evidence and Codex app-server metadata. No job launch is required for discovery verification.

Success: every advertised new field has provenance; unsupported installed features are explicit; adapters observe the same binaries/configuration that execution will use.

### Phase 2 — Extend model metadata, Claude discovery, and typed policy

Changes:

- Extend `src/execution-capability-contract.ts`, `src/execution-capabilities.ts`, native projections, and `src/execution/config.ts`.
- Implement Claude discovery in **proposed** `src/execution/claude.ts`, then compose it in `src/execution/local.ts` without requiring static Claude routes.
- Preserve native aliases versus resolved IDs; require concrete resolution for a family request that promises an immutable pinned release.
- Add typed family/intent/default policy loading in **proposed** `src/execution/policy.ts`; integrate at `src/config.ts`/`src/layers.ts`.
- Keep provider-specific classifiers internal to the selection module; expose only normalized observations and provenance.

Automated verification: add Claude fixtures, version/provider differences, optional fields, malformed responses, duplicate alias detection, unavailable authentication, changing alias target after refresh, source coalescing, bounded teardown, and configuration validation.

Manual verification: changing a native advertised version updates the normalized catalog without editing a route; custom mappings do not create phantom availability.

Success: all three supported harnesses provide truthful catalogs or explicit unsupported status; speed/family evidence is not fabricated.

### Phase 3 — Resolve family/latest/intent and persist accepted choices

Changes:

- Extend `src/execution-selection.ts`, `src/agent-run-contract.ts`, and `src/kernel/agent-run-ingress.ts` with selector validation and policy expansion.
- Add native-first resolution for new high-level selectors while preserving existing explicit-ID behavior.
- Extend requested/resolved stored documents in `src/kernel/agent-run-store.ts`; keep old rows readable with optional/versioned extensions. Add a numbered migration only if storage/query needs require it, after checking the then-current last migration.
- Include host/harness/family/version/intent/speed and caller-explicit access choices in request hashing/conflict checks. Store policy revision and expanded selection separately so policy changes do not invalidate identical replay.
- Make new-run identity distinguishable from retry. Reusing an idempotency key means the same run; callers wanting the next latest release use a new logical job identity.
- Emit bounded actionable refusals such as unknown/ambiguous family, unavailable host/harness, unsupported version/speed, unresolved alias, and selection mismatch.

Automated verification: behavior tests for numeric release ordering, stable/preview boundaries, custom families, alias collisions, provider ambiguity, native preference despite unknown-access advertisements, explicit OpenCode override, version pins, incompatible thinking/speed, changed-key conflicts, catalog/policy changes after acceptance, and historical replay.

Manual verification: run resolver previews for “opus on mint”, “sol through OpenCode”, exact version, and research intent; inspect the reason and concrete target.

Success: one selector resolves deterministically or refuses usefully; duplicates and recovery never resolve latest again.

### Phase 4 — Apply and observe thinking/speed through native execution

Changes:

- Carry accepted settings through `src/kernel/agent-run-cli.ts`, `src/kernel/codex-worker.ts`, `src/kernel/claude-worker.ts`, and the shared CLI process contract.
- Extend `src/resident/service.ts` and `src/resident/opencode-delivery.ts` so transient dispatch and resident turns share setting semantics.
- Apply verified Codex tier configuration and Claude per-run settings. Keep prompt transport as data/stdin.
- Preserve combined OpenCode variant selection across create, prompt, mailbox delivery, retry, and watchdog paths.
- Store reported effective selection separately; mismatch/uncertainty uses the existing cancellation/reconciliation custody rules. No replacement launch follows an uncertain native effect.

Automated verification: argv/settings recorder tests, thread/turn config fixtures, inherited-fast override, combined variant constraints, known clamping/model switch, fallback notifications, missing runtime evidence, cancellation, restart, and accepted settings replay.

Manual verification: small real jobs on each supported harness confirm actual model and settings when observable; verify unsupported controls refuse with a useful diagnosis.

Success: supported controls are actually forwarded, recorded, and retained; receipts distinguish submission/application/observation from guarantees the native harness does not provide.

### Phase 5 — Compact discovery, dispatch MCP, and CLI

Changes:

- Add `list_models` filters and compact output through `src/mcp/tool-definitions.ts`, `src/mcp/tools.ts`, and the daemon discovery surface in `src/http.ts`.
- Extend `dispatch_agent` inputs/output with high-level selectors and concise guidance: normal calls need a task, repository, and family or intent; host/harness/settings are optional selectors.
- Ensure typed refusals satisfy the advertised MCP output schema; keep the existing detailed discovery and legacy route inputs compatible.
- Add **proposed** `src/cli.ts` and a package entrypoint for models/job commands, using injectable argument parsing and the authenticated daemon client. An optional `--dry-run` uses a read-only resolve endpoint (proposed `POST /execution-selections/resolve`) with no run/worktree creation.
- Preview includes catalog/policy revisions and is advisory: dispatch validates a current choice, then freezes it at acceptance. A preview is not a reservation.
- List intent defaults alongside relevant model discovery so “research agent” needs no remembered route/model choice. Do not put a second language model inside workflowd to interpret free-form tasks; the caller chooses a named intent from its natural-language inference.
- Update `docs/execution-capabilities.md`, `docs/execution-dispatch.md`, `docs/mcp-server.md`, `README.md`, and deployment examples.

Automated verification: real MCP SDK schema validation, authorization/redaction, snake/camel field translation, filtered source status, CLI parser and client fixtures, JSON output, explicit conflicts, and zero side effects for preview. Do not test new commands by unintentionally launching real agents.

Manual verification: use Claude/OpenCode/Codex callers to list and dispatch a family and an intent without supplying executor/provider IDs or reasoning about their own harness.

Success: all caller surfaces use the same resolver and receipt; normal spawn tasks fit a small tool call, and advanced exact selectors still work.

### Phase 6 — Implement explicit-host launch and completion integration

Revised authority: implement the narrow explicit-host .5/.6 seam within 7kr now.
Reuse the existing remote command plane and landed mailbox/native-child custody.
Broader fleet inventory and generic messaging are not prerequisites.

Changes:

- Negotiate execution protocol readiness using the existing probe. Reuse the common catalog for model resolution.
- Carry the frozen concrete choice through versioned bounded execution fragments on the existing NATS command plane.
- Target runner resolves its authorized repository/workspace, validates exact settings, and executes with its own credentials. Do not copy another host's credentials or local filesystem paths.
- Preserve acceptance/first-output/completion distinctions. Add authenticated agent-run lookup to the existing status surface.
- Reuse landed caller mailboxes and completion/parent wakes. Keep execution-host routing independent of the parent wake destination.
- Preserve the 16 KiB envelope budget; durably fragment 32 KiB tasks and bounded terminal messages. Refuse old/disabled runners before accepting new remote runs.

Automated verification: substantive two-host store/transport tests covering runner expiry, common-catalog freshness, exact execution target, catalog changes after acceptance, duplicate deliveries, partitions, coordinator/runner restart, fencing/cancellation, old-runner refusal, and one resulting native launch. Validate parent wake across supported harness pairings.

Manual verification: “mint job claude opus” and “mint job codex sol” execute on mint with its native credentials; named-host unavailability refuses rather than moving the job; completion returns to a differently hosted/harnessed parent when supported.

Success: fleet selection is discoverable and deterministic; exact accepted settings survive transport/recovery; execution host and wake destination are independently correct.

### Phase 7 — Compatibility, rollout, and end-to-end acceptance

Changes:

- Keep existing routes as optional aliases; migrate examples from fixed release IDs to family/intent selectors once relevant adapters are validated.
- Integrate deployment order and compatibility with .7: storage/contracts first, compatible runners and discovery next, daemon/MCP next, then refresh client tool schemas.
- Verify the live installed tool definitions expose the new selector/listing fields; this session's current route-only schema demonstrates why that check matters.
- Document rollback to compatible binaries and selectors without deleting custody, selections, native sessions, or new stored fields. In-flight runs keep their accepted identities.

Automated verification: legacy route/request/receipt fixtures, historical stored selections, old-runner boundaries, complete checks below, and end-to-end native/fleet simulations.

Manual verification: new release becomes the target of the next new family-based job without a route edit; replay of an older job stays pinned; exact version stays pinned; caller can choose supported thinking/speed; agent can infer an intent with one dispatch call.

Success: discover/list/dispatch/complete works with deployed schemas, existing consumers remain compatible, and rollback does not abandon managed work.

## Verification commands

There is **no Makefile** at the researched baseline. Use the repository's actual Bun scripts (`package.json:6–30`), not invented make targets. Run targeted suites as their phases change, then the required full gate once the implementation is integrated.

```sh
bun test test/execution-capabilities.test.ts test/execution-selection.test.ts test/execution/
bun test test/kernel/capability-dispatch.test.ts \
  test/kernel/execution-selection-migration.test.ts \
  test/kernel/replay-executor-availability.test.ts \
  test/kernel/codex-thinking.test.ts
bun test test/mcp/
bun test test/remote/
bun run simulate:remote
bun run check
bun run audit
git diff --check
```

After commits exist and coverage has been generated, apply the CI changed-line gate with actual base/head commits:

```sh
bun run coverage:changed "$BASE_SHA" "$HEAD_SHA"
```

New behavioral suites should live beside existing selection/discovery/CLI tests, rather than mirror internal helpers. The important invariants are exact selection, useful defaults, honest observations, immutable replay, and one controlled launch under duplicate/restart/partition conditions. Remote integration suites may start Docker/NATS; run them in the normal test environment.

For this research deliverable, verify Markdown formatting, existing source-reference paths/line bounds, phase structure, dependency ownership, and git diff whitespace. Runtime tests are not a research-plan validation requirement.

## Defaults and decisions to carry into implementation

Recommended defaults, so callers need fewer choices:

- Latest stable in family, native harness first, no implicit migration away from a requested host/harness.
- Omitted thinking/speed keeps policy/native defaults; explicitly requested unsupported settings refuse.
- Exact version/native ID is a pin, not a suggestion.
- Intent presets are versioned operator policy, discoverable from compact listing, with explicit caller overrides.
- Normal calls use configured authenticated-advertisement access policy; detailed evidence still says when entitlement is unknown.
- Native IDs with unknown families remain usable, and custom families do not require source code changes.
- Caller harness never determines child harness; parent wake uses verified registration.

Claude's no-inference observation and installed Codex tier metadata have been validated locally. Explicit-host runner launch/cancellation, run lookup and terminal parent wakes are now integrated and validated using isolated native fixtures and JetStream. Remaining owner-operated rollout includes deploying reviewed binaries/configuration and refreshing caller tool schemas, then a minimal live cross-host smoke. Per-host model observations are not a prerequisite under the uniform-catalog requirement.

## Handoff and OpenCode workflow

This file is a design/implementation specification; Beads remains the task tracker. Keep work and discoveries on workflowd-7kr and reference the existing dependency tickets. Research task workflowd-1q8 can close once this deliverable is validated.

Use this worktree for follow-on implementation, refreshing its baseline only after checking for active local changes and relevant merged prerequisite work. Separate implementation phases with reviewed diffs and meaningful gates. OpenCode session history and available undo/redo support aid local iteration, but do not reverse database migrations, accepted jobs, or external agent execution; use git diffs and durable custody for those effects. No commit, push, merge, live dispatch, or deployment was performed as part of this research.
