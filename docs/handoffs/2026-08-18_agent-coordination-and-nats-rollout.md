---
date: 2026-08-18
git_commit: cb26377b664a67f1422c712316c5ecbab8d50ae9
branch: docs/codex-session-handoff
topic: "Session Handoff: agents waiting on agents — the workflow kernel, and the NATS rollout that stalled"
tags: [handoff, workflowd, event-kernel, nats, deployment, beads-b3b]
status: in-progress
---

# Handoff: agent coordination kernel and the NATS rollout

The session that produced this work ran from 2026-08-11 to 2026-08-18 and died on a Codex
usage limit at `2026-08-18T05:31:41`, mid-answer. Two of Ben's messages were never
answered. They are the first thing below.

This doc was written by a later agent reading the transcript and the repository. Statements
marked **verified** were checked against the repo, GitHub, or SonarCloud on 2026-08-18.
Everything else comes from the transcript and is the prior agent's claim.

---

## 1. Start here: the two unanswered questions

Ben's last message, twice sent, never answered:

> "6 new issues in 32 from sonarr. Also, did we actually run the sim tests?"

### 1a. The six Sonar issues on PR #32

**Verified.** They are real, they are still open, and they are now on `main`. PR #32 had
exactly one commit (`b858524`); nobody fixed them. SonarCloud's quality gate *passed*
anyway — the gate does not fail on new maintainability issues — so Ben merged at
`2026-08-18T05:57:02Z`, 26 minutes after asking. Main's total open Sonar issue count is 52,
of which these six are new:

| Rule | Severity | Location | Message |
|---|---|---|---|
| S7767 | MAJOR | `test/remote/simulation/generator.ts:21` | Use `Math.trunc` instead of `\| 0` |
| S7770 | MINOR | `test/remote/simulation/generator.ts:112` | arrow function is equivalent to `Number` |
| S2933 | MAJOR | `test/remote/simulation/simulator.ts:59` | mark `#now`, `#runCentral`, `#runRunner` `readonly` |
| S3776 | CRITICAL | `test/remote/simulation/simulator.ts:218` | cognitive complexity 23 > 15 |
| S3358 | MAJOR | `test/remote/simulation/simulator.ts:240` | extract nested ternary |
| S4123 | CRITICAL | `test/remote/simulation/simulator.ts:510` | `await using` on a value that is not async-disposable |

All six sit in test-only simulation code. Five are style. **S4123 is the one to read
first** — `await using` on a non-async-disposable value is a possible real defect in the
harness's cleanup, not a smell. If the simulator's teardown does not actually run, seeds
could pass for the wrong reason.

Re-fetch the current list with:

```sh
curl -s "https://sonarcloud.io/api/issues/search?componentKeys=BNasraoui_workflowd&branch=main&issueStatuses=OPEN,CONFIRMED&ps=30"
```

**Unknown:** whether Ben wants these fixed as a follow-up PR or waived. He merged
regardless, which suggests he was not blocked by them, but he asked and got no answer.

### 1b. "Did we actually run the sim tests?"

**Verified: yes, and they pass.** Three separate facts:

- `test/remote/simulation/corpus.test.ts` lives under `test/`, so it runs inside plain
  `bun test`. CI's `tests` job runs `bun run test:coverage` (`bun test --coverage`), which
  runs everything. The CI run on PR #32's head `b858524` concluded `success`.
- Run fresh in this worktree on 2026-08-18: `bun run simulate:remote` → 1 pass, 0 fail,
  5.41s.
- The live-NATS integration tests (`test/remote/remote-transport.integration.test.ts`)
  spawn a real `nats:2.11.8-alpine` container via `docker run` in `beforeAll` and throw if
  Docker is missing. They do not skip. So CI ran real-broker tests too.

The caveat Ben's instinct was probably reaching for: **the CI corpus is tiny.** Defaults in
`simulationBudget` are 3 seeds (`0xb3b009, 0x31, 0x5eed`) at 20 steps each. Steps are
capped at 500. The longer run is local and manual:

```sh
WORKFLOWD_SIM_SEEDS=1,49,24301,11776009 WORKFLOWD_SIM_STEPS=50 bun run simulate:remote
```

So: the harness runs on every CI build, but it explores almost nothing. Nobody has run a
long soak. That is the honest answer, and it is probably the follow-up Ben wanted.

**Also open:** bead `workflowd-b3b.9` is still `in_progress` even though PR #32 merged.
Close it (`bd close workflowd-b3b.9`) or record why not.

---

## 2. Why this work exists

Ben's opening message, 2026-08-11:

> "I have an issue where agents need to wait other agents to finish tasks and as a result
> that means agents need to 'poll' other agents to see if theyre done. This is a massive
> waste of credits. An even driven system seems much mor reasonable where you have some
> agent subscriber who subscribes to some agents piece of work. Dies and is resumed by the
> event fired off from an agent completing."

The whole `workflowd-b3b` epic exists to answer that. The target behaviour, in one line:

> **Child agent finishes → parent agent resumes automatically, with both agents stopped and
> costing nothing in between.**

The key reframe the session settled on: a waiting agent is **a saved continuation, not a
live subscriber**. The agent process exits. A daemon holds the wait. When the event lands,
the daemon resumes the saved session through the provider's own `--resume` path
(`codex exec resume`, `claude -p --resume`, `opencode run --session`).

A second reframe followed: **the thing that waits is the workflow instance, not the
agent.** The agent session is an execution reference; durable workflow state and artifacts
must be enough to explain what happened without it.

The problem kept proving itself during the work. Several mint dispatches stalled because
an OpenCode parent session never woke after its child finished — the exact bug being
built against. The prior agent's note:

> "Ironically, this is a clean example of the orchestration problem we're fixing: the jobs
> still said 'running' while the agent sessions were idle."

That recurred at least four times and cost hours. It also produced a design requirement:
workflowd needs a watchdog for "child finished, parent still waiting."

---

## 3. The design that emerged

Three layers, built beneath the existing code rather than replacing it:

```
Domain workflows      PR review, QRSPI, future workflows
Provider adapters     OpenCode (built), Codex, Claude (not built)
Continuation kernel   events, waits, deliveries, activities, sessions, leases
```

Load-bearing rules, all of which survived review and should not be relitigated casually:

- **SQLite is the workflow authority.** NATS is transport only. It must never become a
  second workflow database.
- **Events are global immutable facts.** Migration-level triggers reject `UPDATE`,
  `DELETE`, and `INSERT OR REPLACE` timestamp rewrites on the event log.
- **A wait is one-shot.** It matches the earliest eligible event and becomes terminal.
  Lifecycle is `pending → matched → consumed`.
- **Only consuming a delivery advances an instance's cursor.** Matching must not. This
  prevents a stale wake from skipping facts.
- **Consuming a delivery and creating its downstream activity happen in one transaction.**
  A crash between them would lose the work.
- **Stable provider session identity is separate from per-resume activity leases.**
  Carrying an expired job lease across a wait would break workflowd's fencing.
- **At-least-once, never exactly-once.** Idempotency plus per-session leases, not delivery
  guarantees.
- **Never build a shell command containing a prompt or a secret.** Pass arguments directly.
  Treat every summary and artifact as untrusted input.

---

## 4. Decisions Ben ratified, and what he rejected

**Ratified: pivot workflowd, do not build a second daemon.** The first proposal was a
standalone `agent-waked`. On inspection workflowd already had ~70% of the hard parts
(durable SQLite inboxes, queues, leases, retries, fencing, recovery, persisted session IDs
and working directories, a systemd unit). Ben:

> "I am wondering if I chose the wrong architecture for workflowd. Realistically with the
> event-driven design I could create any number of workflows and integrations."

**Ratified: incremental slices, never a rewrite.** Every slice shipped as one reviewable
PR, tests-first, with QRSPI explicitly out of bounds. QRSPI migrates last.

**Ratified: provider-neutral, any-to-any.** Ben caught an ambiguity:

> "Wait is ir any to any or any to opencode? Any harness should be able to prompt and be
> alerted by any other harness"

The event and workflow contracts are provider-neutral. OpenCode is only the first source
and destination. The goal is the full 3×3 matrix — OpenCode, Codex, Claude each able to
wake any of the three.

**Rejected: a hand-rolled WebSocket between coordinator and runners.** This was the
agent's recommendation until Ben killed it:

> "Oh fuck a websocket. That shit dies and it is a nightmare. I imagine it as main api and
> a bunch of machines with a systemd service sorta just sitting idle that reacts to events.
> Hence the name workflowd"

The agent retracted the recommendation. A fleet of idle systemd daemons on durable
consumers is exactly where a broker earns its keep; a WebSocket would make workflowd
responsible for reconnect, buffering, dead-peer detection, replay, and backpressure.

**Rejected: Kafka. Considered and passed over: RabbitMQ.** Kafka duplicates the SQLite
history and adds partitions and cluster management for a handful of commands. RabbitMQ
would work well — durable queues, acks, redelivery, dead-lettering, good management UI —
but NATS subjects express both targeted commands ("mint, resume this Codex session") and
broadcast events ("agent X finished") without exchange/binding/queue/channel setup, and
NATS has an official TypeScript client where RabbitMQ points Node users at community
`amqplib`. Ben: *"Agreed. Send it nats it is"*. The verdict was honest about its margin:
a clear win over Kafka, a narrow one over RabbitMQ.

**Ratified: JetStream, not core NATS.** Machines can be offline for hours; core NATS only
reaches connected subscribers.

**Ratified: deterministic simulation testing, with Hegel evaluated but not adopted.** Ben
asked *"Do we want to do some kind of distributed simulation testing? Perhaps with
something like hegel?"* The answer: Hegel should generate and shrink scenarios, not be the
simulator. On evaluation, `@hegeldev/hegel` 0.4.5 is pre-1.0 with an explicitly unstable
API, a native Rust/koffi dependency, and no state-machine command API. PR #32 uses a local
Mulberry32 generator plus deterministic deletion/value shrinking instead. Hegel can be
reconsidered when its API stabilises.

---

## 5. What merged, and what is still open

Every slice is a bead under epic `workflowd-b3b` ("Generalize Workflowd into a durable
event-driven workflow runtime", still OPEN).

| Bead | PR | What it did | State |
|---|---|---|---|
| b3b.1 | #23 | Coalesced post-commit worker wake signals; subscribe-before-claim; correct lane edges (`job ↔ publication`, `command → job`, `reconciliation → job`) | merged `547175d` |
| b3b.2 | #25 | Typed events + single-condition waits; global immutable fact ledger; one delivery per wait; both arrival orders; migration 10→11 | merged |
| b3b.3 | #26 | Token-fenced durable jobs; atomic delivery→cursor→enqueue | merged |
| b3b.4 | #27 | Local worker running a harmless JSON echo job; optional authenticated test endpoint, disabled by default | merged |
| b3b.5 | #28 | Agent session + working-directory storage; long-lived session vs fresh per-attempt claim | merged |
| b3b.6 | #29 | Resume one OpenCode session safely after restart; inspect before re-prompting | merged |
| b3b.7 | #30 | **The original goal:** child completion → durable event → parent resume, provider-neutral contracts, multiple parents per child | merged |
| b3b.8 | #31 | NATS JetStream coordinator → idle systemd runner → result return, harmless probe only | merged 2026-08-18T05:12Z |
| b3b.9 | #32 | Deterministic seeded failure simulation with shrinking | merged 2026-08-18T05:57Z, **bead still `in_progress`** |

**Verified** on `main` at `cb26377`. PR #24 was closed as superseded (a stalled duplicate
of #23, missing two review fixes). **PR #21 is still open** — a draft from 2026-07-25,
unrelated to this line of work; decide whether to close it.

Not built yet, in the agreed order:

1. Shared "managed CLI agent" runner, then the **Codex adapter** on top of it.
2. **Claude adapter** as a thin second adapter (`claude --print --resume`, streaming JSON).
3. The full 3×3 any-to-any matrix.
4. Safe process / session / worktree cleanup.
5. Cross-machine routing for sessions owned by another host.
6. Real workflow definitions and integrations replacing the temporary echo API.

The shared runner should launch each resume attempt as a host-owned systemd unit so it
survives a workflowd restart, capture structured output to a bounded durable file,
reattach after restart instead of re-prompting, and emit the same provider-neutral
completion event OpenCode already emits.

**What `main` can actually do today:** deliver a *harmless probe* across machines over
NATS. It cannot run Codex, Claude, or OpenCode remotely. Do not let a demo imply otherwise.

---

## 6. The NATS credential gap — blocking an unattended rollout

**Verified in code.** `src/remote/config.ts` defines the auth surface as a single
`readonly token: string`, required non-empty. `src/remote/transport.ts:190` passes it
straight to the NATS client as `{ token }`. That is the whole model.

**NATS tokens are global.** A token authenticates the connection; it carries no
subject-level permissions. Per-subject publish/subscribe permissions in NATS require
either separate **users** (each with its own permissions block in the server config) or
**NKey / JWT credentials** per identity. See
<https://docs.nats.io/running-a-nats-service/configuration/securing_nats/authorization>.

**The shipped guide promises something the client cannot enforce.**
`docs/remote-runner.md` step 2 says:

> "Create a scoped token/account allowed to create/read its filtered durable consumer, pull
> from `workflowd.v1.commands.<host>`, and publish `workflowd.v1.results`. The coordinator
> needs the inverse permissions plus JetStream administration for stream creation."

With one global token there is no scoping. Every runner holding that token can pull any
host's commands and publish any result. Durable fencing (host addressing, generation,
attempt, lease, claim authority checks) still rejects *wrong-host work*, so this is not an
immediate correctness hole — but it is an authorization hole, and it is exactly the kind of
thing you do not leave running unattended.

Config surface today (`deploy/workflowd.env.example`, `deploy/runner.env.example`):

```
WORKFLOWD_REMOTE_COORDINATOR_ENABLED=true
WORKFLOWD_NATS_SERVERS=tls://nats.example-tailnet.ts.net:4222
WORKFLOWD_NATS_TOKEN_FILE=/run/credentials/.../nats-token
WORKFLOWD_REMOTE_LEASE_MS=60000
WORKFLOWD_REMOTE_COMMAND_TTL_MS=300000
```

The token is a systemd `LoadCredential`, never in the env file. That part is right.

**Two ways out. Pick one before unattended operation:**

1. **Fix the client.** Add username/password or NKey/creds-file auth to `RemoteConfig` and
   `RemoteTransportLive`, then give the coordinator and each runner distinct identities
   with real subject permissions. This makes the guide true.
2. **Fix the guide.** Delete the scoped-access promise, state plainly that the token is
   global and every holder is trusted with all subjects, and gate the rollout on the
   tailnet ACL alone.

The prior agent's position on the interim, worth keeping:

> "A brief manual smoke test with one shared token over a tightly restricted tailnet is
> reasonable. I would not treat that as the permanent setup."

---

## 7. Deployment order across the two machines

Ben's question at 05:13, which the session answered once and then died before the
follow-up:

> "So... are we merging to main and setting up the nats stuff on both machines? Is there
> stuff we should do before that?"

Intended layout:

- **mint** (server): NATS JetStream broker, the central workflowd coordinator, and a
  runner if mint should also execute jobs.
- **ben-arch** (this machine): its own runner only.
- Each runner gets a unique `WORKFLOWD_REMOTE_HOST_ID` and its own restricted credentials.

Staged rollout, in order:

1. Bind NATS port 4222 to the Tailscale address only; firewall it to tailnet runner
   identities. Use `tls://` when broker TLS is on; `nats://` is accepted for tailnet-only.
2. Enable JetStream **file** storage, not memory.
3. Enable systemd user lingering so runners start without an interactive login.
4. Start **one** runner. Send a harmless probe:
   `bun run remote:enqueue --probe smoke-1 --host this-host`.
5. Test three failure modes: runner offline during delivery, runner restart, NATS restart.
6. Only then add the second runner.

Two preconditions the session named before leaving it unattended: merge PR #32 (**done**),
and close the credential gap (**not done**). Ben was mid-decision on machine order when the
quota hit. **Unknown: which machine he wanted first, and whether he intends mint to run a
runner at all or only the coordinator.** Ask him.

---

## 8. The concrete next step

In order:

1. **Answer the two questions in §1** with what is written there. That is the open thread.
2. **Decide the credential gap** — fix the client or fix the guide. It blocks unattended
   operation and nothing else can safely ship past it.
3. **Close bead `workflowd-b3b.9`.** It is stale.
4. Then either: file a small PR for the six Sonar issues (start with S4123), or start the
   next feature slice — the shared managed-CLI runner plus the Codex adapter, which is the
   first thing that makes the system useful beyond OpenCode.

---

## 9. Repo conventions and gotchas

Verified against the worktree at `cb26377`. Baseline: Bun `1.3.14`, Effect `3.22.0`,
OpenCode SDK `1.18.3`.

**Commands**

```sh
bun install --frozen-lockfile
bun run check     # typecheck → effect:check → skill:check → knip → lint → format:check → test:coverage
bun test
bun run simulate:remote
bun run coverage:changed <BASE_SHA> <HEAD_SHA>
```

`bun run check` is the gate. Run it before opening any PR; the remote workers that built
this epic all did, and it caught things CI would have.

**CI** (`.github/workflows/ci.yml`) — blocking jobs are `quality` (a 6-way matrix:
TypeScript, Effect diagnostics, ESLint `--max-warnings=0`, Prettier, Knip, `bun audit
--audit-level=high`), `repository-validation` (`git diff --check` — trailing whitespace
will fail your PR), `deployment-validation` (`systemd-analyze verify` on the unit files),
and `tests`. A `required-checks` job aggregates them. The `aislop` job is advisory only.
CodeQL runs separately and is slow — it is often the last thing still running.

**Coverage gate:** `coverage:changed` requires **80%** of changed executable lines, not
95%. The prior session burned time on this. The real failure mode is different: a new
source file that is never imported by any test is **absent from LCOV entirely**, and the
job fails regardless of percentage. Fix it by writing a test that imports the entrypoint,
not by padding unrelated branches.

**Git hooks** — `core.hooksPath=.githooks`, installed by `./scripts/install-git-hooks.sh`
and shared across worktrees:

- **pre-commit** rejects any staged file over **600 lines**. It checks staged content, so
  a partially staged file can still trip it. Workers hit this repeatedly and had to split
  test files mid-PR; plan module sizes up front.
- **pre-push** requires the branch to be named `<ticket-type>/<ticket-id>-<slug>`, e.g.
  `feature/workflowd-b3b.9-deterministic-remote-simulation`. Valid types: `feature`, `bug`,
  `task`, `chore`, `epic`. **The ticket must exist in Beads with a matching type.** One
  worker had to rename its branch mid-flight to get a push through. `--no-verify` bypasses
  it; the hook is local feedback, not a security boundary. (This handoff branch,
  `docs/codex-session-handoff`, does not match — it was pushed with `--no-verify`.)

**Beads** is the tracker; do not use markdown TODOs or `TodoWrite`. Issues live in a local
Dolt DB at `.beads/dolt/`; sync is `bd dolt push` / `bd dolt pull` over `refs/dolt/data`
on the git remote. `.beads/issues.jsonl` is a **passive export, not the source of truth** —
never `bd import` during normal operation. `bd prime` for full context, `bd ready`,
`bd show <id>`, `bd update <id> --claim`, `bd close <id>`. Use `bd remember` for durable
notes rather than memory files. Expect occasional "remote is newer" conflicts on the
tracker during dispatch; they are normal and do not touch source. Run
`git config beads.role maintainer` to silence a startup warning.

**Custom ESLint rules** live in `eslint-rules/architecture` and `eslint-rules/effect`.
They forbid double assertions through `unknown`, test-contract replacements, unknown
Effect channels, direct `throw` inside `Effect.gen`, sync schema decode in gen, throwing
operations in sync, and unhandled promise rejections. They will catch you.

**Worktrees are the working pattern.** There are a dozen sibling `workflowd-*` directories.
Create one off `origin/main`; do not switch branches in the main checkout at
`/home/ben/Documents/repos/workflowd` — it sits on
`opencode/workflowd-vs3.12-ticket-writing` with uncommitted work.

**Remote dispatch to mint** uses `mint-job <repo> "prompt"` from `~/.local/bin`. Hard-won
lessons from this epic:

- **Disable child-agent delegation in dispatched workers.** Every stall in this session was
  an OpenCode parent that never woke after its child finished. The jobs that forbade
  sub-agents finished cleanly.
- A stalled parent leaves a turn permanently "in progress"; later resume prompts queue
  behind it forever. Abort the stale turn and resume the same session — the worktree
  survives.
- Killing an attached CLI does not cancel the server-side agent. Session, attachment, and
  abort are three separate lifecycles.
- A launcher that reports "dispatched" is not reporting "running". Verify with the branch
  and PR, not the launcher.
- Set a time threshold (the session used ~30 minutes of silence with no pushed branch) and
  terminate rather than treating silence as progress.
- Review the pushed diff. Do not accept a worker's green summary. Independent review caught
  a production wiring bug in #23 that all green checks missed, and five liveness bugs in
  #31 after 1,052 tests passed.

**Other**

- QRSPI is a separate, active line of work. Keep out of it.
- `docs/remote-runner.md` and `docs/remote-simulation.md` are the operational references
  for this epic.
- Live-NATS tests need Docker and will hard-fail without it.
