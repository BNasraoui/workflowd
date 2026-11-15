# Capability gateway: Git reads, session leases and fixture suites

## Git reads

`capabilityGateway.gitRead` defaults to false. When it is true, a run reads its saved
repository through these two routes only:

- `GET /capabilities/v1/git/<repositoryId>.git/info/refs?service=git-upload-pack`
- `POST /capabilities/v1/git/<repositoryId>.git/git-upload-pack`

The run's saved repository selects the destination,
`https://github.com/<owner>/<repository>.git`, and the numeric id in the path must be
that repository's. A client cannot select a host, a service or another repository.
Receive-pack, dumb HTTP, redirects, compressed requests and responses, and extra
queries are refused. The read carries no credential, so it serves a public repository
only. Git reads share the gateway's stream admission, byte limits, timeouts and
revocation with model calls.

On the runner, the relay listens on the socket `gateway.sock` in its state directory.
It accepts only the local placeholder `Authorization: Bearer workflowd-local`, which is
no upstream credential, and sends the request on with the run token to the gateway's
HTTPS origin. The gateway's own listener is clear text; TLS comes from a front between
the runner and that listener.

## Session leases and publication

A repository whose policy sets `privateBootstrap.mode` to `actions-native` gets no
harness run from the daemon: dispatch refuses such a run before it makes a lease. A
lease of that mode is ready once its runner holds a gateway session, and its release
revokes the run's capability binding first. The publisher refuses to publish for such
a lease. Writes go through protected publication with the pinned publisher
`BNasraoui/workflowd/.github/actions/agent-publish@f74e0505155bc32aa2cedef00ba8b08ef1b90007`.

## Fixture suites in CI

`scripts/capability-suites.ts` names four suites of test files: `core`, `gateway`,
`publication-local` and `final-local`. Each test file of `test/capability-gateway` belongs
to one of them: the end-to-end files to `gateway`, the others to `core`, except the pinned
Claude Code test, which the Tests job runs. No file is in two suites, and
`test/capability-suites.test.ts` fails when one is. The `Capability security` jobs run
each suite through `scripts/evidence/isolated-fixture.py`: a systemd user unit with
6 GiB of memory, no swap, two CPUs and a task limit, and inside it bubblewrap with a
private network, home and temporary directory and no host bus or Docker socket.
`scripts/check-capability-security.ts --suite <name>` runs each listed file in its own
`bun test` and prints the number of cases that ran and the name of each case that
failed. A suite with no case fails. A case fails when it does not pass a test, or reports a failed, skipped or todo
test, or passes its time or output limit.

Test files named `*.launcher.test.ts` run only in these suites; `bunfig.toml` keeps
them out of the plain test run and its coverage gate.
