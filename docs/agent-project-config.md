# Agent configuration sources

Workflowd treats worktree configuration as repository content, including when a
user previously trusted the repository in a harness. Ordinary Claude launches
and resumes use `--setting-sources user`; sandboxed Claude launches retain their
existing empty settings-source list. Codex exec and resident thread start/resume
supply a per-invocation `projects` trust table marking the worktree untrusted.
Sandbox MCP and skill discovery use the same trust override. Resident app servers
start in their dedicated home, outside repository configuration discovery.

Codex CLI overrides encode the entire trust table as TOML: dotted override keys
split on dots and do not interpret quoted filesystem path segments. The pinned
CLI resolves linked-worktree hook definitions from the primary checkout. Tests
cover both checkout and worktree hook files, project config, and persisted trust.

References: [Claude settings sources](https://code.claude.com/docs/en/settings),
[Codex project trust](https://learn.chatgpt.com/docs/config-file/config-basic), and
[OpenCode configuration](https://opencode.ai/v2/docs/config).

## Operator rollout

No live configuration is changed by this patch.

- Deploy the launcher changes and restart workflowd and its runners. Restart
  existing resident Codex processes when safe; an already running thread retains
  its loaded configuration until it is resumed with the new settings.
- Keep required Claude hooks such as `bd prime --hook-json` in the execution
  user's `~/.claude/settings.json` (or its configured Claude home). Keep Codex
  Beads hooks in that user's `$CODEX_HOME/hooks.json`. Review user hooks before
  enabling them. Sandboxed runs intentionally keep hooks disabled.
- Install `deploy/systemd/opencode-server.service.d/10-disable-project-config.conf`
  and `deploy/systemd/opencode2-server.service.d/10-disable-project-config.conf`
  under the corresponding user-unit drop-in directories for servers in use.
  Reload the user manager and restart those servers when safe. The shipped
  `opencode2-reviewer.service` already contains both project-disable variables.
  Verify both `OPENCODE_CONFIG_PROJECT_DISABLE=1` and
  `OPENCODE_DISABLE_PROJECT_CONFIG=1` on every externally managed OpenCode server
  used by workflowd, including remote servers. Workflowd attaches to those servers
  and cannot change their startup environment through an API request.
- When adopting the separate agent user from PR #106, install hooks and OpenCode
  drop-ins for that execution identity. Preserve these source-selection flags
  when moving launch commands through the agent-host boundary. This change does
  not alter credential admission, user identity, or credential paths.

The real-harness tests use disposable linked worktrees, isolated configuration
homes, local model responses, and inert marker files. Full suites run in CI.

## Integration with PR #106

A merge-tree check against PR #106 found overlap in `claude-worker.ts` and
`claude-session.ts`: that PR moves the ordinary Claude command into
`runClaudeNativeWorker` in `codex-worker.ts` and adds a host-managed resume path.
When combining the changes, retain `--setting-sources user` in the moved ordinary
launcher, the local `makeClaudeCli` resume command, and the new `claude-resume`
command in `runHostWorker`. Keep sandboxed Claude's empty settings sources.
Codex worker, resident process/service, and sandbox changes otherwise merge without
content conflicts. Repeat the installed-harness tests against the combined head;
the current tests validate this PR on main, not the combined deployment.
