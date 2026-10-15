# Agent Git identity

Configure these variables in the host's workflowd environment file, using the
operator-approved identity and blocklist from host configuration. Do not put real
identity values in repository files, issue comments, PR bodies, or shell examples.

| Variable | Meaning |
| --- | --- |
| `WORKFLOWD_AGENT_GIT_NAME` | Agent author and committer name |
| `WORKFLOWD_AGENT_GIT_EMAIL` | Agent author and committer address |
| `WORKFLOWD_AGENT_GIT_BLOCKED_EMAILS` | Comma-separated addresses forbidden for both roles; case-insensitive; must be nonempty when PR repositories are configured |

Startup fails if agent dispatch or a resident executor is enabled and
either identity field is missing. Partial or invalid configuration, including an
allowed identity on the blocklist, is rejected without echoing address values.
This includes execution-mode daemons with agent runs configured. A daemon without
PR repositories, agent dispatch, or resident executors can omit this configuration. Remote runners
that enable Claude resume directories also require the identity.

Codex and Claude transient units receive all four `GIT_AUTHOR_*` and
`GIT_COMMITTER_*` variables explicitly. Resident Codex receives them on both launch
paths. OpenCode receives them through its session environment API, including when
resident mailbox setup replaces that environment. Local and remote Claude resume
processes use the same configuration.

With agent-user isolation enabled, the root host loads these variables from
`/etc/workflowd/agent-git.env` (root-owned, mode 0600). It requires a complete
identity whenever launch policy is enabled. `HostStart` accepts no caller-selected
identity or environment: `hostLaunchCommand` injects the four Git identity
variables into every fixed profile, including workspace creation, discovery,
preflight, Codex resident servers and Claude resume. The private worker input
carries the blocklist; it is not placed in unit arguments or protocol replies.
The controller and remote runner must also retain their identity configuration
for paths that do not use the host socket.

## Git hooks

After creating an agent worktree, workflowd installs its guard under that
worktree's Git administration directory (`workflowd-hooks`). Installation also runs
when reusing an existing worktree and writes an `agent-worktree` marker inside
that hooks directory. Claude resume refreshes the guard only when that marker is
present. It skips guard installation in operator checkouts, other worktrees, and
non-Git directories without failing; the identity environment variables still
apply. Older agent worktrees acquire the marker when reused for agent dispatch.
The creation command's `-c core.hooksPath=/dev/null` applies only to creation; it
cannot disable the subsequently installed guard. A conditional Git config include selects the hooks
only for the assigned Git directory, leaving the main checkout's hooks alone.
The blocklist is stored in a private, untracked policy file, refreshed atomically.
If higher-priority Git configuration overrides the installed hooks path, setup
fails instead of launching an unguarded run.

The guard checks Git's effective author and committer in `pre-commit`,
`prepare-commit-msg`, and `commit-msg`. This catches an explicit `--author` and
keeps the commit check active with `--no-verify`. `pre-push` separately runs
`git log --format='%ae%n%ce'` over commits reachable from each pushed tip,
excluding the advertised old tip for existing refs and any ref under
`refs/remotes/`, including refs for unconfigured remotes (`--not --remotes`).
Published blocked history brought in by rebasing or merging onto a newer main
therefore does not prevent pushes to new or existing branches. Every scan disables
replace objects and ignores graft files, including an inherited `GIT_GRAFT_FILE`,
so they cannot hide the original commit metadata or ancestry.
Keep these refs current with a fetch before pushing (dispatch fetches origin
before creating worktrees). URL destinations and named remotes use the same
exclusion, checking commits not reachable from any remote-tracking ref.
Deletions need no scan. An unknown old object or failed history inspection refuses
the push; fetch before retrying.

Workflowd runs the identity check before chaining the original repository hook.
Other Git hooks are forwarded, and pre-push forwards the original stdin unchanged.
Replacing a tracked repository hook with an accepting hook therefore does not
replace the identity check.

### Enforcement limits

The hooks prevent accidental identity mistakes. They cannot enforce policy
against an agent that can change Git configuration, local refs, or hook files:

- `git push --no-verify` skips the push check.
- `git -c core.hooksPath=...` and `GIT_CONFIG_*` overrides (including
  `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`, and `GIT_CONFIG_VALUE_*`) can disable
  hooks for commits or pushes after installation.
- The same Unix user can change the guard files or remove the conditional
  `includeIf` configuration.
- Fake `refs/remotes/<remote>/*` tracking refs can exclude blocked commits from
  push scans, even with hooks enabled. The exclusion trusts any ref under
  `refs/remotes/`, including refs for unconfigured remotes, regardless of the push
  destination or remote URL.
  Fetching is operational hygiene, not an enforcement boundary.
- API-created commits, such as GitHub Git commits or Contents API writes through
  `gh api`, never pass through local hooks.
- `git commit-tree` and cherry-pick can create or preserve metadata that the
  commit hooks do not inspect; the push scan catches it only if that scan runs
  and includes the commit.

Enforcement relies on requiring the workflowd App check described below. Local
hook bypasses do not affect its GitHub API scan.

Fix Work workspaces receive the configured identity through OpenCode but do not
install this guard.

The root host creates independent clones through the agent-UID workspace worker.
That worker installs the same guard after checkout. Native launch and Claude
resume refresh guards in marked workspaces as the agent UID, preserving original
hooks. The hooks directory and executables are mode 0700; marker, previous-hook
record and blocklist are mode 0600, owned by the agent. This makes the private
policy readable by that user without widening it to other users. Root never runs
Git against agent-writable metadata. The agent can still change its own hooks or
Git configuration, within the same documented limits above; this is not a
root-enforced or server-side policy.

## Claude account context investigation

Checked against the installed Claude Code 2.1.296 CLI and the supported
[environment variables](https://code.claude.com/docs/en/env-vars),
[settings](https://code.claude.com/docs/en/settings), and
[CLI flags](https://code.claude.com/docs/en/cli-reference) on 2026-10-14.
No supported account-email context suppression setting was found.

`IS_DEMO` hides UI account information; it does not remove model context.
`--exclude-dynamic-system-prompt-sections` moves context into a user message.
The installed binary builds `userEmail` from the OAuth account independently of
whether memory files are loaded. Its transport-specific exception selects a Unix
socket transport, which is not a privacy setting. `--bare` changes authentication
and disables broad functionality rather than providing a subscription-compatible
email control. Replacing the base system prompt is not a supported way to suppress
this separately assembled user context.

The upstream [account-context issue](https://github.com/anthropics/claude-code/issues/81138)
remains open. Workflowd does not edit OAuth account state, switch authentication or
billing paths, or set an unsupported flag. The Git guard remains necessary.

## Operator rollout

1. Set all three variables in the effective environment file for each daemon,
   including execution-mode daemons, the root agent host, and Claude runner. Read the approved identity
   from host configuration and choose the blocklist there; do not copy values
   into this repository or PR text.
2. Drain active runs, including resident processes, before restarting the updated
   services. Existing processes retain their launch environment across daemon
   restarts. Start fresh agent runs to install guards and pick up the identity.
   Existing worktrees receive the updated guard and marker when reused.
3. Check a disposable run for each enabled harness with a harmless commit and
   verify the metadata locally. Test rejection using a temporary fake blocked
   identity; do not publish the probe commits.
4. Enable and require the server-side identity check in every repository agents
   work in, following the ruleset procedure below.

This change does not modify mint's live environment or rewrite existing commits.


## Required server-side check

The workflowd GitHub App publishes **Workflowd Git Identity** for every repository
in `WORKFLOWD_PR_REPOSITORIES` (the existing JSON array of `repository` and
`installationId` entries). Add every repository agents work in to this host
configuration and install the App there. This is also the PR automation allowlist;
adding a repository enables its existing review workflows, subject to their
eligibility rules. The webhook signature, installation
account guard, and repository/installation allowlist apply before the check runs.
It covers all PR authors, drafts, and forks, independently of automatic review
eligibility. No repository code, Git configuration, hooks, or local refs are read.

The daemon reads the blocklist from `WORKFLOWD_AGENT_GIT_BLOCKED_EMAILS` through
its existing agent Git configuration. Configure the identity fields alongside it.
An absent, empty, or whitespace-only blocklist produces a failed check. Startup
refuses PR repositories without a nonempty blocklist. Keep policy values on the
daemon host;
changing the root agent host's private file alone does not update the daemon.

On PR `opened`, `synchronize`, `reopened`, and base-changing `edited` deliveries,
the check reads the current PR base and head from GitHub, then inspects both raw Git author and
committer addresses on every commit in `base..head`. It uses the
[paginated compare API](https://docs.github.com/en/rest/commits/commits#compare-two-commits),
checks the total and unique commit count, and rechecks the PR before publishing.
History reachable from the base is excluded. Commits created by the Git or
Contents API receive the same inspection as pushed commits. This covers local
hook overrides, writable guards, and fake remote-tracking refs without trusting
any of those local controls.

Blocked identities fail the check. Output lists only failed commit SHAs and roles
(`author`, `committer`); names, addresses, commit messages, and raw API errors are
never included. Large failure lists are bounded to GitHub's output limit with an
omitted-commit count. API errors, malformed/incomplete results, PR changes during
the scan, and missing policy fail closed. If GitHub cannot accept a check write,
the check remains missing or pending: neither satisfies a required check. The
delivery is still stored and acknowledged. Inspect daemon logs and redeliver the
webhook after recovery. Webhook redelivery is the primary manual recovery path.

Enable **Pull requests: read**, **Contents: read**, and **Checks: read and write**
on the App, and subscribe to **Pull request**, **Check run**, and **Check suite**
webhooks. Keep the existing installation subscriptions and permissions. Approve updated installation
permissions where GitHub requests it. The check runs in the automation daemon
that owns the existing GitHub App integration, not in an execution-only runner.

When GitHub offers **Re-run**, use it on **Workflowd Git Identity** in the PR's
Checks tab. GitHub may not offer this action for an in-progress check; redeliver
the original webhook from the App delivery log in that case.
The `check_run.rerequested` handler accepts only this App's named check and its
workflowd PR identifier. It resets that check to pending before re-reading the
PR and its entire range. A request for an obsolete head cannot publish success.
**Re-run all** is also supported through `check_suite.rerequested`, restricted to
this App and PR repositories. It paginates existing identity checks on the suite's
head SHA and recovers their PR identifiers, including when fork suites have an
empty PR list ([GitHub check-suite behavior](https://docs.github.com/en/rest/checks/suites)).
Title and body edits do not trigger scans.

Webhook ingestion stores the delivery before scheduling the check in a daemon-scoped
dispatcher. At most four scans run globally, with at most 100 additional targets
waiting. A repeated target replaces the pending target for the same repository/PR/head
and interrupts its active scan; the replacement waits for that scan to exit.
A same-head redelivery retains a deferred completion and its existing check ID.
Events for obsolete heads cannot interrupt the current head’s scan.
Each PR retains at most two heads that have not started. A further head evicts
the oldest waiting head without an existing check or interrupted predecessor.
Queued reruns and interrupted keys are retained; if both waiting heads are
protected, the new delivery is logged and dropped. An evicted head needs a
new event to be checked. Interrupted scans complete as superseded failures
through the publication fence before their replacements run.
Already-issued check writes are drained before a replacement resets the same
check ID, including when a client ignores cancellation.
Suite discovery has one worker and at most 100 waiting suites. Overflow is logged
and dropped; redeliver its webhook to retry.
Ranges above 10,000 commits fail with **range too large**. GitHub rate-limit
exhaustion pauses subsequent identity API requests until the reset/retry-after
deadline (at least one minute), including check publication and discovery.
Inspection, startup recovery and suite discovery share a rolling allowance of
1,000 reads per installation per hour across repositories. Each PR can consume
at most 250 of those reads. Untrusted authors share 250 reads across their PRs
and repositories in the installation. Authors are trusted when GitHub reports
`OWNER`, `MEMBER`, or `COLLABORATOR`, or the head repository matches the base
repository. Only verified webhook or PR API fields establish trust; caller-supplied
trust flags are ignored. `MEMBER` includes any member of the owning organisation,
even members without access to this repository. Trusted authors are exempt from
author shares, while installation and per-PR limits still apply. Of the installation allowance, 200
reads and 20 check starts are reserved for trusted PRs.

Every pagination step is charged, including iterator completion; failed requests
also consume allowance. Check creation and rerun resets have 100 writes per
installation per hour, with at most 25 per PR and per untrusted author.
Completions, including recovery and superseded failures, have 200 writes per
installation and 50 per PR and per untrusted author. These separate completion
allowances leave capacity after the start limit is reached.

Local budget exhaustion retains the job in the dispatcher's bounded waiting set.
Twenty waiting slots are reserved for trusted jobs. At capacity, a new job evicts
the oldest deferred entry that has no check ID; active work and entries owning a
check ID are never evicted. Evicted heads can be recovered by webhook redelivery
or startup recovery.
A minute scheduler requeues retained jobs once their rolling shares have capacity;
waiting retries do not occupy scan workers. Each retry re-reads the PR's author
and trust from GitHub before starting or resetting a check. Existing check IDs are
retained, so a completion rejected by the budget is retried by scanning and
completing the same check. A capped rerun or scan publishes **scan budget exhausted, retry later** as a
failed check when completion capacity remains. GitHub I/O errors are not retried
as local budget rejections. Queue overflow, GitHub errors, and failed supersede
writes can still need webhook redelivery or startup recovery.

Together these limits bound identity API traffic to 1,300 requests per
installation per rolling hour. Client acquisition uses the App's cached client
and is outside the installation API allowance. Allowances and waiting retries
are in memory and reset on daemon restart. These budgets do not account for
other App users of the installation's GitHub rate limit. Author names are
normalized to lowercase; reruns resolve missing author and trust metadata through
a budgeted PR read and reuse recent reservations for subsequent lookups.

Checks API errors and slow scans do not prevent PR automation ingestion. On
daemon startup, workflowd lists open PRs in the configured repositories and
requeues this App's named identity checks left **in_progress** on their current
heads. Scope closure and daemon shutdown leave running checks in progress;
only a replacement-triggered interruption publishes a superseded failure.
Recovery also creates a check for an open current head with no identity check
from this App, so heads dropped at the start cap can recover after restart.
Existing completed checks are retained. All recovery reads and writes use the
same budgets, including author shares. Recovery uses the same bounded dispatcher and waits for capacity; it does
not replace work already admitted from a webhook. Discovery errors are logged
per PR or repository. This is not a durable queue: exhausted recovery budgets, discovery failures,
and interrupted checks on obsolete heads may still need webhook redelivery.
Requiring the check prevents merging without a success.
When a current head has multiple pending identity checks, recovery selects the
newest check ID across all pages and completes older pending checks as failed
with a superseded message. Its writes use the same publication fence as scans.
A failed supersede write is logged with its repository and check ID; recovery
continues with the newest check and later PRs.

Matching is exact after trimming and lowercasing. Operators must list the GitHub
noreply form of every blocked identity as well as its other Git email forms; the
check does not infer aliases from a GitHub username or account. Add each variant
that policy intends to block in host configuration.

After a host policy change, restart the daemon and re-run checks on open PRs;
already completed checks retain the previous policy until re-run.

### Enable the requirement in each repository

These are operator steps; workflowd does not edit rulesets.

1. Deploy the check, configure the repository/installation and private policy, and
   open or synchronize a PR. Verify **Workflowd Git Identity** is published by the
   workflowd App. For existing PRs without the check, reopen or synchronize them,
   or redeliver a qualifying PR webhook.
2. In the repository's **Settings → Rules → Rulesets**, create or edit an active
   branch ruleset targeting the default branch and every other protected merge
   destination. Require a pull request before merging and require status checks.
3. Add the exact check name **Workflowd Git Identity**. Select the installed
   **workflowd App as the expected source** rather than “any source”; otherwise
   another writer could spoof the check name. Require branches to be up to date
   before merging so the result covers the current base. See GitHub's
   [required-check rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging).
4. Keep agent users, teams, and Apps out of the ruleset bypass list. Restrict
   direct pushes, force pushes, and deletion of protected branches. Save with
   enforcement **Active**, not Evaluate, and confirm a PR with a failing or missing
   identity check cannot merge. Repeat for every repository agents work in; an
   App installation alone does not make its check required. See
   [creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository).

The check validates the PR's commits, not a later GitHub-generated squash or merge
commit, and does not publish `merge_group` checks for merge queues. Configure merge
identities separately and do not rely on this PR check to validate generated merge
commits. Protect the host policy, App credentials, and ruleset administration from
agent modification; those are the enforcement boundary.
