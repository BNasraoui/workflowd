# OpenCode review isolation

Automatic review starts only for an open, non-draft PR with author association
`OWNER`, `MEMBER`, or `COLLABORATOR`, or with its head in the base repository.
Repository names are compared case-insensitively. Missing or unfamiliar
associations do not authorize a fork. Webhooks and authoritative reconciliation
use the same rule. Skipped PRs remain tracked; `pull_requests` stores the
association and `automatic_review_skip_reason=automatic-review-untrusted-fork`,
and webhook responses include that reason. An allowed commenter can still use
`/agent review`; `WORKFLOWD_COMMAND_USERS` remains the authorization boundary.

`deploy/opencode/opencode2.json` is the complete reviewed v2 overlay, installed
at `~/.config/workflowd/opencode2-sandbox-agent.json`. It retains the sandbox
agent and defines `pr-reviewer` and `pr-fixer`. Both begin with deny-all and
allow only `read`, `grep`, `glob`, `list`, and `StructuredOutput`. MCP tools from
all servers, Code Mode, web access, skills, commands, edits, subagents, and
external directories are denied. The pipeline currently extracts JSON through
`session.generate`; the `StructuredOutput` allowance also covers legacy tool
based extraction. Neither requires MCP or Code Mode.

The legacy v1 Markdown definitions under `deploy/opencode/agent/` have the
same allowlist. The fixer is now read-only and cannot apply or commit fixes.
Keep `WORKFLOWD_FIX_WORK_ENABLED=false` until a separately isolated mutation
executor is available; these permissions must not be widened to restore fixing.

The overlay declares `mcp.servers` empty. An empty map alone does **not** remove
inherited servers: OpenCode merges configuration. The v2 systemd drop-in also
selects a dedicated, empty `XDG_CONFIG_HOME` and disables project config, and
unsets alternate config sources and workflowd dispatch credentials. This keeps
`~/.config/opencode/opencode.json` and its legacy agents out of the review server.
Do not install any MCP server, credential reference, or additional config in that
isolated root. Provider authentication remains in OpenCode's existing data store;
no provider credentials need to be copied. Explicit provider settings, if required,
must be reviewed and added to the declarative overlay, never copied wholesale
from the global config. See OpenCode's [configuration](https://dev.opencode.ai/v2/docs/config/)
and [permission precedence](https://dev.opencode.ai/v2/docs/permissions/) documentation.

## Mint operator migration

These steps are performed by the operator after deployment, not by the worker.
No GitHub App, ruleset, or repository secret changes are needed.

1. Pause review intake and drain/stop existing reviewer and fixer sessions before
   restarting. Already queued jobs predate the trust gate: inspect pending review
   work and cancel or explicitly authorize fork work before resuming.
2. Back up the existing v2 overlay and drop-ins privately. Keep the removed global
   workflowd MCP entry removed; do not restore it from an older installation guide.
3. Install the reviewed overlay and isolation drop-in:

   ```sh
   install -d -m 0700 "$HOME/.config/workflowd/opencode2"
   install -Dm0600 deploy/opencode/opencode2.json "$HOME/.config/workflowd/opencode2-sandbox-agent.json"
   install -Dm0644 deploy/systemd/opencode2-server.service.d/20-review-isolation.conf "$HOME/.config/systemd/user/opencode2-server.service.d/20-review-isolation.conf"
   ```

   Ensure the isolated directory is empty and no other drop-in or EnvironmentFile
   overrides these settings. Do not change the shared v1 config. Do not roll back
   to the older sandbox-only overlay, which lacks the reviewer restrictions.
4. Create a new independent `~/.config/workflowd/mcp-dispatch-token` (mode `0600`)
   for the MCP service. Never reuse `mcp-token` or distribute the new token to
   OpenCode. Install the updated `workflowd-mcp.service`, preserving reviewed
   deployment-path drop-ins. Existing ordinary MCP clients keep `mcp-token`.
   Trusted non-OpenCode coordinators receive the dispatch token separately; the
   Claude channel needs both credentials. See [MCP authorization](mcp-server.md#authorization).
5. Set Fix Work disabled in the operator-managed workflowd environment. Reload
   systemd and restart `opencode2-server`, `workflowd-mcp`, and `workflowd` after
   draining. Workflowd applies migration 0035 to record review trust and skips.
6. Before resuming, inspect the effective agent catalog for both agents, confirm
   the opencode2 MCP catalog is empty and project config is disabled, and confirm
   the ordinary write token is refused by `dispatch_agent`. Verify provider
   availability and a trusted review through structured completion. Keep the
   dispatch credential out of all OpenCode configuration and environments.

The disposable `test/review-opencode.e2e.test.ts` loads the actual deployment
artifact with an ambient MCP canary, checks the effective agent catalog and empty
MCP catalog, and does not access mint. It runs when `opencode2` is on PATH. The
normal suite always checks both artifact allowlists, config isolation, automatic
review trust, manual review authorization, and HTTP capability authorization.
