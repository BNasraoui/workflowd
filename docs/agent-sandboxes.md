# Sandbox agent operator gate

Sandbox dispatch stays disabled until the remaining RPI implementation and live
verification finish. Installing this agent does not enable dispatch. The worker
must stop before changing production configuration or restarting its executor.

For relocated native clients, see the [P3 capability adapter matrix](capability-gateway-p3.md)
for exact Codex/OpenCode pins, fixed upstreams, isolated credentials, and evidence
limits. Those clients use the existing Actions-native gateway/supervisor/result
path, with no shared OpenCode server or credential-database mount.

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

`deploy/opencode/sandbox.json` remains the sandbox overlay for the shared
agent-run server and disposable sandbox fixtures. Preserve that server's global
agents, plugins and providers. PR review now uses a separate
`opencode2-reviewer.service` on port 4098 and the complete
`deploy/opencode/opencode2.json` overlay in its own config root; follow
[the review isolation migration](review-hardening.md#mint-operator-migration).
Do not apply the reviewer unit's config isolation to the shared sandbox/agent-run
server. The complete overlay includes the sandbox policy for compatibility but
does not move sandbox dispatch to the reviewer server.

Keep sandbox dispatch disabled until its live verification gate passes. Sandbox
rollback changes only the shared server's sandbox overlay, preserving the
dedicated reviewer unit and restrictions.

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
unit with `--expected-artifact deploy/opencode/sandbox.json` and the existing
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

## Interactive Actions implementation gate (local only)

The capability-gateway slice pins the official Linux x64 Claude Code **2.1.301**
executable, SHA-256
`bc1aad9982c7b59c7d889ff92595d61cf46e0a6eae074cb551d932a989bcd222`.
The hash matches Anthropic's versioned release manifest. This is the version
specified by the approved v2 plan. The image source and CI install now use this
same hash-verified binary. The full CI launch graph still contains legacy Claude
workers and must be migrated before execution under this gate.

Run the offline feasibility fixture with an explicit executable path:

```sh
WORKFLOWD_FIXTURE_CLAUDE=/absolute/path/to/verified/claude \
  python3 scripts/evidence/isolated-fixture.py \
  bun scripts/check-capability-security.ts --suite native-local \
    --upstream fixture --evidence /tmp/opencode/evidence/native-local
```

The launcher discovers `bun`, `node` and `noscope` on PATH, or accepts explicit
`WORKFLOWD_FIXTURE_BUN`, `WORKFLOWD_FIXTURE_NODE` and `WORKFLOWD_FIXTURE_NOSCOPE`
paths. It binds individual executables at private fixture paths, hides real homes,
runtime sockets and temporary files, denies external networking, and bounds its
unique user unit to 180 seconds, 6 GiB RAM and no swap. Linux bubblewrap, user
namespaces and a user systemd manager are prerequisites; there is no unisolated
fallback. Evidence is owner-only under `/tmp/opencode/wfd-isolated-*` (override
the parent with `WORKFLOWD_FIXTURE_EVIDENCE`). Bun's resource preload is retained.

The actual interactive PTY exercises file tool turns, an explicitly denied shell
command, native Stop-hook observation followed by terminal exit, same-session
resume, and cancellation of an explicitly allowed long-running tool child.
Requests use a dummy OAuth sentinel and a local synthetic upstream. The fixture
asserts model/thinking selection and OAuth headers without an API key. The Stop
hook is fixture evidence, not a protected production completion authority.
The local suite also covers the real gateway result route, real disposable SSH
control, durable invocation/candidate state, stopped-result capture and relocated
executor identity. Its private report lists the exact files and results; stdout
contains fixed case IDs and projected status only. Docker-client tests use an
injected engine port and do not start an engine or container.

Production source now wires `claude:actions` through the lease's authenticated
SSH connection to `runner-control native-execute`. The runner supervisor reserves
the nonce before launch, captures bounded private PTY output, and requires a
controller finish request plus confirmed backend shutdown before reporting
completion. The runner-host PTY custodian runs outside the agent PID namespace;
the normal interactive CLI and tools remain UID/GID1000 with no capabilities.
HOME transcript discovery, JSONL, Stop files and PTY text are untrusted advisory
data and never become model, turn or completion attestation. The gateway records
only complete run-bound upstream responses matching the saved model and effort.
That observation does not identify the requesting process or establish semantic
task completion. A malicious tool can itself make a run-authorized request.
Cancellation or acknowledgement loss revokes gateway
authority; uncertain custody cannot replay the prompt.

The controller and supervisor both require complete bounded stream closure;
trailing events or private-output overflow cannot become successful completion.
Launch/control input is bounded before newline discovery. Setup/sealing commands
run with clean environments and owned process groups, with timeout and signal
cancellation. A lost engine mutation response retains the exclusive operation
lock: a stopped-state read alone cannot rule out a delayed daemon-side start.
External recovery stop also persists a host-owned launch cancellation marker
before attempting the engine lock. Every pending start checks it under that lock;
an acknowledged stop therefore fences even a resume saved before engine acquisition.
Active or uncertain mutations still prevent acknowledgement. Clean pause does not
set this terminal marker. Received-closure and force-kill timers have separate owners.
Controller SQL cleanup bounds and interrupts connection acquisition, then joins the
actual persistence attempt and process pump; a held database cannot leave detached
late mutations or prevent owned subprocess teardown.
These lifecycle cases have local process/client-port controls. The owned backend
also exercises the actual container supervisor, stopped export, capture retry and
sleeping-tool cancellation; the complete controller/SSH/initialization path still
needs a combined acceptance run.

The source Docker boundary specifies UID/GID 1000, dropped capabilities,
no-new-privileges, a read-only root, memory/PID limits and the job-specific gateway
socket. The authorized owned-Docker fixtures have exercised these controls using
the built Nix image and the pinned interactive CLI. The image is loaded by content
ID in the private engine; a fixture-only reference translation does not claim a
published registry digest. Explicit pause waits for complete SSH closure and
stopped-container confirmation before saving nonterminal custody. Resume uses the
same container/workspace, session, model, effort and absolute deadline, with a new
invocation nonce and an exact predecessor check. Attach never replays a prompt.
The controller API implementation has local lifecycle/HTTP tests; the complete
application-to-owned-container acceptance path remains a separate review gate.
Neither local suite success nor daemon readiness proves live entitlement,
deployed Actions execution, full security acceptance or 500-job continuity.

### Owned backend evidence

The trusted host launcher uses a fresh Docker configuration and exact random-owner
labels against the explicitly authorized daemon. Only owned container IDs and
owned volumes/networks are inspected or removed. Tests run against a private inner
engine; the agent never receives either engine socket. Each substantive invocation
is bounded to five minutes, 6 GiB without swap, two CPUs and 1,024 outer PIDs.
An absolute container deadline and an independent exact-owner cleanup timer survive
controller death. The death-injection case kills the controller and requires a
stopped readback and removal receipt from the independent reaper.
Reaper source, ownership ledger and host command/cleanup receipts stay outside
the writable runtime evidence mount, including for adversarial tool fixtures.

```sh
python3 scripts/evidence/isolated-fixture.py --owned-docker-container
python3 scripts/evidence/isolated-fixture.py --owned-docker-network
python3 scripts/evidence/isolated-fixture.py --owned-docker-dagger
python3 scripts/evidence/isolated-fixture.py --owned-docker-dagger-network
python3 scripts/evidence/isolated-fixture.py --owned-docker-death
```

The network fixtures establish reachable synthetic listeners before installing
`network.sh`, require actual IPv4/IPv6 DROP-counter increases, preserve synthetic
public TCP/DNS, and verify restored connectivity after teardown. Dagger's host-only
`http()` case is measured separately: host counters increase while engine CNI DROP
counters stay unchanged. Nested execution separately hits the engine's isolation
rules, including its own gateway. Dagger IPv6 disablement is read back; native
Docker IPv6 has independent reachable positive controls. The real Dagger API also
refuses `insecureRootCapabilities` with the pinned empty-entitlements policy.

The optional Nix build uses a pinned, nonprivileged builder with a private store,
read-only source snapshot and a twenty-minute limit. It records the image archive's
SHA-256. Run one heavy invocation at a time:

```sh
python3 scripts/evidence/isolated-fixture.py --owned-docker-image
WORKFLOWD_FIXTURE_AGENT_IMAGE=/tmp/opencode/wfd-owned-docker-<build>/agent-image.tar \
WORKFLOWD_FIXTURE_AGENT_IMAGE_SHA256=<recorded-sha256> \
  python3 scripts/evidence/isolated-fixture.py --owned-docker-native
```

Each invocation prints its private evidence directory. Retain `ledger.json`,
`container-receipt.json`, command receipts and `cleanup-*.json`, including failed
attempts. The native fixture uses the actual supervisor, Docker boundary, PTY and
capture code, with a synthetic Unix-socket upstream. The trusted capture runtime
uses Python 3.12/Unicode 15.0, independently of the agent image's Python tools.
The application gateway/SQL/SSH controls have separate tests; this fixture does not
substitute for their eventual combined production-path acceptance.

## Historical native CLI prototypes

The live verifier accepts `opencode:opencode-primary`, `codex:local` and
`claude:local`. Select an accessible model explicitly for each invocation:
OpenCode takes `provider/model`; native CLIs take their native model ID. Use a
separate evidence root for each executor. All commands, including native workers,
run in transient user services capped at 6 GiB with no swap. Existing mint
credentials stay in their existing homes; none are copied into evidence or runners.
The historical Claude worker and its executable fixtures use print mode and are
outside the approved capability-gateway validation path. Do not invoke them,
including through the current full CI suite. Applicable executable fixtures must
be migrated to the interactive supervisor before full-suite execution. Live
interactive provider checks require separate authorization; offline fixture
success does not establish entitlement.

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

### Disposable runner hardening (E2/E3)

The pinned engine exposes a Unix socket shared only with tooling. It has no TCP
control listener and rejects `insecureRootCapabilities`. Agent containers never
receive the socket volume. The disposable VM installs owned `DOCKER-USER` rules
before booting tooling: forwarded container traffic cannot reach the bridge subnet,
`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`,
`169.254.0.0/16`, or Azure's `168.63.129.16`. No forwarded RFC1918 exception
is needed: Dagger DNS stays inside the engine and tooling uses the Unix socket. Both IPv4 and IPv6
forwarding from the sandbox bridge to `tailscale0` are dropped, including accepted
subnet routes outside the tailnet address range. Both families' INPUT chains accept
only `ESTABLISHED,RELATED` traffic from that bridge and drop everything else,
covering every runner address rather than a destination list. Docker's resolver
runs inside each container namespace and does not require a host INPUT exception.

Inside the engine, IPv4 INPUT allows only Dagger's DNS resolver. IPv6 is disabled
in that network namespace for existing and future interfaces, including `dagger0`;
the agent resolver uses IPv4. This avoids depending on optional legacy ip6tables
kernel modules in the pinned engine. Protected forwarded
destinations (including all non-loopback runner IPv4 addresses captured at boot and
`172.17.0.1`) are dropped through `CNI-ADMIN`, which CNI evaluates before its own
ACCEPT rules. The tests and live verifier require increasing DROP counters;
rule presence alone is insufficient. Stop removes the owned VM rules and socket
volume. Agents also have Dagger session API access: `http()` asks the engine
itself to open a connection, bypassing the engine's `dagger0` firewall entirely.
**This path relies on the host layer alone.** Both the live verifier and combined
E2E exercise it; an API error or connection refusal is not a successful denial.
The combined E2E routes synthetic destinations through a throwaway runner network
namespace attached to the real pinned engine. It runs the actual host rules,
checks reachable HTTP controls before installation, then tests API and nested
container denials, public egress and host IPv6 counters. These scripts must never be applied to mint or another controller host.

The hold step launches through `env -u` because the Actions runner injects OIDC
request variables after step-level environment overrides. The in-repo Tailscale
bootstrap installs checksum-pinned 1.94.2 binaries and starts `tailscaled` as a
systemd service with both request variables removed. Only the short-lived join
client receives the federated token on stdin using `--id-token=file:/dev/stdin`.
The token is never in sudo's argv or journal command record, nor saved to disk
([pinned CLI file support](https://github.com/tailscale/tailscale/blob/v1.94.2/cmd/tailscale/cli/up.go#L196-L217)). Cleanup attempts
Tailscale logout even if stopping containers fails, retaining a failing step status.
The join uses `--accept-routes=false`
and `--accept-dns=false`. The verifier scans all live process environments and
rejects OIDC request variables in any executable other than `Runner.Worker`;
it records names only and fails on unreadable live processes. GitHub's job-level
`id-token` permission remains until completion; this is not job-wide revocation.

The pinned Tailscale federation implementation sets `Reusable: false` when
creating its auth key, so successful enrollment consumes that key. The bootstrap
also requests an ephemeral device. Ephemeral lifetime alone does not consume a
reusable key. Sources: [pinned federation implementation](https://github.com/tailscale/tailscale/blob/v1.94.2/feature/identityfederation/identityfederation.go),
[pinned Dagger security configuration](https://github.com/dagger/dagger/blob/v0.18.14/docs/current_docs/configuration/engine.mdx#security).

Operator verification after merging and updating the approved workflow/tooling
pin requires a second disposable runner kept alive for the duration of the probe.
Provide `EVIDENCE_SANDBOX_NETWORK_HOSTS` as the path to a private JSON array with
one object per controller-visible IPv4 tailnet peer, plus mint itself, excluding
the runner being tested. Each object needs `role` (`mint`, `peer`, or
`second-runner`) and `address` (literal IP); remote objects also need `login`,
`identityFile`, and `knownHostsFile` for existing read-only SSH access. The verifier
requires all three roles and compares the inventory with Tailscale status.
It obtains `ss -H -ltn` on each host before and after probing, covers every listed
TCP listening port (including loopback-only listeners), and fails on missing
hosts, unavailable inventory, changed listeners or incomplete results. Offline
peers must be made available for this evidence run; they are never silently skipped.
Peers without SSH (such as phones) cannot supply this listener inventory. The
verifier deliberately fails rather than silently skipping them; a complete pass
requires an inventory-capable tailnet. A future explicitly reviewed exclusion
policy would need to disclose reduced coverage and cannot claim every-peer proof.
No credentials or process-owner details belong in the inventory.

Run the existing `--probe-denials` command in a capped user unit with
`MemoryMax=4G` and `MemorySwapMax=0`. It records controller controls before and
after, timeout denials from the runner host and a real container-use/Dagger
container, and process environment variable names. From Dagger it also probes
every non-loopback runner IPv4 address, the sandbox Docker gateway, the runner's
default gateway, `172.17.0.1`,
`169.254.169.254`, `168.63.129.16`, and the engine control address. Loopback inside
Dagger denotes the agent container itself, so it is not a runner-local target.
Tooling separately probes the runner addresses and tailnet peers to exercise host
INPUT and the `tailscale0` forwarding drop. Dagger `http()` probes the same targets
and requires server-reported TCP dial timeouts, using unique URLs to avoid caching. Both
container contexts must resolve public DNS, all protected TCP probes must time
out, and host/engine DROP counters must increase. The verifier captures
`ip route show table 52` before and after and rejects accepted routes outside
`100.64.0.0/10`. It asserts both families' host INPUT and specific `tailscale0` DROP counters,
and confirms the engine still has IPv6 disabled. For IPv6, a temporary source
namespace attaches to the runner sandbox bridge with a private probe address and
static neighbor entry. It probes bridge INPUT and an inventoried tailnet IPv6 peer,
briefly enabling IPv6 forwarding, then restores every interface's prior setting and
removes the probe namespace, link and address. These probes use ICMPv6 and require
counter increases, even on otherwise IPv4-only runners.
Connection-refused responses count only as controller reachability controls,
never as successful denials. The main connection inventory is TCP/IPv4; the separate IPv6 probes cover INPUT
and Tailscale forwarding, not every peer listener or UDP.
Release the second runner using its existing custody workflow afterward. No App,
environment, secret, ruleset or mint firewall changes are required by this PR.
