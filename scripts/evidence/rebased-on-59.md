## Rebased on #59

[Full redacted logs and cleanup verification — secret Gist](https://gist.github.com/BNasraoui/63b1a386e33deb178dd16754709234a1)

Rebased onto `dc8291e` and force-pushed with lease. One-shot `codex exec` keeps #59's transient systemd custody, recovery and cancellation. Resident Codex threads keep #57's supervisor and run-bound process roots; OpenCode retains its session-bound mailbox and completion supervision. Transient recovery excludes durable resident custody. Resident completion is no longer also handled by the one-shot completion loop. Broker authentication registers the verified transient invocation's process root on launch and reattachment.

Main's cancellation migration remains 0020; CI and resident storage follow as 0021/0022, with OpenCode mailbox migration 0023. Cancellation retains both PRs' transition semantics and diagnostics.

Live runtime source: `6044990`. The subsequent `bff113e` only makes the pre-existing heartbeat test use controlled authority time and assert actual lease renewal; no runtime or harness behavior changed. `bun run check` passes: 332/332 Effect files checked, 1,490 tests, zero failures, all quality and complexity gates. All 14 PR checks pass on `bff113e`.

| # | PR #57 scenario | Result |
|---|---|---|
| 1 | CI success and new turn | PASS |
| 2 | CI failure includes failing jobs | PASS |
| 3 | Duplicate webhook delivers once | PASS |
| 4 | Late subscription | PASS |
| 5 | Two worker threads | PASS |
| 6 | Agent-run completed and cancelled | PASS |
| 7 | Cross-run peer credentials | PASS |
| 8 | Mailbox failure requires operator | PASS |
| 9 | Restart between persist and deliver | PASS |
| 10 | Unconfigured repository ignored | PASS |
| 11 | Defaults off uses transient exec | PASS |
| 12 | OpenCode resident completion | PASS |

Rows 1–11 are from the complete isolated run. Row 12 passed in a scoped rerun of scenarios 7 and 12 after the first OpenCode provider returned an upstream 504 idle timeout. The retry registered during the initial turn, ended that turn, and received exactly one delivered cancellation continuation. The original failed attempt remains in the full logs. Row 9 proves a resident thread resumes after a scratch workflowd crash and receives exactly one queued result.

| Scenario | Result | Detail |
|---|---|---|
| 1. Survive restart (controlled worker) | PASS |  |
| 2. Restart during launch | PASS |  |
| 3. Worker exits while host is down | PASS |  |
| 4. Absent and reused units | PASS |  |
| 5. Cancellation with SIGTERM-trapping child | PASS |  |
| 6. Partial JSON output line | PASS |  |
| 7. Output bound and retention cleanup | PASS |  |
| 8. Manager unavailable, identical retry | PASS |  |
| 9. Defaults and non-Codex route separation | PASS |  |
| 1b. Real short Codex model turn | PASS |  |

The #59 runner used `--full`: the actual `src/main.ts` daemon, transient units, scratch SQLite and a real short Codex turn. The real worker retained its launch and invocation identities across restart and completed exactly once. Its non-Codex route-separation case uses the committed protocol fixture; real OpenCode mailbox execution is separately proven by #57 row 12.

Only the same two existing cheap Required checks jobs were manually rerun, on `BNasraoui/workflowd`:

- [Success run 36519322157, attempt 3](https://github.com/BNasraoui/workflowd/actions/runs/36519322157/attempts/3), job `109643033666`.
- [Failure run 36519200648, attempt 3](https://github.com/BNasraoui/workflowd/actions/runs/36519200648/attempts/3), job `109643036563`.

Original App webhook signatures were verified before local replay. No workflow, branch, or commit was created to manufacture CI fixtures. No App settings changed.

Earlier attempts are retained: the installed Codex launcher changed during the first run; a pinned scratch copy initially lacked its companion tool host; the first real-worker restart assertion had too short a window. Final runs used a complete pinned scratch executable set and a bounded longer restart window.

Cleanup verified 31 recorded scratch units inactive and zero remaining owned processes. All copied App credentials, webhook secrets, Codex auth, scratch databases/homes and executables were deleted. Logs were scanned against 39 known-secret variants and credential patterns before publication. Production services, ports, databases, NATS and configuration were untouched. Nothing was merged or deployed.
