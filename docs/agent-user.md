# Agent user credential admission and native launch (draft)

This draft covers credential admission and Phase 2 native agent launch. Live
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
and compiles the three binaries into `dist/`. Running it without that flag then
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
