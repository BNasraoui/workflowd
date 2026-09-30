## Evidence (CI and OpenCode)

All 12 scenarios passed in the final isolated run, 2026-09-29 05:20–05:26 UTC.
Runtime/source head: `fa7778d`; subsequent `95969d4` only hardens the wrapper to
launch the same absolute Bun executable. No production service was accessed,
reconfigured, restarted, or signalled.

App preflight passed: one unsuspended installation, repository access exactly
`BNasraoui/workflowd`, Actions read accepted, Workflow run and Check suite events
subscribed, and fresh webhook deliveries receiving HTTP 202. No App setting changed.
The scratch CI policy contained exactly that repository. Original delivery bytes
were reconstructed from the App deliveries API and matched their original
`X-Hub-Signature-256` signatures before replay. CI conclusions came from workflowd's
real App API reconciler, not from seeded database rows or webhook conclusions alone.

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | CI success and new turn | PASS | Signed webhook persisted by 202, JetStream receipt, one inbox message, two distinct turns, success reply |
| 2 | CI failure includes failing jobs | PASS | Failure and all expected job names delivered |
| 3 | Duplicate webhook delivers once | PASS | One persisted receipt, NATS completion, mailbox message and continuation |
| 4 | Late subscription | PASS | Existing terminal CI state queues one message immediately |
| 5 | Two worker threads | PASS | Two distinct threads each received one continuation |
| 6 | Agent-run completed and cancelled | PASS | Real completed run and real store administrative cancellation each delivered once in a new turn |
| 7 | Cross-run peer credentials | PASS | Unrelated process denied 403 on subscription and token sockets |
| 8 | Mailbox failure requires operator | PASS | Owned app-server stopped before queue call; operator_required persists, one attempt across six retry intervals |
| 9 | Restart between persist and deliver | PASS | Real terminal run state persisted before owned daemon crash; restart resumed thread and delivered exactly once |
| 10 | Unconfigured repository ignored | PASS | No receipt, CI delivery or NATS message (stream 5 → 5) |
| 11 | Defaults off uses legacy exec | PASS | Real codex exec --json dispatch completed; no resident thread |
| 12 | OpenCode resident completion | PASS | Separate credential-free OpenCode server: registered, ended subscription turn, one durable delivered inbox and one cancellation reply |

Key excerpts and scope:

- `05:21:27.733 RESULT ci-success: success; failing jobs: none.`
- `05:22:28.469 RESULT ci-failure: failure — Required checks; Dependency audit`
- `05:22:39.052 RESULT ci-late: success; failing jobs: none.`
- Distinct subscribers replied at `05:22:51.053` and `05:23:02.180`. Each CI
  subscriber used `subscribe_to_event`, ended its registration turn, then received
  exactly one mailbox queue request and replied in a second, distinct turn.
  Replaying the original success delivery produced no extra receipt/message/turn.
- `05:24:52.906 RESULT restart-parent: cancelled — isolated evidence administrative cancellation.`
  Scenario 9 proves recovery after persisting an agent-run terminal event and before
  inbox creation; it does not claim a separate CI reconciliation crash test.
  Scenario 7 uses an unrelated caller process to verify 403 on both protected sockets.
- OpenCode registered through the session-bound `subscribe_to_event` shell interface
  using an absolute Bun path. Its subscription turn had ended at `05:25:18.205`.
  After cancellation, the separate scratch server produced at `05:26:00.978`:

  ```text
  RESULT opencode-mailbox
  status: cancelled
  summary: 01a0eb9e-71d1-74b3-89f6-521a21bb5c53
  ```

  One durable subscription inbox row was delivered and one continuation reply was
  recorded. This used a credential-free OpenCode catalog model and required no
  additional credentials. It is live evidence, not just an integration-test claim.

Only these existing CI jobs were manually rerun, both on PR #57's existing branch
`fix/agent-inboxes-ci-events`, with no workflow file, branch, or commit created to
manufacture a CI completion:

- [CI run 36519322157, attempt 2](https://github.com/BNasraoui/workflowd/actions/runs/36519322157/attempts/2),
  SHA `30b89d85`, success. Original `Required checks` job `109248836464` was rerun
  as `109262153622`, 04:55:23–04:55:25 UTC. Original delivery GUID
  `fc9b1460-bbc1-11f1-8a07-babc76cb586c`.
- [CI run 36519200648, attempt 2](https://github.com/BNasraoui/workflowd/actions/runs/36519200648/attempts/2),
  SHA `a7ef0962`, failure. Original `Required checks` job `109248486477` was rerun
  as `109262157041`, 04:55:23–04:55:27 UTC. Existing failed dependency results were
  retained, including `Dependency audit`. Original delivery GUID
  `fd5a6cc0-bbc1-11f1-803a-2523dbfe5731`.

The chosen gate job was the cheapest suitable existing check (previous duration
four seconds). All later local evidence retries replayed those same original
signed deliveries; they did not rerun GitHub CI again.

Changes and validation:

- Added the owner-authorized App replay wrapper and updated the committed harness
  for original signatures, the exact repository policy, bounded OpenCode startup,
  absolute executable paths, scoped reruns, and real OpenCode session evidence.
- Live testing exposed first-token verification reading zero session totals while
  assistant steps already contained generated tokens. `fa7778d` fixes this by
  reading at most 20 recent messages only for an active session with zero totals.
  The new SDK transport regression failed with 0 instead of 357 tokens before the
  fix and passed afterward. Existing nonzero totals and idle semantics are retained.
- Earlier OpenCode attempts exposed a missing shell PATH entry, unavailable catalog
  model, and a priming turn completing custody before subscription. Those attempts
  remain in the full logs. The final passing case subscribes during the initial
  dispatch turn and needs no priming workaround.
- `bun run check` passed: typecheck, 321/321 Effect diagnostics, skill sync, knip,
  lint, formatting, **1,460 tests / 0 failures**, and CRAP gate. The launch-path
  hardening passed targeted lint/format checks; SonarCloud's quality gate is now OK.

Cleanup verified: all seven scratch runs stopped; the final run accounted for
10 directly started processes and 22 tracked descendants. No running process has
any of these scratch working directories. All copied App keys, webhook secrets,
App-ID files, Codex auth files, session databases/configuration, generated tokens,
and downloaded delivery signatures were deleted. Only redacted logs remain.
The final scan checked 60 log files against 26 known-secret/encoded variants plus
credential patterns and found no issues.

Full logs: [new secret Gist with full redacted logs](https://gist.github.com/BNasraoui/1d7a65a0ddc0be9065c3e64c67445390)
