# Agent user credential admission and execution (draft)

This draft covers credential admission, native agent launch, and Phase 3 shared OpenCode and App publishing. Live
provisioning and cutover remain later phases.

The draft adds credential metadata checks, an admission lease held through
handoff, and journaled relinking of a uniquely replaced login. The root host
now automatically repairs the unambiguous replacement described below. Missing
links, ambiguous replacements, invalid permissions, and unfinished repairs
refuse admission. Configuration enables the guard with
`WORKFLOWD_AGENT_HOST_SOCKET`; an installed host policy requires an absolute
socket path and refuses controller fallback.

The installed-client fixtures use invented credentials and isolated homes.
Codex 0.159.1 writes through its link, but logout followed by synthetic re-login
replaces the link. Claude 2.1.296 refreshes through a local OAuth fixture and
replaces its link with a private file. The installed-client probes retain explicit repair coverage. Host admission tests
also exercise automatic relink from each user and refusal of ambiguous layouts;
neither replacement is treated as a shared in-place refresh.
A private network namespace denies external egress during refresh probes.

The OpenCode draft checks the beta-19242 database schema, transfers credential
rows using an offline SQLite transaction, and retains a nonsecret migration
journal. It refuses unknown schemas, active database consumers, and every live
agent-user process. The destination must already exist with agent ownership,
mode 0600 and ancestry without group or other write (private data directories should be
0700). Migration pins its parent and file descriptors, verifies the inode before
SQLite ATTACH, and never changes ownership. SQLite's NOFOLLOW open rejects
symlink ancestors; the explicit drain must remain in force through the migration.
The installed-server restart/attachment fixture passes with invented grants;
this does not establish acceptance of real OAuth grants by providers.

The policy lists each previous OpenCode service with its scope and user. The
migration entrypoint requires every listed service to be masked and inactive;
user services are inspected through `systemctl --user -M ben@`. The template
covers `opencode-server`, `opencode2-server`, and `opencode2-reviewer`. Operators
must include any additional local autostart services before cutover. No live
services are changed by these checks.

CI includes a disposable two-UID credential gate. Local tests inside a private
user/PID namespace are administrative regressions, not cross-UID deployment
proof. No mint accounts, groups, credentials, services, or configuration were
changed. The entrypoints are included in the TypeScript project.

Admission connections have a 15-second handshake timeout. Once admitted, the
lease deliberately remains held until the controller closes the connection:
expiring it while a launch/prompt is still in flight would allow relinking to
overlap that handoff. A stalled controller can therefore block relink. Drain
and stop the affected controller/clients before repair; process exit releases
the socket and lock. Do not clear a lock beneath a live admission.

Relink requires every agent-user process and all affected controller clients to
be stopped. After relinking, restart affected Codex, Claude and OpenCode clients
before admitting new work so cached grants cannot survive the repair. The
command does not restart clients itself.

`deploy/agent-user/install.sh --build-only` installs locked build dependencies
and compiles the host, administrative commands and trusted worker entrypoints into `dist/`. Running it without that flag then
installs the artifacts for already-provisioned identities and a reviewed policy.
The host unit limits capabilities to DAC traversal/access, ownership changes,
and cross-UID process inspection (`CAP_SYS_PTRACE`) for fail-closed consumer
checks. Agent units retain an empty capability set.
Its home view is read-only except for the four configured client credential
parent directories: atomic link replacement needs directory write access. The
checked-in paths match the policy template; deployments with different client
homes must explicitly override `ReadWritePaths` to match their reviewed policy.
Missing paths do not grant admission. Live provisioning and cutover remain later phases.

## Automatic relink

On authenticated admission, native launch or a resident turn, a divergent Codex
or Claude layout is eligible for automatic repair only when exactly one configured
link has become a private, singly linked regular file owned by that side's user,
with a modification time strictly newer than the canonical store. The other side
must still be the exact canonical symlink. The replacement must be nonempty and
at most 1 MiB; the canonical store and ancestry must retain their required ownership
and permissions. Timestamps establish ordering only after these layout checks;
they never choose between competing replacements.

The host drops its shared admission lease, takes the existing exclusive lock,
rechecks the layout, and requires every agent process and affected controller
client to be stopped. It uses the existing durable repair journal and atomic
store/link replacement, then reacquires and verifies a shared lease before
handoff. It checks consumers again immediately before importing the replacement.
Credential values never appear in protocol replies or diagnostics.

Both sides changed, missing or unexpected links, unsafe paths or ownership,
hardlinks, older or tied timestamps, and leftover staging, journal or temporary
link files all refuse automatic repair and wait for the operator. An interrupted
automatic repair leaves the same durable admission fence as offline repair; only
explicit operator relink may resume it. Live consumers and admission leases also
refuse repair; drain and stop clients before retrying. The host does not stop or
restart clients or choose an ambiguous source itself.

## Native Git identity

The root host requires `WORKFLOWD_AGENT_GIT_NAME`, `WORKFLOWD_AGENT_GIT_EMAIL`, and
the operator's `WORKFLOWD_AGENT_GIT_BLOCKED_EMAILS` policy in the root-owned 0600
`/etc/workflowd/agent-git.env` file. No real identity values belong in this repository.
All fixed native launch profiles inherit author and committer environment values.
The agent-UID worker installs guards in new clones and refreshes marked workspaces
before native runs and Claude resume. Marker and policy files remain agent-owned
and private; agents cannot access controller Git metadata. See
[Agent Git identity](agent-git-identity.md) for original-hook chaining and the
explicit same-UID bypass limits. Disposable two-UID CI verifies the environment,
agent-readable private files, and blocked author/committer commits.

Focused local checks run in capped user units:

```sh
systemd-run --user --wait --pipe --collect -p MemoryMax=4G -p MemorySwapMax=0 \
  --working-directory="$PWD" --setenv="PATH=$PATH" \
  bun test test/agent-user/client-versions.test.ts \
  test/agent-user/credentials.e2e.test.ts \
  test/agent-user/credential-dispatch.e2e.test.ts
```

The evidence script supports `--probe-credentials` and emits metadata only.
It is not an installation or cutover command. The relink and migration programs
are administrative entrypoints for further validation; agents receive no sudo
or repair authority.

## Operator credential and deployment isolation

Before live cutover, verify from the separate agent UID that it cannot **read**
Ben's `~/.config/gh/hosts.yml`, owner `GH_TOKEN`/`GITHUB_TOKEN` values or files that
supply them, `~/.config/workflowd/env`, rollout override/env files, or any approval
or administration credential. Read access alone permits impersonation. Do not
pass these variables into agent processes. Model credential admission does not
authorize access to the owner's GitHub credentials.

Deny writes to gh `config.yml` (including its `http_unix_socket` setting), Git
configuration, unit/drop-in files, `~/.config/environment.d`, executable paths,
and every ancestor that could permit replacement. Deny access to the operator
user systemd bus, including `systemctl --user set-environment`; manager variables
can reach transient units before a script can sanitize its environment. Remove
same-UID agent processes and sudo/polkit escalation routes before relying on
ownership separation. Audit modes, ownership and ACLs without printing secrets.

For verified deployments, provision a separate repository-scoped read-only token
in an operator-owned mode-0600 file, passed to the entrypoint with
`--github-token-file`; the script sets GH_TOKEN only for gh calls without using
the owner's gh login. Protect the deployment state file, release/Git metadata, node_modules,
managed skills marker/root and binaries. Audit global `~/.bunfig.toml`,
`$XDG_CONFIG_HOME/.bunfig.toml`, `~/.npmrc`, and `~/.bun/install/cache` or
BUN_INSTALL_CACHE_DIR too. The entrypoint uses empty global configuration and
`--no-cache --backend=copyfile`; services/manual installs require their own audit.
See the [verified deployment runbook](../deploy/verified-deploy.md) for the exact
operator steps, App ID pinning, first-parent verification and explicit bootstrap.

Verified deployment units use `/opt/workflowd/deploy/current`, an atomically
replaced symlink into the operator-owned mode-0700 `deploy/releases/` directory.
Every deployment, including rollback, initializes a new mode-0700 release and
`.git`, fetches from HTTPS GitHub, runs strict full fsck and checks the GitHub tree
SHA. Nothing from an earlier release's Git directory or dependencies is reused.
The old release stays available through `deploy/previous`; the lock, audit log
and last successful SHA live separately under `/opt/workflowd/operator/`.
Protect both link parents against replacement by agents. Keep service runtime
state outside releases; a new release starts with no previous untracked files.

Budget disk for current, previous and staging copies of full Git history, working
files and dependencies; retained releases accumulate until explicitly pruned by
the operator under the deployment lock. Keep both link targets and any release
still in use by a process. Roll back by running the protected entrypoint for the
previous successful SHA with explicit `--bootstrap` when required; it verifies
and builds a fresh release again. Never directly reactivate retained `.git` or
edit deployment state. See the runbook's layout, cleanup and recovery procedures.

## Phase 2 reviewed deviations and protocol

The Phase 2 continuation explicitly records two deviations from the original
plan: the root host needs `CAP_SYS_PTRACE` to inspect `/proc` across UIDs and
refuse repair while consumers run; and its protocol includes `connect` in
addition to `start`, `inspect`, `listOwned`, `stop`, and bounded `exchange`.
The agent units receive no capabilities. `connect` authenticates the controller
peer UID and requires the run's launch nonce and an active owned process. It
relays line-delimited JSON RPC to the agent-owned Codex app-server socket,
allowlists methods, and holds credential admission across each forwarded turn.
The agent controls that socket's directory, so the relay remains inside the
shared agent-UID trust domain; it does not authenticate individual agent sessions
against one another.

Rollout must allow an idle repair window: automatic relink refuses while **any
agent unit** or the operator's **Claude or Codex** runs, including unrelated
runs. Active or unconfirmed host custody is an additional fence even if a process
scan misses a consumer. Finished custody is reconciled by host inspection and
collection. A failed systemd launch with a confirmed absent unit is recorded as never launched. An absent record without an InvocationID receives a 60-second grace period before that reconciliation; inspection failures and unknown units remain fenced. Expect
`credential_relink_in_progress` until consumers are idle and custody is resolved.
No automatic relink stops consumers for the operator.

Both manual and automatic repair recheck both paths immediately before each link
replacement. Linux `renameat2(RENAME_EXCHANGE)` retains the displaced entry for
validation and swaps it back on a race; a mismatch keeps the repair journal and
refuses admission. Explicit recovery of a missing link uses `RENAME_NOREPLACE`.
The journal records device/inode, ctime, mtime and size from the import handle's fstat. Those values must still match before each exchange. The displaced entry must retain the imported mtime and size; its ctime must match the exchange timestamp on the replacement symlink (Linux changes ctime during exchange). An in-place rewrite therefore retains the journal and refuses admission.
Import reads at most 1 MiB + 1 bytes and refuses an oversized source, including
one that grows after inspection. A login arriving during import is preserved;
the journal fences the already imported canonical value for explicit recovery.

A host connection lost after writing `start` is an uncertain launch, so the
controller retains its spawning row for reattachment. Only transport failures
before the request is written can report an unreachable-host refusal. Workspace
setup runs with a fresh custody identity on each request, skips clone/checkout
for an existing directory, and reinstalls the Git guard as the agent UID.

Disposable privileged CI checks denial of the real Docker socket after proving
that the agent UID can ping it outside the unit, then restores its permissions.
It also probes `/run/credentials/workflowd.service/nats-creds`, the controller's
`.local/state/workflowd/workflowd.db`, and deployed NATS/noscope paths in the
fixture operator home. These contain only synthetic canaries. JUnit checks require
successful credential tests and the named repair regressions, preventing a skipped
privileged suite from passing silently.

PR #112's repository-config isolation also applies to host launches: native
Claude launch and both host/local resume use `--setting-sources user`, while
sandboxed Claude keeps empty setting sources. Host Codex app-server and model
discovery pass the same untrusted-project configuration arguments as the resident
launcher. See [Agent project config](agent-project-config.md).


## Shared OpenCode and App publishing

The installer supplies `workflowd-agent-opencode.service` without starting it.
After a drained, reviewed migration, this is the sole server for new agent runs,
including reviews. The service checks the migration journal and the masked,
inactive old source units before every start. Its fixed agent UID, primary group
and supplementary groups must match `WORKFLOWD_AGENT_UID` and
`WORKFLOWD_AGENT_GID`. The root-owned `agent-opencode.env` supplies those IDs and
`OPENCODE_SERVER_PASSWORD`; `agent-git.env` supplies the existing Git identity
policy. The server uses `/var/lib/workflowd-agent`, separate configuration and
transcripts, and both OpenCode project-config disable settings. The operator
attaches to this server instead of starting another credential consumer. Migration
and live service activation remain explicit administrative operations.

The controller's agent-host configuration must also set `WORKFLOWD_AGENT_HOME`,
`WORKFLOWD_AGENT_UID`, `WORKFLOWD_AGENT_GID`, and the trusted
`WORKFLOWD_WORKER_GITHUB_COMMAND=/usr/local/libexec/workflowd-worker-github.js`.
Place the GitHub and mailbox sockets in the installed
`/var/lib/workflowd/agent-access` directory. Its controller ownership and group
search permission permit agent connections without exposing the controller DB or
App key. Socket files are group-accessible, but kernel peer credentials admit
only the controller and agent UIDs; other group members cannot use them.

Native broker requests additionally require ancestry beneath the registered run
process and its original process birth time. The host protocol carries only the
selected run ID and broker/mailbox paths, and attachment restores registration.
OpenCode requests instead require a random run/session capability, verified
against live session/resource custody on every request. Controller restart
rotates capabilities for recoverable active sessions without replaying a prompt.
Terminal or expired runs cannot obtain more tokens. Previously issued GitHub
tokens remain valid until GitHub expires or revokes them.

The trusted command obtains a repository-scoped App token for each invocation,
clears personal GitHub/SSH and inherited Git configuration variables, and uses
HTTPS Git with certificate verification. The agent receives no App private key,
controller Git configuration or personal `gh` login. The existing same-agent-UID
trust limits still apply. The model's instructions name this command for Git and
`gh`; GitHub enforces the token's repository permissions.

Disposable CI drives the three installed clients through synthetic local model,
HTTPS Git and GitHub API fixtures, requiring push/PR head readback under the agent
UID. The OpenCode migration probe exercises OAuth refresh persistence and operator
attachment without a second refresh. Resident tests require run-bound completion
and recovery without duplicate delivery. These fixtures do not establish real
provider acceptance or complete the Phase 4 mint cutover.
