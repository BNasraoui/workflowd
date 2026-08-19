# Operational status

`/health` answered `{"status":"ok"}` from the moment the listener bound its
port. It said the process was up. It did not say the workers were working, that
the durable store still answered, or that jobs, publications, commands and
reconciliations had been quietly piling up in terminal failure. An operator
could not tell a functioning controller from a live process accumulating failed
work, and there was no procedure for putting failed work back.

This is where those answers live now.

## Owning modules

| Concern                                        | Module                        |
| ---------------------------------------------- | ----------------------------- |
| Whether each supervised lane is working         | `src/worker-health.ts`        |
| Terminal queue failures and safe retry          | `src/store/queue-health.ts`   |
| The readiness answer assembled from both        | `src/operational-status.ts`   |
| Inspect and retry from a shell                  | `scripts/failed-work.ts`      |

## Liveness and readiness

`GET /health` is liveness. It is a fixed answer, so the only thing that can fail
it is a process that is not there. Restart supervision and the deployment smoke
check use it.

`GET /ready` is readiness: the narrower claim that this controller can do the
work it exists to do. It is `200` with `"status": "ready"` when

- the durable store answers, and
- every supervised worker lane has completed an iteration and is not failing,

and `503` with `"status": "not_ready"` otherwise.

Readiness is answered from local state only. It never calls GitHub. A GitHub
outage is not a reason to call this controller unready, and a readiness poll
must not spend the installation's rate limit. The type of `operationalStatus`
enforces this: it requires the store and the worker record, and nothing else, so
a readiness answer that reached for GitHub would not compile.

The response carries counts and statuses. It carries no error text. The listener
is published beyond the tailnet, and a failed job's error can name repositories,
refs and internal paths; that detail belongs in the journal and in the local
operator command instead.

## Worker lanes

A supervised lane never exits. `superviseWorker` catches every iteration
failure, logs it and loops, which is what keeps the listener answering while a
broken local dependency makes every claim fail. Supervision is therefore the
only place that sees whether a lane is working, and it is where the record is
written.

Each lane is `starting` until it completes its first iteration, then `ok`, and
`failing` once it has failed `consecutiveFailuresBeforeFailing` iterations in a
row without a success in between. That threshold matches the retry budget the
durable queues use, so a lane is called failing at the point a piece of work
would have spent its own attempts. One success clears the streak.

A lane is shared by every worker running it, so one worker's success clears the
lane. That is the intended reading: the lane is still making progress even if
one of its workers is not.

## Terminal queue failures

`failed` and `data_error` are the Work States that owe an outcome no worker will
produce. `/ready` reports, per queue, how many of each there are and when the
oldest one landed, plus the count of agent sessions whose cleanup exhausted its
attempts and left `cleanup_disposition = 'operator_required'` — those hold their
job even after it fails.

These counts do not decide readiness. Failed work is a backlog for a person, not
a reason to restart or depool the process: no restart clears it, and the remedy
is a human deciding to put it back.

## Safe retry

`scripts/failed-work.ts list` names the failed records; `retry <queue> <id>`
puts one back. A retried record returns to `ready` with its attempts reset, and
the worker claims it on the next poll.

Eligibility asks the same fencing question the claim query asks, through the
same fragment in `src/store/currentness.ts`. That is the point: a record
reported eligible is one a worker will actually pick up, rather than one that
returns to `ready` and is skipped forever.

| Eligibility             | Meaning                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `eligible`              | Retry returns it to the queue.                                               |
| `quarantined`           | `data_error`: the record cannot be read, so a retry only re-quarantines it.  |
| `superseded`            | A newer Generation, Review Request or pull-request state took precedence.    |
| `agent_session_pending` | A live agent session still owns the job; cleanup has to release it first.    |

Commands and Reconciliations answer an observation that already happened.
Nothing supersedes them, so for those queues only quarantine disqualifies a
retry.

## Where this policy stops

The QRSPI kernel queues run their own lifecycle with their own states, waits and
gates. `docs/qrspi-stage-runtime-design.md` keeps their durable diagnostics
queryable by their own stores and leaves aggregation to this module; projecting
them here would take ownership of a lifecycle that is not this module's. They
are not counted in `/ready` today.

This module also holds no capacity policy. Cumulative database and workspace
growth remains the unaccepted residual risk recorded in the QRSPI stage runtime
design, and counting terminal failures does not resolve it.
