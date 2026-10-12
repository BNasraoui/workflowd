# OpenCode review isolation

Automatic review starts only for an open, non-draft PR with author association
`OWNER`, `MEMBER`, or `COLLABORATOR`, or with its head in the base repository.
Repository names are compared case-insensitively. Missing or unfamiliar
associations do not authorize a fork. Webhooks and authoritative reconciliation
use the same rule. Skipped PRs remain tracked; `pull_requests` stores the
association and `automatic_review_skip_reason=automatic-review-untrusted-fork`,
and webhook responses include that reason. An allowed commenter can still use
`/agent review`; `WORKFLOWD_COMMAND_USERS` remains the authorization boundary.

`deploy/opencode/opencode2.json` defines the read-only `pr-reviewer` and
`pr-fixer` policies, plus the existing sandbox policy. The review agents deny by
default and allow only `read`, `grep`, `glob`, `list`, and `StructuredOutput`.
The legacy v1 Markdown definitions have the same allowlist. The fixer cannot
apply or commit fixes: set `WORKFLOWD_FIX_WORK_ENABLED=false` until a separately
isolated mutation executor is available.

Review/fix automation uses `WORKFLOWD_REVIEW_OPENCODE_URL` (default
`http://127.0.0.1:4098`) and the dedicated `opencode2-reviewer.service`. Session
creation, continuation, abort, availability checks and attachment resolve to
that endpoint. Normal agent runs, stage work, provider discovery and parent
wakes retain `OPENCODE_SERVER_URL` and `WORKFLOWD_OPENCODE_ATTACH_URL`. Mint's
`opencode2-server.service` on port 4097, including `remote-worker` from
`~/.config/opencode/agent/remote-worker.md`, its plugins and provider settings,
is unchanged. Do not install reviewer isolation on that shared server.

The reviewer uses `~/.config/workflowd-reviewer` as its own read-only config
root. The overlay declares no MCP servers. Both `OPENCODE_CONFIG_PROJECT_DISABLE=1`
and `OPENCODE_DISABLE_PROJECT_CONFIG=1` are set; alternate config sources and
workflowd credential environment variables are unset. Ambient global and
PR-supplied configuration must not enter the reviewer. The dedicated root may
contain only the reviewed overlay and OpenCode's generated initialization files;
no plugins, MCP entries, token references, or additional agent definitions.
Provider authentication remains in OpenCode's existing data store. Review any
required explicit provider settings individually; do not copy global config.

Review trees containing Git mode `120000` entries are refused before managed
checkout creation, before accessing reused worktree context, and after pulling
a reused worktree. Both file and directory symlinks are unsupported, including
links whose targets would be inside the tree. This makes the checkout policy
independent of OpenCode's textual path permission checks.

The reviewer unit uses `PrivateUsers=yes` so filesystem restrictions apply in
the user manager. `InaccessiblePaths` masks the entire `~/.config/workflowd`
directory: `mcp-token`, any dispatch-token filename, `agent-run-token`,
`agent-wait-token`, `ci-token`, `github-app.pem`, `github-webhook-secret`,
`opencode-server-password`, environment files and fallback NATS credentials.
It also masks the noscope and NATS config/state roots. HTTP authentication is
loaded by systemd before masking, through `LoadCredential`; the process does not
read the original password file. Add explicit masks for operator-configured
secret paths outside those directories. `ReadOnlyPaths` protects the reviewer
config root. Treat namespace setup failure as a failed rollout, not a reason
to remove these restrictions.

Until a separate agent Unix user exists, keeping the dispatch token from
shell-capable OpenCode agents on the **agent-run server relies on configuration
only**. Removing a token from MCP config does not prevent same-user shell file
access. Dispatched Claude and Codex workers normally read user-scope MCP config
(`~/.claude.json`, `~/.codex/config.toml`, or their configured home overrides).
Never give those worker configurations the dispatch token. Direct Claude workers
now launch with `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, so they
inherit no workflowd MCP. Sandbox workers retain their separate bridge-only MCP
configuration. These flags do not establish a Unix-user boundary.

## Mint operator migration

These steps are performed by the operator after deployment, not by this worker.
No GitHub App, ruleset, or repository secret changes are needed.

1. Pause intake before draining/stopping reviewer and fixer sessions. There is
   no review-only pause setting today: a maintenance stop of `workflowd.service`
   also stops its webhook listener and other controller work. If the ingress has
   a durable spool, keep accepting deliveries there and replay after restart;
   acknowledge only durably stored deliveries. Otherwise record the maintenance
   window and redeliver every failed GitHub webhook after restart, verifying
   acceptance by delivery ID. [GitHub does not automatically retry these failures](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).
   Do not disable the webhook or assume stopping the service preserves delivery.
   Inspect pre-gate queued review work and cancel or explicitly authorize fork
   work before resuming.
2. Back up the overlays and unit drop-ins privately. Leave the port-4097 agent-run
   server, global plugins/providers, and `remote-worker` definition unchanged.
   Do not install the superseded `20-review-isolation.conf` there; if an earlier
   PR revision was staged, remove that specific drop-in and restore the previous
   shared-server environment before restarting it. Keep the removed global
   workflowd MCP entry removed.
3. Prepare the dedicated reviewer root and unit:

   ```sh
   install -d -m 0700 "$HOME/.config/workflowd-reviewer/opencode"
   install -d -m 0700 "$HOME/.local/share/workflowd/reviewer"
   install -Dm0600 deploy/opencode/opencode2.json "$HOME/.config/workflowd-reviewer/opencode2.json"
   install -Dm0644 deploy/systemd/opencode2-reviewer.service "$HOME/.config/systemd/user/opencode2-reviewer.service"
   ```

   Review its binary path and provider availability. The old “isolated directory
   must be empty” check fails after the first OpenCode start: OpenCode initializes
   its own directories/files. Inventory contents instead, distinguishing generated
   initialization files from extra agents/config/plugins; do not delete an active
   config root to satisfy that check. Pre-create the `opencode` directory as above
   so first start can run with a read-only root. Keep the overlay read-only and
   inspect all effective unit drop-ins and environment sources for overrides.
4. Create an independent `~/.config/workflowd/mcp-dispatch-token` with mode `0600`.
   Install the updated MCP unit, preserving deployment-path drop-ins. Ordinary
   clients keep `mcp-token`. The trusted RPI coordinator needs **both** ordinary
   and dispatch tokens and must use the coordinator channel, which selects the
   bearer per capability; a single-bearer HTTP client cannot serve that workflow.
   Never install the dispatch token in user-scope Claude/Codex worker MCP config
   or any OpenCode config/environment. See [MCP authorization](mcp-server.md#authorization).
5. **Set `WORKFLOWD_FIX_WORK_ENABLED=false`** and
   `WORKFLOWD_REVIEW_OPENCODE_URL=http://127.0.0.1:4098` in workflowd's effective
   operator-managed environment, including any override EnvironmentFile. Keep
   `OPENCODE_SERVER_URL`, `WORKFLOWD_OPENCODE_ATTACH_URL` and
   `WORKFLOWD_AGENT_RUN_AGENT=remote-worker` unchanged. Reload the user manager,
   start/enable `opencode2-reviewer`, and restart `workflowd-mcp` and `workflowd`
   after draining. Workflowd applies migration 0035. Do not restart or reconfigure
   the shared OpenCode server unless undoing the superseded isolation drop-in.
6. Verify the actual reviewer process is on port 4098 with both project flags,
   the isolated root, both effective read-only agent policies and an empty MCP
   catalog. Run the disposable user-manager fixture below and inspect the deployed
   unit with `systemctl --user show opencode2-reviewer -p PrivateUsers -p InaccessiblePaths -p ReadOnlyPaths`.
   Confirm its mount namespace differs from the user manager's and that the
   protected roots appear inaccessible and the config root read-only in its
   `/proc/<MainPID>/mountinfo`; configured properties alone are insufficient.
   Verify ordinary-token dispatch refusal, provider availability and one trusted
   review through structured completion. **Dispatch one ordinary OpenCode agent
   run on port 4097 and confirm its first output token** from the returned receipt
   or session telemetry; session creation alone does not pass this gate.
   Resume intake/replay only after both paths pass.

Disposable regression checks (no live unit changes):

```sh
systemd-run --user --wait --pipe --collect \
  -p MemoryMax=6G -p MemorySwapMax=0 \
  --working-directory="$PWD" --setenv="PATH=$PATH" \
  --setenv="XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" \
  "$(command -v bun)" test test/review-opencode.e2e.test.ts test/review-systemd.e2e.test.ts
```

The OpenCode fixture loads the actual overlay with ambient and PR-supplied root
config, `.opencode` config and plugin canaries, checking the effective policy and
MCP catalogs. Under the user manager it also starts with a read-only config root.
The filesystem fixture uses the deployed unit's restrictions against synthetic
secret files, proving unreadability and configuration write refusal. It never
opens live credentials. Neither fixture replaces the post-deploy checks above.
