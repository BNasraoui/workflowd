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
creation and availability checks use that endpoint. Resume, abort and attachment
route by the persisted server ID, so pre-migration sessions stay on their original
server until drained. Normal agent runs, stage work, provider discovery and parent
wakes retain `OPENCODE_SERVER_URL` and `WORKFLOWD_OPENCODE_ATTACH_URL`. Mint's
`opencode2-server.service` on port 4097, including `remote-worker` from
`~/.config/opencode/agent/remote-worker.md`, its plugins and provider settings,
is unchanged. Do not install reviewer isolation on that shared server.

The reviewer has a dedicated HOME at `~/.local/share/workflowd/reviewer/home`,
a read-only XDG config root at `~/.config/workflowd-reviewer`, and separate XDG
data, cache and state directories under `~/.local/share/workflowd/reviewer`.
The overlay declares no MCP servers. Both `OPENCODE_CONFIG_PROJECT_DISABLE=1`
and `OPENCODE_DISABLE_PROJECT_CONFIG=1` are set; alternate config sources and
workflowd credential environment variables are unset. The dedicated HOME stops
ambient `~/.claude/skills` and `~/.agents/skills` discovery. This is configuration
isolation, not a claim that every file in the operator's home is inaccessible.
The config root may contain only the reviewed overlay and OpenCode's generated
initialization files; no plugins, MCP entries, token references, or extra agents.
The separate data store holds reviewer sessions and only explicitly selected
provider credentials, seeded as described below without another login. The shared
OpenCode data roots are masked. Review required provider settings individually;
do not copy global configuration or the shared database.

Review trees containing Git mode `120000` entries are refused before managed
checkout creation, before accessing reused worktree context, and after pulling
a reused worktree. Both file and directory symlinks are unsupported, including
links whose targets would be inside the tree. This makes the checkout policy
independent of OpenCode's textual path permission checks.

**The OpenCode permission layer is the main boundary.** Its deny-by-default
reviewer/fixer policy limits tools, execution and external-directory access.
The systemd restrictions below are defence in depth, not a complete sandbox or
a separate Unix identity. A compromise of the OpenCode process can still reach
unmasked same-user files, loopback services and its own provider credentials.

The reviewer unit uses `PrivateUsers=yes` so filesystem restrictions apply in
the user manager. `InaccessiblePaths` masks the entire `~/.config/workflowd`
directory (tokens, keys, passwords, environment files and fallback NATS creds),
the noscope/NATS config/state roots and the shared OpenCode data roots.
`TemporaryFileSystem=%t` hides the entire user runtime directory, including
`/run/user/<uid>/credentials/*`, the user bus and `systemd/private` socket.
Masking individual credential directories would fail after another unit restarts;
the whole runtime mask also prevents reaching the user manager to start a less
restricted unit. The manager reads the mode-0600 `~/.config/workflowd/reviewer.env`
via `EnvironmentFile` before applying restrictions. It contains only the dedicated
reviewer server password; there is no `LoadCredential` or shell wrapper in this
unit. Workflowd uses `WORKFLOWD_REVIEW_OPENCODE_PASSWORD_FILE` for its matching
client credential, which must differ from the agent-run password.
Add masks for any operator-configured secret paths outside the protected roots.
`ReadOnlyPaths` protects the config root. Treat namespace setup failure as a
failed rollout, not a reason to remove restrictions.

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
2. Record the deployed code revision and back up the overlays, base/override env
   files, units and drop-ins privately (mode 0700 directory, 0600 secret files).
   After stopping workflowd, take a consistent SQLite backup for rollback. Leave the port-4097 agent-run
   server, global plugins/providers, and `remote-worker` definition unchanged.
   Do not install the superseded `20-review-isolation.conf` there; if an earlier
   PR revision was staged, remove that specific drop-in and restore the previous
   shared-server environment before restarting it. Keep the removed global
   workflowd MCP entry removed.
3. Prepare the dedicated reviewer root and unit:

   ```sh
   install -d -m 0700 "$HOME/.config/workflowd-reviewer/opencode"
   install -d -m 0700 "$HOME/.local/share/workflowd/reviewer"
   for directory in home data cache state; do
     install -d -m 0700 "$HOME/.local/share/workflowd/reviewer/$directory"
   done
   # Generate once; never reuse the agent-run password or print either secret.
   (umask 077; openssl rand -hex 32 > "$HOME/.config/workflowd/reviewer-password")
   (umask 077; printf 'OPENCODE_SERVER_PASSWORD=%s\n' \
     "$(cat "$HOME/.config/workflowd/reviewer-password")" \
     > "$HOME/.config/workflowd/reviewer.env")
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
   Seed only the needed provider credentials using the procedure below. The
   reviewer password file is for workflowd's client; `reviewer.env` is for the
   reviewer unit. Keep both 0600 and update both together when rotating.
4. **Before restarting workflowd-mcp**, create an independent
   `~/.config/workflowd/mcp-dispatch-token` with mode `0600`. Its `LoadCredential`
   is mandatory (no `-` prefix); restarting before the file exists fails.
   Install the updated MCP unit, preserving deployment-path drop-ins. Ordinary
   clients keep `mcp-token`. The trusted RPI coordinator needs **both** ordinary
   and dispatch tokens and must use the coordinator channel, which selects the
   bearer per capability; a single-bearer HTTP client cannot serve that workflow.
   Never install the dispatch token in user-scope Claude/Codex worker MCP config
   or any OpenCode config/environment. See [MCP authorization](mcp-server.md#authorization).
5. **Set `WORKFLOWD_FIX_WORK_ENABLED=false` in the base
   `~/.config/workflowd/env` file** and ensure every override agrees. Set
   `WORKFLOWD_REVIEW_OPENCODE_URL=http://127.0.0.1:4098` there too. Install the
   updated workflowd unit (preserving deployment-path drop-ins); it loads
   `reviewer-password` and sets `WORKFLOWD_REVIEW_OPENCODE_PASSWORD_FILE`.
   Do not also set the direct password variable in any env file. Keep
   `OPENCODE_SERVER_URL`, `WORKFLOWD_OPENCODE_ATTACH_URL` and
   `WORKFLOWD_AGENT_RUN_AGENT=remote-worker` unchanged. Reload the user manager,
   start/enable `opencode2-reviewer`, and restart `workflowd-mcp` and `workflowd`
   after draining. Workflowd applies migration 0035. Do not restart or reconfigure
   the shared OpenCode server unless undoing the superseded isolation drop-in.
6. Verify the actual reviewer process is on port 4098 with both project flags,
   the isolated root, both effective read-only agent policies and an empty MCP
   catalog. Run the disposable user-manager fixture below and inspect the deployed
   unit with `systemctl --user show opencode2-reviewer -p PrivateUsers -p InaccessiblePaths -p ReadOnlyPaths -p TemporaryFileSystem`.
   Confirm its mount namespace differs from the user manager's and that the
   protected roots appear inaccessible and the config root read-only in its
   `/proc/<MainPID>/mountinfo`; configured properties alone are insufficient.
   From the reviewer's mount namespace, check that listing
   `/run/user/<uid>/credentials` fails, neither `$XDG_RUNTIME_DIR/bus` nor
   `$XDG_RUNTIME_DIR/systemd/private` exists, and `systemctl --user show-environment`
   fails. Use an operator-owned namespace probe (for example `nsenter` with the
   required privileges), never enable reviewer shell permissions for this test.
   **Repeat these actual restriction checks after both workflowd-mcp and workflowd
   have restarted**, when their new credential copies exist. Recheck the reviewer
   after its own restart as well.
   Verify ordinary-token dispatch refusal, provider availability and one trusted
   review through structured completion. **Dispatch one ordinary OpenCode agent
   run on port 4097 and confirm its first output token** from the returned receipt
   or session telemetry; session creation alone does not pass this gate.
   Resume intake/replay only after both paths pass.
7. Rollback if any gate fails: keep intake paused/spooled; stop workflowd and the
   reviewer, restore the recorded code revision, unit/drop-in and env backups,
   and reload the user manager. If reverting across incompatible migrations,
   restore the stopped database from the matching backup before starting that
   revision. Restore MCP's matching unit/token setup together. Keep Fix Work
   disabled in the base env and keep automatic review stopped if the rollback
   cannot satisfy these isolation gates. Preserve the dedicated reviewer data
   privately for diagnosis; do not merge it into shared data or restore dispatch
   tokens to worker configs. Restart only the verified paths, then replay failed
   deliveries by ID. A rollback to the shared reviewer is not a security fix.

## Provider credential bootstrap (operator only)

The pinned OpenCode 2 stores credentials in the `credential` table of
`$XDG_DATA_HOME/opencode/opencode.db`. Copying `auth.json` into a fresh data root
is insufficient: fresh database initialization does not run the legacy import.
No new login is required: initialize the dedicated database by starting the
reviewer once (with intake paused), then stop it and copy **only selected provider
credential rows** from the existing store. Do not copy its sessions, config, plugins,
`kv` table or whole database. Select one credential per required provider; an
ambiguous selection must be resolved explicitly by credential ID.

For the pinned schema, this example copies one existing credential for each
provider named on the command line (adjust paths/provider IDs to the deployment):

```sh
systemctl --user daemon-reload
systemctl --user start opencode2-reviewer
# Wait for its authenticated API to respond, confirming database initialization.
systemctl --user stop opencode2-reviewer
python3 - "$HOME/.local/share/opencode/opencode.db" \
  "$HOME/.local/share/workflowd/reviewer/data/opencode/opencode.db" openai <<'PY'
import os, pathlib, sqlite3, sys
source_path, target_path, *providers = sys.argv[1:]
assert providers, "Select the required providers explicitly"
source = sqlite3.connect(pathlib.Path(source_path).as_uri() + "?mode=ro", uri=True)
rows = []
for provider in providers:
    selected = source.execute(
        "SELECT id, integration_id, label, value, time_created, time_updated "
        "FROM credential WHERE integration_id = ?", (provider,)
    ).fetchall()
    assert len(selected) == 1, "Select exactly one credential per provider by ID"
    rows.extend(selected)
source.close()
target = sqlite3.connect(target_path)
with target:
    assert target.execute("SELECT count(*) FROM credential").fetchone()[0] == 0, "Destination must be fresh"
    target.executemany("INSERT INTO credential "
        "(id, integration_id, label, value, time_created, time_updated) "
        "VALUES (?, ?, ?, ?, ?, ?)", rows)
target.close()
os.chmod(target_path, 0o600)
PY
systemctl --user start opencode2-reviewer
```

Run the copy privately, without shell tracing or logging credential values.
Verify only the selected providers are authenticated and complete one review.
For an API key stored in legacy `auth.json`, the supported alternative is to send
only that selected key to the dedicated server's
`POST /api/integration/<provider>/connect/key` with body `{"key":"..."}` using a
private script that reads the key/password from files (never argv or logs).
The disposable test verifies this API and the dedicated credential table.
OAuth copies share refresh-token state with the source; coordinate refresh and
rotation to avoid two servers racing the same token. Prefer an existing API-key
credential where available. Do not silently copy additional credentials if the
selected provider fails. Keep generated HOME free of global skill directories.

## Regression checks

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
MCP/skill catalogs and independent provider data. Under the user manager it starts
with the runtime mask, hidden password env file and read-only config root.
The filesystem fixture uses the deployed unit's restrictions against synthetic
secret files, proving unreadability, configuration write refusal, hidden runtime
credentials/sockets and user-manager command failure. It never
opens live credentials. Neither fixture replaces the post-deploy checks above.
