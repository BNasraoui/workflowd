# Agent user credential admission (draft)

Phase 1 is incomplete. Do not install or enable this draft on a live host.

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
journal. It refuses active database consumers and unknown schemas. Its installed
server restart/attachment test is not yet passing; OAuth provider acceptance,
crash recovery, and sole-refresher operation are not established by this draft.

CI includes a disposable-UID credential gate. Passing local same-UID tests is
not evidence that this gate or deployment isolation works. No mint accounts,
groups, credentials, services, or configuration were changed.

Current scope blocker: the administrative TypeScript entrypoints under
`deploy/agent-user/` are excluded by `tsconfig.json`; ESLint cannot load them
through its project service. Project inclusion needs an approved tooling change
before Phase 1 can pass all required checks.

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
