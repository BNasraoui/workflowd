# Reload configuration

SIGHUP asks the workflowd daemon to reread configuration without stopping agent
runs. After the operator installs this version and its reload unit, use:

```sh
systemctl --user reload workflowd
journalctl --user -u workflowd --since '2 minutes ago'
```

Installing the code and unit is a rollout step. `daemon-reload` alone does not
add signal handling to an older running daemon. Workers must leave rollout to
the coordinator.

## Files and validation

Set `WORKFLOWD_CONFIG_RELOAD_FILES` in the daemon's startup environment to a JSON
array of absolute paths. List the same files as the unit's `EnvironmentFile`
entries, in the same order. For mint:

```ini
Environment='WORKFLOWD_CONFIG_RELOAD_FILES=["%h/.config/workflowd/env","%h/.config/workflowd/env.rollout-overrides"]'
```

Systemd expands `%h` in this unit directive. Inside an env file, use absolute
paths; neither `%h`, `$HOME` nor `~` expands there.

The daemon reads these files only on reload. Later files win over earlier files
and over a copy of the environment captured at startup. Removing an override
restores the startup value, not the value from the last reload. Changing the
reload file list itself needs a restart. All listed files must exist and be
readable; an empty list rereads only the startup environment.

Files use systemd-style `NAME=value` assignments: blank lines and full-line `#`
or `;` comments, whole single-quoted or double-quoted values, multiline quoted
values, and backslash continuations. Unquoted outer whitespace is trimmed.
Double quotes preserve backslashes except before `"`, `\`, `$`, and backtick.
There is no shell execution, variable expansion, `export`, or inline comment
syntax. Invalid assignments, unfinished quotes and unreadable files reject the
whole reload. Write files atomically so a reload cannot read half an edit.

The full candidate goes through the startup config parser. It is also validated
with the existing infrastructure settings pinned. Nothing changes if either
validation fails. Reloads run in order. Each new dispatch takes one snapshot;
agent runs and dispatches already in flight keep their original settings.

## What reloads

| Setting group | Decision | Reason |
| --- | --- | --- |
| `WORKFLOWD_AGENT_RUN_REPOSITORIES` | Reload | New dispatches use the new repository paths and allow-list immediately. Removed aliases are refused. |
| `WORKFLOWD_AGENT_RUN_ROUTES`, `WORKFLOWD_AGENT_RUN_CODEX_ROUTES`, `WORKFLOWD_AGENT_RUN_CLAUDE_ROUTES` | Reload | New dispatches resolve aliases against the new lists. Existing accepted choices stay recorded. |
| Agent-run enablement/token, binaries, unit prefix, agent, Claude hosts, timeouts, polling, stall window and retries | Restart | Executors, authentication, custody and watchdogs hold startup settings. |
| Sandbox repository policies | Restart | Sandbox clients, leases and routing are built at startup. Repository edits must still fit the pinned policies. |
| HTTP host, port and webhook size limit | Restart | The listener and ingress limits are already acquired. |
| Database, state/cache/workspace paths, local repository roots, diff limit and Git identity/signing key | Restart | Stores, workspace services and subprocess adapters hold these settings. |
| GitHub App, secrets, installation policy, PR repositories, Fix Work, worker identity/concurrency/timing/users and OpenCode automation settings | Restart | Connected services and workers capture these settings. |
| Execution discovery settings and credentials | Restart | Discovery sources, clients, cache timing and authentication are already built. |
| Resident Codex/OpenCode and agent-host/worker-identity sockets and credentials | Restart | Scoped clients, sockets and resident workers already exist. |
| Remote coordinator/NATS endpoints, credentials and timing | Restart | Open connections and remote workers hold startup settings. Reload does not refresh noscope leases. |
| QRSPI, test-job, agent-wait and dogfood settings/tokens | Restart | Ingress and workflow services capture these settings. |
| Mode and reload file list; all other environment settings | Restart | Reload deliberately changes only the four dispatch lists above. |

Adding routes does not install or authenticate an executor. The configured
executor must already be usable. Reload cannot enable a disabled agent-run
service. Enabling a new sandbox or discovery source still needs a restart.

Each reload emits one `Configuration reload:` line with `changed=` and
`restart_required=` lists, or an error code with `changed=none`. It prints names
only, never values, file contents, paths or raw parser errors. Restart lists also
name config groups such as `openCode` when parsed values changed, including
file-backed secrets whose path stayed the same. Restart requests remain visible
on later reloads until the operator restarts. Reload neither rotates credentials
held by live connections nor reloads arbitrary files behind path settings.

## Reaching Bun through noscope

The checked-in direct-Bun unit uses:

```ini
ExecReload=/bin/kill -HUP $MAINPID
```

Do not use that command when `MAINPID` is noscope. The inspected noscope source
(`src/app/run.rs`, `src/ports/run_signal_wiring.rs`,
`src/core/signal_policy.rs`, `src/ports/agent_process.rs`) registers SIGHUP,
forwards it to the whole child process group, and revokes credentials as part of
shutdown. It does forward HUP, but forwarding is too broad for a config reload.

For `noscope run ... -- bun run start`, the operator should override only the
reload command, preserving the existing `ExecStart` and noscope arguments:

```ini
[Service]
ExecReload=
ExecReload=/opt/workflowd/bin/bun /opt/workflowd/deploy/current/src/config-reload-signal.ts $MAINPID
```

Use the same Bun executable and release path as the running daemon. The Linux
helper searches only `MAINPID` and its descendants for that release's Bun
`src/main.ts` process. It refuses zero or multiple matches, and sends HUP to
one PID. It does not signal noscope, sibling agents or a process group. It works
with both direct Bun and the `bun run start` wrapper. A successful systemctl
reload confirms signal delivery; inspect the daemon's reload log to confirm
validation and application succeeded.
