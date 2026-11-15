# Capability gateway: configuration, Git reads, session leases and fixture suites

## Configuration

`WORKFLOWD_CAPABILITY_GATEWAY` holds one JSON object. workflowd and the gateway process
decode it with the same schema, and a key it does not name is refused.

| Key | Value |
| --- | --- |
| `noscope.binary`, `noscope.configHome` | Absolute paths of the noscope binary and of its configuration. |
| `providerId` | The provider id of the model route `/capabilities/v1/providers/<id>/`: a lower-case letter, then at most 63 lower-case letters, digits and hyphens. The session grant names it, and the runner's relay puts it in the path of each model call. |
| `credentialRole` | The noscope role that mints run tokens and provider credentials. |
| `maxStreams` | The most streams open at once in the gateway: 1 to 512. |
| `maxStreamsPerRun` | The most streams open at once for one run: 1 to 4, and at most `maxStreams`. |
| `streamIdleMs` | Optional. Milliseconds a stream may go without a chunk before the gateway aborts it: 1 to 600000, 120000 when absent. A stream that keeps sending runs to its token's expiry. |
| `gitRead` | Optional. Whether runs may read their saved repository; false when absent. |
| `listen.host`, `listen.port` | Where the gateway process listens: `127.0.0.1` or `::1`, since the listener is clear text, and port 0 to 65535, where 0 asks for a free port. workflowd accepts the key and does not read it; the gateway process requires it. |

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
`publication-local` and `final-local`. Each test file of `test/capability-gateway`, at each
depth, belongs to one of them: the end-to-end files to `gateway`, the others to `core`,
except the pinned Claude Code test, `claude-pinned.launcher.test.ts`. One step of the Tests
job runs that file, as the runner's user, in a network namespace whose only interface is
loopback; the file fails when it runs anywhere else. No file is in two suites, and
`test/capability-suites.test.ts` fails when one is.

The `Capability security` jobs run each suite through
`scripts/evidence/isolated-fixture.py`: a systemd user unit with 6 GiB of memory, no swap,
two CPUs and a task limit, and inside it bubblewrap with a private network, home and
temporary directory and no host bus or Docker socket. `scripts/check-capability-security.ts
--suite <name>` runs each listed file in its own `bun test`, and prints the number of files
that ran (it calls each file a case) and the name of each file that failed. A suite with no
file fails. A file fails when it does not pass a test, or reports a failed, skipped or todo
test, or passes its time or output limit.

Test files named `*.launcher.test.ts` run only in these suites, or, for the pinned Claude
Code test, in its own step; `bunfig.toml` keeps them out of the plain test run and its
coverage gate.
