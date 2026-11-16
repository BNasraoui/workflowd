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
| `streamIdleMs` | Optional. Milliseconds a stream may go without a chunk before the gateway aborts it: 1 to 120000, 120000 when absent. The bound is the listener's socket timeout, which also cuts a silent stream. A stream that keeps sending runs to its token's expiry. |
| `gitRead` | Optional. Whether runs may read their saved repository; false when absent. |
| `listen.socket` | The absolute path of the gateway's one listener, a Unix socket. The gateway has no TCP listener. It owns the socket's directory, mode 0710 with the front's group, and makes it when it is missing; each directory above it must be owned by root or the gateway's uid and closed to writes by others, or have the sticky bit. The socket has mode 0660. |
| `listen.front.uid`, `listen.front.gid` | The uid and gid of the front, Tailscale Serve. The gateway serves the front's uid only; the directory has the front's group. |
| `listen.service` | The Service as its clients name it, as Serve sends it on in `X-Forwarded-Host`: its MagicDNS name in lower case, with `:<port>` when Serve serves it on a port other than 443. |

A `listen` section with another key, such as `host` or `port`, is refused, and the gateway
process exits with that error before it makes a socket. workflowd accepts the section and does
not read it; the gateway process requires it.

## The listener

The front reaches the gateway on `listen.socket`. As the gateway accepts a connection, it reads
the caller's uid from the kernel (SO_PEERCRED), before it reads a byte; a caller whose uid is
not `listen.front.uid` is ended there, and no route runs. Each other connection goes on to the
gateway's HTTP server, which listens on a socket in a directory of the gateway's own, mode
0700, below its temporary directory: Bun's HTTP server gives no descriptor of a connection that
it accepts, so the uid is read before it.

Before any route, a request must carry the headers that Serve sends to a `unix:` target for a
request of a tagged node: `X-Forwarded-For` once, one address in `100.64.0.0/10` or
`fd7a:115c:a1e0::/48` and not a list; `X-Forwarded-Proto` once, `https`; and
`X-Forwarded-Host` once, equal to `listen.service`. A request with `Forwarded`, any other
`X-Forwarded-` header (`X-Forwarded-Port` and `X-Forwarded-Server` among them), `X-Real-IP`,
`Via` or a header whose name starts with `Tailscale-` gets an empty 403, as does one that
misses the rule; Serve adds `Tailscale-User-` headers for a node of a user, so only a tagged
node's request passes. The three headers are removed before the route: no route reads one, the
store keeps none, none is an identity, and none reaches the provider. `Host`, which Serve sets
to `localhost` for a `unix:` target, names the listener and reaches no route.

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
HTTPS origin: the Service, where Tailscale Serve ends TLS and passes the request on to the
gateway's Unix socket.

## Session leases and publication

A repository whose policy sets `privateBootstrap.mode` to `actions-native` gets no
harness run from the daemon: dispatch refuses such a run before it makes a lease. A
lease of that mode is ready once its runner holds a gateway session, and its release
revokes the run's capability binding first. The publisher refuses to publish for such
a lease. Writes go through protected publication with the pinned publisher
`BNasraoui/workflowd/.github/actions/agent-publish@f74e0505155bc32aa2cedef00ba8b08ef1b90007`.

## Fixture suites in CI

`scripts/capability-suites.ts` names five suites of test files: `core`, `gateway`,
`publication-local`, `final-local` and `gateway-budget`. Each test file of
`test/capability-gateway`, at each depth, belongs to one of them: the end-to-end files of the
run budget (`budget*.e2e.test.ts`) to `gateway-budget`, so that each suite ends within the unit's
time limit, the other end-to-end files to `gateway`, the others to `core`,
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

## Login custody

With a `login` section, the gateway holds its provider's login in `login.directory` and renews
it on demand. The login comes in only through `import-login <provider>`, which reads it on
standard input. The gateway runs as one uid, and `import-login` runs as that same uid, never as
root: it makes a missing `login.directory` with mode 0700, refuses an existing one that the
gateway's own check at start refuses (another owner, or a mode other than 0700), and names in its
output the uid that owns the login. The gateway refuses at start a login directory or file of
another owner, and names that owner as the cause. A renewal sends the stored refresh value to the OAuth server; the server replaces
that value in its answer, so an answer that is lost (a kill of the gateway during the request,
or a failed write of the answer) can leave a stored value that the server no longer takes, and
the login then needs a new import.

A stop never cuts off a renewal whose request has gone out. Custody ends on SIGTERM, and on the
end of noscope, its parent, which signals it SIGTERM: at once, or, with a renewal in flight,
once the answer has come or custody's limit of 5 seconds on the request has passed and the
result is stored, within 6 seconds. On SIGTERM the gateway waits for a renewal in flight up to
the same 6 seconds before it ends noscope. This holds for each way to stop the gateway: `docker
stop`, which signals only the gateway, the image's first process; and a systemd unit with any
`KillMode`, also the default `control-group`, which signals the gateway, noscope and custody at
one moment. Noscope ends at once on SIGTERM; custody then finishes alone, and systemd waits for
it as a process of the unit. The stop timeout of the gateway's container or unit, from SIGTERM
to SIGKILL, must be at least 15 seconds: `docker stop --time 15` or `--stop-timeout 15`, or
`TimeoutStopSec=15` in a systemd unit, which covers that wait and the stop of the listener and
the store. A SIGKILL during a renewal, or a timeout shorter than that, can lose the answer.
