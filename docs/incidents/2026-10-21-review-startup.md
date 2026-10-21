# Empty reviewer catalogs blocked workflowd startup

Tracking: workflowd-vba1. Host: mint. Times below are AEST, 2026-10-21.

## Incident and confirmed cause

From 20:19 until 23:04, workflowd accepted no dispatches and its systemd restart
counter reached 186. The user journal confirms repeated
`OpenCode startup validation timed out after 30 seconds`, exits with status 1,
and `Scheduled restart job, restart counter is at 186` at 23:04:35. At 23:04:37
catalog diagnostics show `agentCount: 0, modelCount: 0`, with `pr-reviewer` and
`zai-coding-plan/glm-5.3-flash` absent. The daemon finally logged
`workflowd listening on http://127.0.0.1:8787` at 23:04:39. The incident report
records 10 agents, the reviewer and GLM model present, and responding health
about three minutes later; that later catalog observation was supplied by the
operator rather than re-probed during this investigation.

The initiating event was an OOM kill, not a catalog configuration edit:

- 20:18:34: `opencode2-server.service: Failed with result 'oom-kill'`;
  systemd reports an 8.0G memory peak and 393.1M swap peak.
- 20:18:39: server restart scheduled; workflowd is stopped.
- 20:18:43: `opencode2-server` and workflowd start again.
- 20:19:55 and subsequent starts: the startup availability deadline fails.

`startHookService` awaited review automation availability before acquiring the
HTTP listener or starting dispatch workers. Catalog reads retried every two
seconds with a 30-second limit. Empty catalogs remained retryable, but exhausting
that startup limit exited the entire daemon. The deployed `Restart=always`
then repeated the failure.

Inspection used `journalctl --user -u workflowd -u opencode2-reviewer
-u opencode2-server --since "2026-10-21 20:10" --until "2026-10-21 20:25"`,
the reviewer/workflowd journals through 23:10, `systemctl --user cat`, and
`systemctl --user show` dependency properties. No service or host configuration
was changed.

## Unit relationship and operator action

The loaded workflowd unit requires both `opencode-server.service` and
`opencode2-server.service` (the latter via `20-opencode2.conf`). That explains
workflowd stopping when the primary OpenCode server was restarted after OOM.
The reviewer unit has only network ordering/wants and ordinary slice/basic
requirements: no `PartOf`, `BindsTo`, or `Requires=workflowd` relationship exists
in either its loaded files or effective properties.

Contrary to the initial hypothesis, its journal contains **one** reviewer
restart in this interval: stop requested 23:03:05, a 90-second stop timeout,
SIGKILL and start at 23:04:35. It does not show the reviewer restarting 186 times.
The equal current `ActiveEnterTimestamp` values reflect that final simultaneous
start; they do not prove restart propagation. The journal does not identify who
requested the reviewer stop. No reviewer dependency removal is warranted by
this evidence, and no unit change is included. Operators should keep the
reviewer independent and inspect the primary-server OOM separately. Removal of
the primary server's hard requirement would be a separate deployment decision;
this patch addresses the catalog startup failure.

## Behavior, verification, and limits

Review availability now runs in a daemon-scoped background fiber. Each attempt
is capped at 10 seconds; failed attempts back off 2, 4, 8, 16, then 30 seconds,
without an overall startup deadline. The listener, kernel dispatch workers,
health, and other services start immediately. PR review/fix job claims remain
paused until validation succeeds, then the job lane is woken. Accepted work
remains in the stores while paused. Existing publication and command workers
continue operating.

`GET /health` includes `reviewAutomation.status`: `unavailable`, `misconfigured`,
`available`, or `disabled` for execution-only mode. Unavailable/misconfigured
review automation makes overall health degraded while the endpoint stays HTTP
200 for liveness. A non-empty catalog missing the configured agent/model is a
hard configuration error in health and error logs, rather than a fatal process
exit. Checks continue so an operator can correct configuration without restarting
the daemon. Readiness checking ends after its first success; later per-job
OpenCode failures retain the existing handling. Permanently empty catalogs stay
unavailable because they cannot reliably distinguish cold plugins from absent
configuration.

State transitions log once. Adapter diagnostics retain safe endpoint,
catalog counts, and requested-selection presence, suppressing identical failed
snapshots until the state changes or a successful validation resets them. No
nested request causes or credential-bearing URLs are added to health/logs.

Regression tests use a loopback fake OpenCode HTTP server, the real SDK and
adapter, daemon HTTP routes, in-memory stores, and Effect's virtual clock.
Catalogs stay empty beyond 30 seconds, health remains reachable, a dispatch
accepted during warmup completes, and queued review work is gated until ready.
A catalog that fills without the required reviewer reports misconfiguration
and continues serving. Existing bounded QRSPI checks remain unchanged. No live
OpenCode or GitHub services are used by these tests.
