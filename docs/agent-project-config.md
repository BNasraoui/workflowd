# Agent configuration sources

Workflowd treats worktree configuration as repository content, including when a
user previously trusted the repository in a harness. Ordinary Claude launches
and resumes use `--setting-sources user`; sandboxed Claude launches retain their
existing empty settings-source list. Codex exec and resident thread start/resume
supply a per-invocation `projects` trust table marking the worktree untrusted.
Sandbox MCP and skill discovery use the same trust override. Resident app servers
start in their dedicated home, outside repository configuration discovery.

Codex CLI overrides encode a `projects` table as TOML because dotted override keys
split on dots and do not interpret quoted filesystem path segments. This override
**deep-merges with the user's trust table**; it does not replace unrelated entries.
The exact canonical worktree key is sufficient because every launch and resident
thread start/resume uses that worktree root as its working directory. Its explicit
`untrusted` value takes precedence over trust for the primary checkout or a parent
directory. A future launch from a subdirectory of an explicitly trusted worktree
must preserve that guarantee. The pinned CLI resolves linked-worktree hook
definitions from the primary checkout. Tests cover both checkout and worktree
hook files, project config, and persisted trust.

References: [Claude settings sources](https://code.claude.com/docs/en/settings),
[Codex project trust](https://learn.chatgpt.com/docs/config-file/config-basic), and
[OpenCode configuration](https://opencode.ai/v2/docs/config).

## Operator rollout

No live configuration is changed by this patch.

1. **Required before deployment:** install and verify the Beads hooks at user
   level for every execution identity. Merge the reviewed hooks from
   `.claude/settings.json` into that user's `~/.claude/settings.json` (or configured
   Claude home), including `bd prime --hook-json`. Merge `.codex/hooks.json` into
   that user's `$CODEX_HOME/hooks.json` and enable `features.hooks=true` in the
   user-level Codex `config.toml`. Preserve existing user configuration.
   **Persist Codex hook trust for those reviewed user hooks** using that installed
   CLI's hook approval flow; enabling the feature alone is insufficient. Do not
   use the test fixture's `--dangerously-bypass-hook-trust` as a rollout shortcut.
   Verify Beads context loads on ordinary Claude and Codex CLI launch/resume under
   the actual execution identity before proceeding. Repository hooks will be
   excluded after deployment. Sandboxed runs intentionally keep hooks disabled.
   The resident Codex app-server currently does not fire user hooks, with or
   without this isolation change; user hook installation does not fix that
   existing limitation.
2. After the hook gate passes, deploy the launcher changes and restart workflowd
   and its runners. Restart existing resident Codex processes when safe; an
   already running thread retains its loaded configuration until it is resumed
   with the new settings.
3. Install `deploy/systemd/opencode-server.service.d/10-disable-project-config.conf`
   and `deploy/systemd/opencode2-server.service.d/10-disable-project-config.conf`
   under the corresponding user-unit drop-in directories for servers in use.
   Reload the user manager and restart those servers when safe. The shipped
   `opencode2-reviewer.service` already contains both project-disable variables.
   Verify both `OPENCODE_CONFIG_PROJECT_DISABLE=1` and
   `OPENCODE_DISABLE_PROJECT_CONFIG=1` on every externally managed OpenCode server
   used by workflowd, including remote servers. Both ordinary server unit drop-ins
   must contain:

   ```ini
   [Service]
   Environment=OPENCODE_DISABLE_PROJECT_CONFIG=1
   Environment=OPENCODE_CONFIG_PROJECT_DISABLE=1
   ```

   OpenCode v1 requires `OPENCODE_DISABLE_PROJECT_CONFIG`; v2 also honors
   `OPENCODE_CONFIG_PROJECT_DISABLE`. Workflowd attaches to those servers
   and cannot change their startup environment through an API request.
4. When adopting the separate agent user from PR #106, install hooks and OpenCode
   drop-ins for that execution identity. Preserve these source-selection flags
   when moving launch commands through the agent-host boundary. This change does
   not alter credential admission, user identity, or credential paths.

The real-harness tests use disposable linked worktrees, isolated configuration
homes, local model responses, and inert marker files. Full suites run in CI.

## Integration with PR #106

A merge-tree check against PR #106 found overlap in `claude-worker.ts`,
`claude-session.ts`, and the imports in `resident/service.ts`: that PR moves the
ordinary Claude command into `runClaudeNativeWorker` in `codex-worker.ts` and adds
a host-managed resume path.
When combining the changes, retain `--setting-sources user` in the moved ordinary
launcher, the local `makeClaudeCli` resume command, and the new `claude-resume`
command in `runHostWorker`. Keep sandboxed Claude's empty settings sources.
Keep both `AgentGitConfig` and `codexProjectConfig` imports in the resident service.
The auto-merged `codex-worker.ts` also needs the flags in both new Claude paths;
absence of a content conflict does not establish isolation. The source-wide argv
policy test scans new launch paths and both sandbox branches. Repeat the
installed-harness tests against the combined head; the current tests validate
this PR on main, not the combined deployment.
