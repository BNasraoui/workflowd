# Hung reviewer blocked workflowd startup

Tracking: workflowd-vba1. Host: mint. Times below are AEST, 2026-10-21.

## Incident and confirmed cause

From 20:19 until 23:04, workflowd accepted no dispatches and its systemd restart
counter reached 186. Across the journals from 20:10–23:10, all 183
`OpenCode startup validation timed out after 30 seconds` errors lack the
`(operation): cause` suffix. `lastFailure` was undefined: no catalog read
completed within 30 seconds. There are no `availability check failed` or
`retrying` lines until 23:04:37. The catalog was not repeatedly empty; the
reviewer never answered.

The reviewer process (PID 1409253) had been running since October 13. Aborts of
reviewer session `fe521e27` failed from 16:56 ("did not confirm") and timed out
from 19:31. Catalog reads still answered within two seconds at 16:57; the
reviewer subsequently became unresponsive while workflowd was running.

The primary server's OOM triggered workflowd's first start against this already
hung reviewer, through its `Requires=` dependency:

- 20:17:48: the OOM killer killed `opencode2-server.service` (8.0G memory peak,
  393.1M swap peak).
- 20:18:34: systemd sent SIGKILL to the unit after its stop timeout.
- 20:18:39–20:18:43: the server restart stopped and restarted workflowd.
- Subsequent starts blocked on the unresponsive reviewer and exhausted the
  startup deadline before acquiring the listener or starting dispatch workers.
- 23:03:05: the reviewer ignored SIGTERM; after its 90-second stop timeout it
  was SIGKILLed and restarted at 23:04:35.
- 23:04:37: the new reviewer produced the **single** `agentCount: 0,
  modelCount: 0` snapshot, two seconds after starting.
- 23:04:39: workflowd listened successfully, about four seconds after the
  reviewer restart.

The blocking startup validation and deployed `Restart=always` turned a hung
reviewer into a daemon-wide outage. Commit `e10a094` and its cold-catalog
regression reproduce a different failure mode (prompt empty responses), not
this hang.

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
this patch addresses blocking startup and ongoing reviewer availability. A hung
reviewer needs an operator restart; workflowd does not restart it. Watchdog
proposal: `workflowd-7vhr` (trigger, restart action, cooldown and risks).

## Behavior, verification, and limits

Review and fix availability run in separate daemon-scoped background fibers.
Each read is capped at 10 seconds. Failed checks use capped exponential delays:
2, 4, 8, 16, then 30 seconds. Successful checks continue every 30 seconds; a
later failure closes that lane's gate again. Recovery resets the failure delay.
If a job in flight reports an OpenCode timeout or transport error, the worker
checks that lane at once. If the check closes the gate, the job is queued again
and its attempt count is restored. Other failures use the normal attempt limit.
If session abort fails, the session must be cleaned up before another claim.
There is no fatal startup deadline.
The listener, kernel workers, health and dispatch services start immediately.
Claims filter review/fix job kinds before acquiring a lease, so paused work
keeps its attempts. A missing fixer does not block reviews. Expired-session
cleanup and disabled-fix retirement continue during outages. Existing command
and publication workers also continue.

`GET /health` exposes `reviewAutomation` and `fixAutomation`, each with status
`unavailable`, `unreachable`, `misconfigured`, `available`, or `disabled`.
A hung read becomes `unreachable` with `reason: "timeout"`; empty catalogs
remain `unavailable`. A non-empty catalog missing a configured selection must
return the **same** missing selections on two consecutive checks before
`misconfigured` is reported. The `missing` list names the agent or model.
This classification is local to background monitoring; shared validation
callers keep their retry behavior during catalog registration.

Unavailable, unreachable or misconfigured automation degrades the health body,
while HTTP 200 remains a liveness signal. `curl --fail` alone cannot verify
readiness. After deploys check `reviewAutomation.status == "available"` (or
`disabled` in execution mode), the fix status when enabled, and overall `status`;
the README includes a `jq -e` example.

The loop logs `available` only when the status changes. It logs other changes
and at most one warning per minute when the status does not change. Timeout
warnings state that an operator restart is needed. Defects are caught, safely
logged and retried. Interruption still stops the scoped fiber. Shared adapter calls retain every safe endpoint
and catalog diagnostic, including later QRSPI failures. Nested request causes
and credential-bearing URLs are excluded from background health/logs.

Regression tests use scripted in-memory catalogs with Effect's virtual clock
for empty catalogs, capped backoff, selection confirmation, recovery, defects,
and failure after success. The HTTP test uses the SDK with an Effect HTTP
transport that never replies. A Deferred confirms that the request started
before virtual time advances. The test checks the worker claim path and keeps
the first attempt after recovery. It does not use an OS socket. Tests for jobs
in flight cover timeouts, transport errors, failed aborts and the last attempt.
Daemon route tests retain accepted dispatches during warmup. Store/worker tests
verify separate claims, untouched attempts, cleanup and disabled-fix retirement.
The unused blocking startup helper and its tests were removed; relevant
availability cases now exercise the continuous background path. No live
OpenCode or GitHub services are needed for these tests.
