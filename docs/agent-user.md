# Agent user credential admission (draft)

This draft covers Phase 1 credential admission. Live provisioning and cutover
remain later phases.

The draft adds credential metadata checks, an admission lease held through
handoff, and explicit offline relinking of a uniquely replaced login. Missing
links, plain-file replacements, invalid permissions, and unfinished repairs
refuse admission. Configuration enables the guard with
`WORKFLOWD_AGENT_HOST_SOCKET`; absence retains the existing execution path.

The installed-client fixtures use invented credentials and isolated homes.
Codex 0.159.1 writes through its link, but logout followed by synthetic re-login
replaces the link. Claude 2.1.296 refreshes through a local OAuth fixture and
replaces its link with a private file. The tests exercise refusal and explicit
repair rather than treating either replacement as a shared in-place refresh.
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
and compiles the three binaries into `dist/`. Running it without that flag then
installs the artifacts for already-provisioned identities and a reviewed policy.
The host unit limits capabilities to credential traversal and socket ownership;
its home view is read-only. Live provisioning and cutover remain later phases.

Focused local checks run in capped user units:

```sh
systemd-run --user --wait --pipe --collect -p MemoryMax=6G -p MemorySwapMax=0 \
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
