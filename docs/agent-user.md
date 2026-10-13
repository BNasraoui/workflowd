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
