# Sandbox agent operator gate

Sandbox dispatch stays disabled until the remaining RPI implementation and live
verification finish. Installing this agent does not enable dispatch. The worker
must stop before changing production configuration or restarting its executor.

The reviewed fragment is `deploy/opencode/sandbox.json`. It adds only
`agents.sandbox`. It contains no model, credentials, default agent, global
permissions, MCP servers, or auxiliary-agent overrides. Project configuration
must remain disabled. Each future lease owns a distinct controller location and
one runtime bridge; the wildcard permission alone does not separate leases.
The reserved server namespace is `wfdlease_<digest>` and its permission is
`wfdlease_*`. OpenCode flattens MCP actions as `<server>_<tool>`; using a
`workflowd_` prefix would also authorize global `workflowd.sandbox_*` tools.
Reservation and binding checks reject foreign servers whose normalized names
enter the reserved namespace, including the bare name `wfdlease`.

## Fixture gate

Run on mint, from the reviewed checkout, with the pinned beta-19242 binary on PATH:

```sh
systemd-run --user --wait --pipe --collect \
  -p MemoryMax=6G -p MemorySwapMax=0 \
  --working-directory="$PWD" --setenv="PATH=$PATH" \
  "$(command -v bun)" test test/sandbox/permissions.e2e.test.ts
```

The disposable shared server loads the exact artifact through `OPENCODE_CONFIG`
over its global configuration and uses fake model credentials. Tests execute
ordinary shell controls, force denied native and Code Mode calls, finish
compaction/title/transient-summary turns, and continue the
sandbox afterwards. Two location bridges reach separate SSH/Dagger runners;
foreign calls and calls after removal/restart must fail. The production probe's
own orchestration is also tested against this real executor with scripted model
responses. The global `workflowd.sandbox_probe` canary must be denied in sandbox
sessions while the owned bridge executes and ordinary sessions retain access.
Tests do not change the production server.

If confinement fails, retain its evidence and stop before installation. Do not
restrict ordinary auxiliary agents globally, enable project configuration, or
fall back to private per-run model credentials.

## Install, verify, and rollback (operator only)

The sandbox-only `deploy/opencode/sandbox.json` remains the isolated sandbox
fixture artifact. Production now installs the complete
`deploy/opencode/opencode2.json` overlay, including the same sandbox agent and
hardened reviewer/fixer definitions. Follow [the review isolation migration](review-hardening.md#mint-operator-migration)
for the v2 config root, overlay, drop-in, and post-deploy verification. This
supersedes the earlier sandbox-only installation commands. Do not reinstall that
older overlay or remove the isolation drop-in during sandbox rollback.

Keep sandbox dispatch disabled until its live verification gate passes. The
sandbox fixture and production probe requirements still apply; the
hardening migration does not change the runner workflow pin or grant dispatch.
To roll back a sandbox change, retain the reviewer restrictions and empty MCP
configuration while the operator reviews sandbox custody separately.

## Sandbox verification (operator only)

The production probe reads only the existing server's local HTTP authentication from
its process environment. It uses the selected provider's existing authentication;
it does not load or register model credentials. It creates three disposable
sessions, two location bridges and a local SSH/Dagger fixture, then removes them.
It acquires no GitHub Actions lease. Model refusal to attempt a requested tool is
inconclusive, not a passing confinement result. Native denial is requested through
the advertised `execute` tool: separate `tools.shell`, `tools.read` and `tools.write`
calls must each produce a nested execution error, zero completed native calls and
an untouched host canary. Direct forced native calls remain covered by the fixture.
Each negative prompt asks for one exact call, with failure expected and no search
or retry. Evidence is paginated newest-first, checked for ordering and duplicates,
and bounded by that prompt's message ID; recorded calls are chronological. Missing
boundaries stop verification. Completed nested Code Mode `search` is discovery
only and is permitted, as are calls to the session's own bridge. Any other
completed nested or top-level call fails verification. Discovery cannot replace
the exact-code denial: it must still complete with `metadata.error` and no nested
calls. The fixture includes a denial followed by 22 discovery calls across pages.

Run `scripts/evidence/agent-sandbox.mjs --probe-session-policy` in a capped
unit with `--expected-artifact deploy/opencode/opencode2.json` and the existing
HTTP authentication in its environment. Confirm the selected config root,
project-config disablement and deployed artifact before creating probe sessions.

Review `session-policy.json` and `probe.json` in the printed probe directory. Each
attempt keeps its own evidence, including the earlier inconclusive attempt. The
production probe verifies the loaded rules, distinct locations, ordinary shell
execution before/after, native refusal, successful own-bridge execution, foreign
refusal, completed compaction, import denial after continuation, and owned-resource
cleanup. The fixture provides deterministic adversarial title/summary and restart
coverage; the production probe uses the real selected model and never restarts the
shared executor itself. Resume the implementation worker with the installation
record and probe result. Keep dispatch disabled through phases 4B–4D.

## Cleanup without an observed Actions run

A definitive HTTP 4xx response to the ref-creation POST settles that attempt as
rejected: creation uncertainty clears, the unused lease is released, and dispatch
reports failure. Interruption, timeout, transport loss, and an unconfirmed 5xx
retain uncertainty. Older misclassified records can be reconciled through
`SandboxLease.reconcileRejectedCreation(runId, status)` using the retained POST
rejection receipt. Recovery waits for operation ownership to expire and checks
exact-ref absence and Actions custody; a GET 404 alone is insufficient evidence.
Previously delivered terminal mailboxes remain part of the audit history.

Cancellation or startup failure can leave a persisted intent before Actions
exposes a run. Cleanup inventories the pinned workflow and exact lease branch,
removes the exact ref, confirms its absence with GET 404, and inventories again.
An empty inventory never proves termination: a queued push may appear later.

With no observed run, the lease stays in `operator_required` custody and the
caller receives one durable `operator_required` mailbox after local session
cleanup. Its diagnostic names the repository, exact ref and workflow SHA, and
states whether ref absence was confirmed. This is an uncertainty notification;
it is not a successful or cancelled execution result. Inspect the named Actions
history, restore API visibility if needed, and keep reconciliation running.
Never delete the custody row or invent an Actions run to unblock it. This
conservative outcome also applies to cancellation before ref creation.

Reconciliation continues after mailbox delivery and across coordinator restart.
Any late run is adopted, cancelled and checked directly even if later listings
omit it. Only confirmed termination of every saved run plus exact-ref absence
releases that custody. The original operator mailbox is not replaced or duplicated.

## Runner bootstrap pin (coordinator/operator only)

The runner fetches complete history for the exact requested source SHA. A shallow
checkout fails when container-use pushes it into its internal repository. Both
the startup source helper and the `initialize` operation use the full fetch;
repository validation, the initialization lock, the saved SHA and the five-minute
initialization timeout remain in place.

The initializer regression uses real Docker, Git, SSH and container-use/Dagger.
It first reproduces the shallow failure, then requests an older commit from a
multi-commit origin, checks complete ancestry and runs the fixture's tests in the
created environment. Its private `/run` mount holds only fixture custody. The
test changes neither the host's runner state nor production configuration.

Changes to `deploy/sandbox/runner.sh` require a new workflow pin. After the worker
publishes its bootstrap candidate and exact-head CI passes, review the candidate
and its implementation report. The coordinator/operator must update the sandbox
repository policy's `workflowSha` to that complete reviewed commit SHA,
keeping the repository, App and tailnet trust unchanged, then resume the worker
with the verified pin. Workers do not change the production pin or acquire a live
lease before that confirmation. This bootstrap gate does not complete phase 4D's
remaining security and authenticated live verification; dispatch stays disabled.

## Phase 4D evidence

The coordinator recorded `1dfc34c2742ede3d1499b8bcd303fd487c2a3f7d` as the
operator pin, superseding `737c977da6abb95507bca70f00d746ff505120f2` with identical
sandbox workflow/bootstrap files. App 4337845 creates lease refs at that exact SHA.
It deliberately lacks Workflows permission, so the pin's workflow files must match
an existing branch tip. Any change under `.github/workflows/` or `deploy/sandbox/`
requires publication, passing checks and another coordinator re-pin before
acquisition. Evidence commands use a disposable coordinator database;
production sandbox configuration and the installed agent/drop-in stay unchanged.

Every shipped bridge invocation requires an active binding, including the compiled
entrypoint. Missing bindings fail before SSH starts. The binding filename must be
absolute, normalized and the exact `.sandbox/binding.json` path for its controller
location before it is read. Symlinked binding paths and controller locations are
rejected. The fixture also creates bindings; there is no unbound
production mode. New bridge namespaces use a bounded SHA-256 digest of the lease
ID: full production run IDs exceed the executor's namespace limit and silently
lose their tools despite a connected MCP status. The regression inspects the
model-facing catalog and executes a tool for both short and full lease IDs. The
full lease identity remains in the binding. Revocation terminates in-flight calls
and blocks reconnection.

Set `WORKFLOWD_AGENT_RUN_SANDBOX_REPOSITORIES` to the operator's single-policy JSON
array and `EVIDENCE_TAILSCALE_TRUST_FILE` to the nonsecret operator trust record.
Use separate, private `EVIDENCE_SANDBOX_ROOT` directories for denial and live runs.
Run both commands in a transient user unit with `MemoryMax=6G` and
`MemorySwapMax=0`, as in the fixture gate:

```sh
bun scripts/evidence/agent-sandbox.mjs --probe-denials
bun scripts/evidence/agent-sandbox.mjs --live \
  --model "$SELECTED_MODEL" --executor "$SELECTED_EXECUTOR"
```

The live command additionally accepts `EVIDENCE_OPENCODE_URL` and
`EVIDENCE_OPENCODE_PASSWORD` for the existing normal executor's HTTP endpoint.
The operator may read that HTTP password from the service process without
printing or persisting it. It is not a model credential. The model
is selected by the command, and the server uses its existing provider authentication.
Never copy an AI authentication file or register a real provider credential.

`--probe-denials` requires reachable controls before/after timeout denials from
the real runner and successful replies over controller-initiated SSH. It inventories
readable runner process environments, tooling environment/mounts/git configuration,
known credential paths in runner/root/tooling homes, and setup log credential
patterns. After confirmed release it checks the actual Actions log's GITHUB_TOKEN
permissions and credential patterns. The disposable network fixture additionally
proves that runner root cannot remove the externally installed denial rule.
These inventories have explicit scopes; they are not a claim to detect arbitrary
encoded secrets anywhere on disk. Synthetic controller canaries, hostile callbacks,
metadata, symlinks/hooks and bounded frames are covered by the fixtures.

`--live` dispatches through authenticated MCP and real ingress on a disposable
coordinator using the normal shared executor. It captures all transcript pages,
requires completed remote test-command output, saves the patch as inert bytes, and
checks the durable terminal mailbox after lease release, binding revocation,
bridge removal and session quiescence. Retained sessions stay `sandbox`. A verifier
restart reuses the receipt in the same evidence directory. Parent-wake ordering is
covered by the dispatch fixture. A model's success statement alone cannot pass the
live gate. Leave dispatch disabled if confinement or cleanup cannot be confirmed.

## Native CLI prototypes

The live verifier accepts `opencode:opencode-primary`, `codex:local` and
`claude:local`. Select an accessible model explicitly for each invocation:
OpenCode takes `provider/model`; native CLIs take their native model ID. Use a
separate evidence root for each executor. All commands, including native workers,
run in transient user services capped at 6 GiB with no swap. Existing mint
credentials stay in their existing homes; none are copied into evidence or runners.
Before the Claude live gate, verify actual inference with a trivial `claude --print`
using the selected model. A positive `claude auth status` alone is insufficient.
Expired OAuth requires the operator to run `claude auth login` on mint.

Native sandbox dispatch uses the configured transient CLI even when ordinary
Codex work uses a resident thread. The binding names its durable execution before
MCP startup; normal session custody retains the CLI's native UUID. Each run starts
in an empty controller directory and receives only its owned bridge configuration.
Settlement revokes that binding, stops the owned process group, captures an inert
patch and confirms Actions termination and ref absence before terminal delivery.

Claude 2.1.289 is tested with strict MCP configuration, zero built-in tools and
an exact bridge allow rule. Codex 0.159.1 disables inherited MCP servers, shell,
web search, apps, plugins, subagents, browser/computer/image tools and hooks, with
read-only sandboxing and bridge-scoped approval. Installed-CLI fixtures still
advertise `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`,
`request_user_input`, `get_goal`, `create_goal`, and `update_goal`. These residual
capabilities do not cause dispatch refusal. The fixtures force unsupported native
shell attempts and inspect the actual model-facing catalog. This is a record of
supported restrictions and observed behavior, not a claim that native capabilities
have disappeared completely.

The verifier reads OpenCode's paginated transcript, Codex's durable JSONL MCP
results, or Claude's paired tool-use/tool-result frames. The remote test command
must return three passing tests, zero failures and `workflowd-test-exit=0` from a
successful `&& printf` suffix. Final model prose cannot satisfy this check. Native
completion additionally records the exact systemd unit's inactive state and zero
MainPID. Live runs repeat runner network denials and credential inventory; fixture
success never substitutes for authenticated live evidence.
