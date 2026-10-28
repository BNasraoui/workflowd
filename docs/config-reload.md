# Reload configuration

SIGHUP asks the workflowd daemon to reread configuration without stopping agent
runs. Workers must leave live rollout and reload to the coordinator.

## Ordered rollout

1. Deploy the code. Do not reload the running daemon yet.
2. Run `systemctl --user cat workflowd`. List **every** effective `EnvironmentFile`
   in order, including files added by drop-ins. Install a drop-in with
   `WORKFLOWD_CONFIG_RELOAD_FILES` listing exactly those files and the daemon-only
   helper below. Keep the existing `ExecStart`, including any noscope wrapper.

   ```ini
   [Service]
   Environment='WORKFLOWD_CONFIG_RELOAD_FILES=["%h/.config/workflowd/env","%h/.config/workflowd/env.rollout-overrides"]'
   ExecReload=
   ExecReload=/opt/workflowd/bin/bun /opt/workflowd/deploy/current/src/config-reload-signal.ts $MAINPID
   ```

   This is an example for a unit with both files. The checked-in base unit lists
   only `env`; use the paths and Bun executable from the installed unit.
3. Run `systemctl --user daemon-reload`.
4. Restart once, when no agent runs are in flight. This installs the HUP handler
   and captures which names the reload files own.
5. With no file edits, run `systemctl --user reload workflowd`, then
   `journalctl --user -u workflowd --since '2 minutes ago'`. Require
   `changed=none restart_required=none restart_required_groups=none`. Any changed
   or restart-required name/group means a file-order or environment mismatch to
   investigate before proceeding.
6. Only then edit the repository or route lists and reload again.

Never run `reload` before step 4. `daemon-reload` does not add a signal handler to
old code. The helper refuses a daemon without a registered HUP handler, including
startup and shutdown, rather than sending a signal that would terminate it.

## Files and validation

Set `WORKFLOWD_CONFIG_RELOAD_FILES` in the daemon's startup environment to a JSON
array of absolute paths. List the same files as the unit's `EnvironmentFile`
entries, in the same order. For mint:

```ini
Environment='WORKFLOWD_CONFIG_RELOAD_FILES=["%h/.config/workflowd/env","%h/.config/workflowd/env.rollout-overrides"]'
```

Systemd expands `%h` in this unit directive. Inside an env file, use absolute
paths; neither `%h`, `$HOME` nor `~` expands there.

The daemon parses these files at startup to remove the names they define from
its base environment snapshot. On reload, later files win over earlier files,
then that base supplies names the files did not own at startup. Deleting a line
therefore removes its startup value; deleting a later override reveals an earlier
file's value. Deleting a route setting clears that route list. Required startup
settings still must be valid: deleting a required repository list rejects reload.
The initial daemon config still uses the startup environment supplied by systemd.
Changing the reload file list needs a restart. All listed files must exist and be
readable at startup and reload; an empty list uses only the startup environment.

Files use systemd-style `NAME=value` assignments: blank lines and full-line `#`
or `;` comments, whole single-quoted or double-quoted values, multiline quoted
values, and backslash continuations. Unquoted outer whitespace is trimmed;
escaped whitespace is kept.
Double quotes preserve backslashes except before `"`, `\`, `$`, and backtick.
There is no shell execution, variable expansion, `export`, or inline comment
syntax. This parser is stricter than systemd: names must match `[A-Za-z_][A-Za-z0-9_]*`
(no dots), and text after a closing quote is rejected rather than concatenated.
Invalid assignments, unfinished quotes and unreadable files reject the
whole reload. Write files atomically so a reload cannot read half an edit.

The full candidate goes through the startup config parser. It is also validated
with the existing infrastructure settings pinned. Nothing changes if either
validation fails. Any invalid setting blocks the whole reload, including a
restart-only setting staged for later. Reloads run in order. Each new dispatch
takes one snapshot;
agent runs and dispatches already in flight keep their original settings.

## What reloads

| Setting group | Decision | Reason |
| --- | --- | --- |
| `WORKFLOWD_AGENT_RUN_REPOSITORIES` | Reload | New dispatches use the new repository paths and allow-list immediately. Removed aliases are refused. |
| `WORKFLOWD_AGENT_RUN_ROUTES`, `WORKFLOWD_AGENT_RUN_CODEX_ROUTES`, `WORKFLOWD_AGENT_RUN_CLAUDE_ROUTES` | Reload | New dispatches resolve aliases against the new lists. Existing accepted choices stay recorded. |
| Agent-run enablement/token, binaries, unit prefix, agent, Claude hosts, timeouts, polling, stall window, retries and worktree retention | Restart | Executors, authentication, custody, watchdogs and the worktree janitor hold startup settings. |
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
service. Enabling a new sandbox or other discovery source still needs a restart.
When agent runs are enabled, `claude:local` is always listed, even without startup
Claude routes. Its native model catalog remains `unsupported`; use route aliases
for Claude dispatch. This does not add model-based Claude selection. With no
startup Claude routes, its preflight is deferred until dispatch, avoiding up to
five seconds of extra startup work. Reloaded routes get the same dispatch-time
readiness check as startup routes.

Each reload emits one `Configuration reload:` line with `changed=` and
`restart_required=` environment names, and `restart_required_groups=` config
groups, or an error code with `changed=none`. A validation error includes
`setting=WORKFLOWD_…` when the error identifies a setting. It prints names only,
never values, file contents, paths or raw parser errors. Groups such as `openCode`
are reported when parsed values changed, including file-backed secrets whose path
stayed the same. Restart requests remain visible
on later reloads until the operator restarts. Reload neither rotates credentials
held by live connections nor reloads arbitrary files behind path settings.

## Reaching Bun through noscope

Noscope must not receive HUP: it forwards the signal to its whole child process
group and revokes credentials during shutdown.

The checked-in unit uses the helper below for both direct Bun and
`noscope run ... -- bun run start`. This also protects existing noscope
`ExecStart` drop-ins when the base unit is updated. For a custom unit, set
this reload command and preserve the existing `ExecStart` and noscope arguments:

```ini
[Service]
ExecReload=
ExecReload=/opt/workflowd/bin/bun /opt/workflowd/deploy/current/src/config-reload-signal.ts $MAINPID
```

Use the same Bun executable and release path as the running daemon. The Linux
helper searches only `MAINPID` and its descendants. It reads `cmdline` and
children of every thread; it does not read `/proc/<pid>/exe` or `cwd`, which
noscope's user namespace can make inaccessible to ExecReload.

A match must name Bun and put the entrypoint directly in the script argument.
An absolute script path must equal the helper's entrypoint path; a relative path
must match its trailing path components (for example, `src/main.ts`). Arguments
to noscope, `bun run start`, or another script do not count. Command lines cannot
prove the working directory of a relative script, so keep one daemon entrypoint
in the service tree. The helper refuses zero or several matches, even if only
one has a handler. It sends HUP to one PID only after `/proc/<pid>/status`
confirms a caught SIGHUP. It does not signal noscope, sibling agents or a process
group. It works with both direct Bun and the `bun run start` wrapper.

If reload is refused, the helper now says why: no matching process, several
matches, no SIGHUP handler, unreadable handler status, or an inspection/delivery
failure. It omits paths and raw OS errors. Missing or inaccessible non-candidates
are skipped while the remaining tree is searched. A successful systemctl reload
confirms signal delivery; inspect the daemon's reload log to confirm validation
and application succeeded.
