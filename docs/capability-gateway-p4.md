# Optional Git reads and bounded reconciliation

`capabilityGateway.gitRead` defaults to disabled. Enabling it permits the current
run to read its saved repository through these exact routes:

- `GET /capabilities/v1/git/<repositoryId>.git/info/refs?service=git-upload-pack`
- `POST /capabilities/v1/git/<repositoryId>.git/git-upload-pack`

The saved repository name, numeric identity, installation, run, attempt, channel,
source and deadline remain authoritative. The destination is always
`https://github.com/<saved-owner>/<saved-repository>.git`. Clients cannot select a
host, credential, service or repository outside that binding. Receive-pack, dumb
HTTP, redirects, compressed requests/responses and extra queries are refused.
Git shares the gateway's stream admission, request/response byte budgets, timeout,
revocation and cancellation fences.

On the runner, the relay listens on the private socket `gateway.sock` in its state
directory. It accepts only the local sentinel `Authorization: Bearer workflowd-local`,
which is not an upstream credential, and adds the current run bearer before it
forwards the request to the gateway over HTTPS. The numeric ID must match the run's
repository.

Production composition currently uses anonymous reads. The authenticated adapter
accepts the existing internal `makeTokenBroker` service and requests only the saved
installation/repository with `contents: read`. Synthetic fixtures exercise that
path; no production credential is wired or selected. Ben must separately select
an already-authorized Mint credential before activating authenticated reads. The
worker token-return endpoint and the protected ghettimonster key are not involved.
Writes continue through protected publication and its exact approved legacy pin:
`BNasraoui/workflowd/.github/actions/agent-publish@f74e0505155bc32aa2cedef00ba8b08ef1b90007`.
Native production publication still requires a separately reviewed fixed-v1 pin.

## Lifecycle and cleanup

An actions-native lease is bounded by its absolute deadline. It receives no
per-container heartbeat RPC. Sandbox sweeps wait for existing work
signals or a poll deadline; lifecycle wakeups cannot repeat repository inventory
more often than once per minute in a lease-service instance. Release and reconcile
share admission, including failed attempts. Cached failure stays uncertainty;
interrupted attempts cannot become successful inventory. Waiting saved inventory
identities take admissions in arrival order; repeated calls coalesce without moving
an identity ahead of older waiters. The next admission serves that saved policy even
if today's configured policy calls first, so workflow rollover cannot starve retained
custody. This queue resets on service restart, alongside the admission cache. Startup still revokes
old grants and conservatively cancels retained custody. Same-job production
reattachment is not implemented.

Native inventory queries queued, in-progress, waiting, pending and requested runs
separately, with at most ten 100-entry pages per status and a 60-second deadline.
Completed history cannot consume that active inventory budget. An incomplete,
malformed, over-bound or unavailable inventory remains an error. Status transitions
may repeat IDs; they do not prove termination. Known IDs remain in SQLite and are
read individually even when inventory fails. Only exact completed-run readback
and confirmed ref cleanup allow release.

Native known-run cleanup is serialized, bounded to eight attempts per repository
pass, paced at 250 ms between attempts, and capped at 60 seconds. Oldest attempted
custody is retried first. Inventory errors do not reset that ordering. Pending
rows advance through ref cleanup immediately after their exact run read, so a
slow later read cannot starve already confirmed releases. Pending
termination, API failures, late visibility and ref-cleanup uncertainty remain
retained for another pass. An empty page never establishes termination. Existing
process-join, finalization revision, publication-intent and mailbox fences remain
required.

Unobserved lease discovery also takes at most eight attempts per native pass,
rotating through retained leases within the service instance. A 60-second sweep
deadline bounds discovery/acquisition before the independent known-run cleanup.
The discovery cursor resets on controller restart; durable custody does not.

## Fixture and CI boundary

`scripts/check-capability-security.ts --suite final-local --upstream fixture
--evidence <private-directory>` runs the Git read, reconciliation, process-environment,
publication-parity, public-output, CI-setup and startup cases that
`scripts/capability-suites.ts` lists. Core, publication-local and adapters are
separately named suites. Every listed case must run and pass; skips and timeouts
fail the driver.

CI runs each named suite through the checked-in systemd/bubblewrap launcher with
6 GiB, no swap, two CPUs, a PID bound, private network/HOME/TMPDIR and no host bus
or Docker socket. Pinned public tools are staged in the disposable runner's
temporary directory. The existing fixed-field public serializer captures raw
setup and test output; private captures are bounded, ephemeral and never uploaded.
Dependency installation, namespace provisioning and pinned-tool commands all enter
through this capture boundary, without inherited Actions command-file sinks.
The launcher creates an absent checkout scratch mountpoint and refuses symlinks.
A real clean-copy launch regression precedes the named suites. Required checks
include the named security jobs.

The gateway's HTTP server destroys a response on stream failure: a revoked response
fails on the wire, even on runtimes where an errored Fetch response ends with a clean
HTTP terminator.

Changed-line coverage, unchanged per-file coverage/CRAP thresholds and full CI
remain separate merge gates. A named local pass does not establish full CI or
deployed policy. Final source-qualified results and retained failures belong in
the sealed implementation handoff. Live provider/Actions entitlement, effective
Tailscale ACL/federation and production restart/drain policy remain separate
operator gates. No 500-agent
capacity demonstration or capacity soak is required.
