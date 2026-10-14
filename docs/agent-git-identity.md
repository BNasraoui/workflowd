# Agent Git identity

Configure these variables in the host's workflowd environment file, using the
operator-approved identity and blocklist from host configuration. Do not put real
identity values in repository files, issue comments, PR bodies, or shell examples.

| Variable | Meaning |
| --- | --- |
| `WORKFLOWD_AGENT_GIT_NAME` | Agent author and committer name |
| `WORKFLOWD_AGENT_GIT_EMAIL` | Agent author and committer address |
| `WORKFLOWD_AGENT_GIT_BLOCKED_EMAILS` | Comma-separated addresses forbidden for both roles; case-insensitive; empty means no blocked addresses |

Automation startup fails if agent dispatch or a resident executor is enabled and
either identity field is missing. Partial or invalid configuration, including an
allowed identity on the blocklist, is rejected without echoing address values.
Execution-only mode can omit this configuration; supplying it enables the same
identity and guard. Remote runners that enable Claude resume directories also
require the identity.

Codex and Claude transient units receive all four `GIT_AUTHOR_*` and
`GIT_COMMITTER_*` variables explicitly. Resident Codex receives them on both launch
paths. OpenCode receives them through its session environment API, including when
resident mailbox setup replaces that environment. Local and remote Claude resume
processes use the same configuration.

## Git hooks

After creating an agent worktree, workflowd installs its guard under that
worktree's Git administration directory (`workflowd-hooks`). Installation also runs
when reusing an existing worktree and before Claude resume. The creation command's
`-c core.hooksPath=/dev/null` applies only to creation; it cannot disable the
subsequently installed guard. A conditional Git config include selects the hooks
only for the assigned Git directory, leaving the main checkout's hooks alone.
The blocklist is stored in a private, untracked policy file, refreshed atomically.
If higher-priority Git configuration overrides the installed hooks path, setup
fails instead of launching an unguarded run.

The guard checks Git's effective author and committer in `pre-commit`,
`prepare-commit-msg`, and `commit-msg`. This catches an explicit `--author` and
keeps the commit check active with `--no-verify`. `pre-push` separately runs
`git log --format='%ae%n%ce'` over each advertised old-to-new range. New refs check
reachable commits excluding the destination remote’s fetched tracking refs, so
blocked authors already in the base history do not prevent every new branch.
Keep these refs current with a fetch before pushing (dispatch fetches origin
before creating worktrees). A URL destination with no matching tracking refs
conservatively checks all reachable history. Deletions need no scan. An unknown
old object or failed history inspection refuses the push; fetch before retrying.

Workflowd runs the identity check before chaining the original repository hook.
Other Git hooks are forwarded, and pre-push forwards the original stdin unchanged.
Replacing a tracked repository hook with an accepting hook therefore does not
replace the identity check. These are Git hooks, not an OS security boundary:
explicitly disabling hooks with `git -c core.hooksPath=...`, disabling the push hook
with `--no-verify`, or modifying the guard as the same Unix user can bypass them.

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

1. Set all three variables in the effective environment file for each daemon and
   Claude runner. Read the approved identity from host configuration and choose
   the blocklist there; do not copy values into this repository or PR text.
2. Drain active runs, including resident processes, before restarting the updated
   services. Existing processes retain their launch environment across daemon
   restarts. Start fresh agent runs to install guards and pick up the identity.
3. Check a disposable run for each enabled harness with a harmless commit and
   verify the metadata locally. Test rejection using a temporary fake blocked
   identity; do not publish the probe commits.

This change does not modify mint's live environment or rewrite existing commits.
