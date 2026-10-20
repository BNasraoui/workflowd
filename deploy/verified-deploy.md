# Verified mint deployment (F3/F4)

For configuration-only edits to agent-run repository and route lists, use
[configuration reload](../docs/config-reload.md) after the operator has installed
the SIGHUP-capable daemon and reload unit. Code updates and other setting groups
still use this deployment procedure. With noscope, use the daemon-only reload
helper from that guide; HUP to noscope forwards to its whole child group and
revokes credentials. Workers must leave live rollout and reload to the coordinator.

`verified-deploy.py` is an operator entrypoint for a full merge-result SHA on
freshly fetched `origin/main` in `BNasraoui/workflowd`. Before stopping units or
changing working files, it verifies **every first-parent commit** between the
last successfully deployed SHA and the target, oldest first. Each commit needs:

- A merged PR whose merge-result SHA matches the commit and whose base is this
  repository's main. Direct pushes and rebase merges are refused.
- A completed, successful `Ben approval` check on that PR's final **head SHA**, from
  the merge gate App configured by `--approval-app-id`. This is the App's numeric
  **integration ID**, not its installation ID. GitHub Actions (15368) is refused
  as the approval App. The newest matching check wins;
  missing, stale, pending and unsuccessful evidence is refused. GitHub PR reviews
  are not required: Ben authors the PRs and cannot approve his own review. The
  [protected environment gate from #109](../docs/ben-approval-gate.md) supplies
  Ben's approval and enforces its independent review policy.
- The newest `Required checks` check-run from GitHub Actions (App ID 15368),
  completed successfully for the exact **merge SHA**. It must belong to the newest
  successful main push run of `.github/workflows/ci.yml` for that SHA. PR-head CI
  alone is insufficient. Missing, pending, neutral, skipped, cancelled and failed
  results are refused. Optional OpenCode Review is not a deploy requirement.

Keep main's App-pinned `Ben approval` and GitHub Actions `Required checks`
requirements aligned with this policy. The deploy does not require a self-review
or change GitHub settings. API errors and malformed responses fail closed.
Pagination uses `gh api --paginate` and parses concatenated JSON pages, compatible
with mint's gh 2.45.0; it does not use `--slurp`.

`/opt/workflowd/operator/last-deployed` is the fixed operator-owned mode-0600
state file outside the checkout and skill root. The CLI cannot select another
state destination; changing this path requires reviewing the protected entrypoint.
Its parent must be operator-owned and not writable by others. The script writes
the successful target atomically, with fsync, after install, copy, restart and
unit-state checks. Do not seed or edit the state file to skip history. A missing state or a last-deployed SHA that is not an
ancestor of the target refuses admission unless the operator explicitly supplies
`--bootstrap`. Bootstrap trusts history **before** the target; the target still
needs its own App approval and main CI. Use bootstrap only for a personally
reviewed initial baseline or deliberate recovery/rollback, record the reason,
and omit it on normal deployments. When state is a valid ancestor, all intervening
first-parent commits are checked even if `--bootstrap` was supplied. Redeploying
the same SHA rechecks its evidence. A refused earlier commit blocks the whole
range even when the target itself is approved.

Each deployment creates a new mode-0700 directory under
`/opt/workflowd/deploy/releases/` and a new operator-owned mode-0700 `.git` inside
it. It initializes with an empty template and fetches main plus the exact target
from `https://github.com/BNasraoui/workflowd.git` over HTTPS. Nothing from any
retained release's `.git` is read, copied, hardlinked or reused: no objects, index,
config, refs, hooks or info files. Each attempt, including redeploying the same
SHA or rollback, gets a different directory and an independent full fetch.

The fresh repository must still have independent Git metadata, no worktrees or
object alternates, and canonical HTTPS origin. The local config allow-list and
replacement/graft/sparse/attribute checks remain as defense in depth. Global and
system Git configuration are ignored; hooks and fsmonitor are disabled and only
HTTPS transport is permitted. `GIT_NO_REPLACE_OBJECTS=1` and
`GIT_GRAFT_FILE=/dev/null` disable replacement/grafts, with
`-c advice.graftFileDeprecated=false` suppressing the deprecated-grafts hint.
Fetch object validation is enabled. The stable operator lock and audit log now
live under `/opt/workflowd/operator/`, outside every release. Both are opened with
`O_NOFOLLOW`; symlinks are refused.

The entrypoint replaces its child environment, uses `/usr/bin:/bin`, and loads
only a dedicated read-only token file into `GH_TOKEN` for `gh` calls. Git, Bun and
systemctl never receive the token in their environment. A mode-0700 temporary home under `/opt/workflowd/operator`,
used for HOME, XDG_CONFIG_HOME and GH_CONFIG_DIR exclude the owner's gh login/config (including
`http_unix_socket`), global bunfig and npmrc files. Inherited proxy, Git, Bun/npm
and token overrides are cleared. It requires an absolute pinned Bun executable,
prints tool versions, and refuses Git older than 2.34, gh older than 2.45, or Bun
other than 1.3.14. Run it with Python 3.9+ and `-I` from a trusted shell.

After admission it checks out the exact SHA detached into the new working tree,
runs `git fsck --full --strict --no-dangling`, then compares `HEAD^{tree}` with
GitHub's `commit.tree.sha`. Any failure leaves the active release and services
untouched and removes the unsuccessful staging directory. No retained index stat
cache, skip-worktree bit or object can influence the new checkout.

It removes root `node_modules` before every install, including tracked files,
unlinking symlinks without following them. Installation in the new directory uses
the absolute Bun path with `install --frozen-lockfile --no-cache --backend=copyfile`;
no shared Bun cache or earlier release dependencies are trusted or hardlinked.
Repository-local bunfig/npmrc and lifecycle policy are part of the reviewed
commit. The layout preflight requires `previous` to be absent or a symlink.
After installation and skill validation/copy succeed, it prepares both activation
symlinks in one temporary directory inside the deployment parent. Only then does
it stop the three units and rename the prepared links into `previous` and `current`.
A parent that refuses temporary-directory or link creation leaves units running.
The `current` replacement uses a single rename on the same filesystem. Units
use `/opt/workflowd/deploy/current` as their stable WorkingDirectory; the old
release remains on disk unchanged. Activation is atomic for the service path;
skill copies, service restarts and the state write are separate operations.

Tracked `skills/rpi-*` blobs are copied using NUL-delimited Git filenames, preserving
executable modes. Symlinks/submodules are refused. The destination must already
contain the regular marker file `.workflowd-verified-skills` before any deletion;
create it only in a dedicated managed root. Existing links are replaced without
following them and obsolete RPI directories are removed. Never mark a general
skill home as managed. The three units are then restarted and checked as active.

JSON records in `/opt/workflowd/operator/verified-deploy.jsonl` and stdout contain
target and previous SHA, release and previous-release paths, bootstrap status,
state path, every admitted commit's PR/head, approval App/check IDs, GitHub tree
SHA, CI check/run IDs, UTC time, paths, units and outcome. `verified` records API
admission; only `deployed` plus the state file indicate successful activation.
Install/integrity failures leave services running and the old link unchanged.
Skill validation/copy failures also leave services running; skill copies may be
partially updated. Activation/restart failures can leave units stopped; after activation the
new release and previous release are both retained, and unsuccessful deployment
does not advance state. There is no automatic unverified rollback. Unit state is
not application health: the operator must validate that separately.

## Layout, disk use and rollback

```text
/opt/workflowd/deploy/                 operator-owned, 0755; protected ancestors
  current -> releases/<sha>-<random>  atomically replaced service path
  previous -> releases/<sha>-<random> preceding activation, retained for recovery
  releases/                          operator-owned, 0700
    <sha>-<random>/                   fresh working tree, 0700
      .git/                          independent Git directory, 0700
      node_modules/                  separately installed dependencies
/opt/workflowd/operator/              operator-owned, 0700
  last-deployed                      last successful SHA, 0600
  verified-deploy.lock                stable deployment lock, 0600
  verified-deploy.jsonl               append-only audit records, 0600
  github-token                       dedicated read-only token, 0600
/opt/workflowd/skills/                 separately managed skill copies
```

Reserve disk for **current + previous + one staging release**, each containing a
full independent Git history, working tree and installed dependencies. Every
attempt downloads its own history; no alternates, shared objects or install
cache reduce this cost. Successfully activated releases are never automatically
deleted, so disk use grows until the operator prunes older releases. Inspect
`du -sh /opt/workflowd/deploy/releases/*` and available space before deployment.
After checking audit records and confirming no process still uses a candidate,
prune explicitly named releases with the protected entrypoint:

```bash
/usr/bin/python3 -I /usr/local/libexec/workflowd/verified-deploy.py \
  --checkout /opt/workflowd/deploy/current --prune OLD_SHA_RANDOM_DIRECTORY_NAME
```

Pass directory basenames from `releases/`, never paths or globs. The command takes
the same nonblocking `/opt/workflowd/operator/verified-deploy.lock` as deployment,
resolves `current` and `previous` under that lock, and refuses either target.
It requires `releases/` to already exist, checks the entire request before deletion,
and rejects symlinks, traversal, missing candidates and invalid link layouts.
Under the lock it checks each workflowd unit's `MainPID`, `ControlGroup`
(including descendant cgroups), `WorkingDirectory`, `ExecStart`, `ExecStartPre/Post`,
`ExecStop/Post`, `ExecReload` and `Environment=PATH`, plus the operator's processes'
`/proc` `cwd`, `exe` and `root` links. A path resolving inside any candidate refuses
the whole request. Systemd's leading `!` WorkingDirectory marker is stripped;
`~` means the operator's home; other non-absolute directories are refused.
Unit inspection failures and unreadable MainPIDs or cgroup members always refuse
pruning. For other unreadable operator processes (such as `(sd-pam)`), the command
prints each PID, comm and cgroup and refuses until the operator has checked them
and repeats the command with `--allow-unreadable PID` for each acknowledged PID.
Acknowledgements apply only to unreadable links; readable links still block
deletion when they point into a candidate. Never reuse an acknowledgement without
checking the process again, since PIDs can be recycled. Processes that exit during
inspection are skipped. Lock contention refuses the command; retry after the
other operation finishes. Pruning needs no GitHub token or Bun.
Drain consumers before pruning and prevent new consumers from starting during
the operation: the deploy lock cannot prevent an unrelated process from opening
a release after inspection. Processes under other UIDs are inspected only when
named by a unit's MainPID or cgroup; retained open files or imports alone are not
detected. EnvironmentFile contents and dynamically constructed shell paths are
not inspected.
Do not manually
change links outside the lock. Interrupted preparation can leave an unreferenced
staging directory; inspect it using the same procedure. Deletion I/O failures may
leave a partially pruned request; inspect the printed removed paths before retrying.

For rollback, take the previous successful SHA from `last-deployed` (after a
failed deploy) or the audit log's `previous_sha`, and record the recovery reason.
Run the protected entrypoint with that SHA and explicit `--bootstrap` if it is
not a forward deployment. The script rechecks current approval/main-CI evidence,
fetches into another fresh directory, reinstalls dependencies and recopies skills
before atomic activation. **Do not repoint `current` directly to `previous` or
reuse its `.git`**: retained releases preserve the old files for recovery and
inspection, but cannot be trusted as inputs to a new verified deployment. Do not
edit state to bypass verification. If fresh verification is unavailable, leave
services stopped and escalate to the operator; there is no offline bypass.

## Operator migration on mint

These are manual steps; this PR changes no live host, App, credentials or ruleset.
Drain active work in a maintenance window. Keep `update-dev-infra.timer` disabled
and retire its old checkout/linking path. `update-dev-infra.example` and
`link-agent-skills.sh` remain developer tools, not production entrypoints.

1. Establish a separate agent Unix UID; stop/migrate agents still running as Ben.
   Ownership cannot isolate same-UID processes. Deny sudo/polkit escalation and
   access to the operator's user systemd bus, including `systemctl --user
   set-environment`. Deny writes to `~/.config/environment.d`, units/drop-ins,
   executables, Git configuration, deployment entrypoint and all their ancestors.
   Audit inherited systemd manager variables before launching the entrypoint:
   environment.d and set-environment values reach transient units, and can affect
   the interpreter before its own sanitization. Agents must **not read** Ben's
   `~/.config/gh/hosts.yml`, any owner `GH_TOKEN`/`GITHUB_TOKEN`, workflowd env files
   (including `~/.config/workflowd/env` and rollout overrides), or approval/admin
   credentials. Also deny writes to gh `config.yml`, whose `http_unix_socket` can
   redirect API traffic. Follow the [agent-user runbook](../docs/agent-user.md).
2. Record the existing deployed SHA and unit WorkingDirectory/ExecStart without
   copying secrets into reports. Stop the three units. Move the old worktree out
   of the service path with its owning repository's `git worktree move`, or retain
   it and use the new path below. Do not copy its Git metadata, hooks, configuration
   or node_modules into the new clone.
3. Create protected operator directories under a root-owned parent. Example owner:
   `ben`. Deny agent write ACLs/group access and replacement via ancestors.

   ```bash
   sudo install -d -o root -g root -m 0755 /opt/workflowd
   sudo install -d -o ben -g ben -m 0755 /opt/workflowd/deploy /opt/workflowd/skills
   sudo install -d -o ben -g ben -m 0700 /opt/workflowd/operator
   install -m 0644 /dev/null /opt/workflowd/skills/.workflowd-verified-skills
   sudo install -d -o ben -g ben -m 0700 /opt/workflowd/deploy/releases
   ```

   Leave `/opt/workflowd/deploy/current` absent for the first deployment. Do not
   pre-clone or copy any old `.git` there; the entrypoint creates every repository.
   For an installation using the earlier standalone-clone layout at
   `/opt/workflowd/deploy`, stop units and move that entire directory to a named
   backup before creating this layout. Retain its audit log separately. Never
   migrate its Git metadata into `releases` as deployment input.

   Provision a **dedicated fine-grained read-only GitHub token**, restricted to this
   repository with Contents, Checks, Actions and Pull requests read permissions
   (plus mandatory Metadata). Store it as `/opt/workflowd/operator/github-token`,
   owned by Ben, mode 0600. Provision from a trusted operator session without
   putting the value in shell history, argv, reports or logs. Never copy the
   owner's gh login or use its approval/admin token. The deploy reads this file
   into GH_TOKEN only for gh calls; inherited GH_TOKEN/GITHUB_TOKEN are discarded. Keep the
   last-deployed file absent until the first successful bootstrap deployment.
4. Activate #109's [Ben approval gate](../docs/ben-approval-gate.md) from a trusted
   workstation: dedicated Checks-write App, protected `ben-merge-approval`
   environment with Ben as reviewer, exact main branch selection, and App-pinned
   `Ben approval` in the main ruleset alongside `Required checks`, strict checks
   and no bypass. **Limit merge methods to merge and squash; rebase merges can
   never be deployed.** Do not raise the required PR review count to force a self-review.
   Before the first `--bootstrap`, record the selected full merge SHA, PR URL,
   App approval and main CI links, the earlier history personally audited, and
   why that SHA is an acceptable trust baseline. Add this rationale to the rollout
   Bead with `bd comment <rollout-bead> 'Bootstrap baseline <SHA>: <reason and evidence>'`
   from the trusted workstation; retain it with the operator deployment record.
   The automatic log records bootstrap use but does not explain the operator's choice.
   Record the App's integration ID for the command below. Obtain this PR's merged
   entrypoint from a trusted operator session, verify its evidence, and separately
   review/install it outside the clone. Future entrypoint updates require the same
   review; deployment does not overwrite the protected copy.

   ```bash
   sudo install -d -o root -g root -m 0755 /usr/local/libexec/workflowd
   sudo install -o root -g root -m 0755 /path/to/reviewed/verified-deploy.py \
     /usr/local/libexec/workflowd/verified-deploy.py
   ```

   Install pinned Bun 1.3.14 as `/opt/workflowd/bin/bun` in a root/operator-owned
   directory with protected ancestors. Do not use an agent-writable `~/.bun/bin`.
5. Repoint `workflowd.service`, `workflowd-runner.service` and
   `workflowd-mcp.service` WorkingDirectory and absolute ExecStart paths to the
   stable `/opt/workflowd/deploy/current` path and pinned binaries. The checked-in
   [controller](systemd/workflowd.service), [runner](systemd/workflowd-runner.service)
   and [MCP](systemd/workflowd-mcp.service) examples use that WorkingDirectory and
   `/opt/workflowd/bin/bun` with absolute entrypoint paths. Review existing drop-ins:
   they can override both settings. Preserve operator-owned credential/env files
   outside the release directories. Run `systemctl --user daemon-reload`. All three units must
   exist. Audit any service Bun configuration/cache separately; deploy isolation
   does not rewrite service environments.
6. Choose an approved merged SHA after its **post-merge main CI finishes**. The
   first baseline must itself have a successful App check on its PR head; legacy
   merges without this evidence cannot be deployed, even with bootstrap. Personally
   audit the earlier history trusted by the initial bootstrap and record why as
   described in step 4.
   Run from a trusted operator session using the explicit paths below:

   ```bash
   cd /opt/workflowd
   deploy_sha=FULL_40_CHARACTER_MERGE_SHA
   approval_app_id=NUMERIC_MERGE_GATE_APP_ID
   systemd-run --user --wait --pipe --collect \
     -p MemoryMax=4G -p MemorySwapMax=0 \
     --working-directory=/opt/workflowd --setenv=PATH=/usr/bin:/bin \
     /usr/bin/python3 -I /usr/local/libexec/workflowd/verified-deploy.py \
       "$deploy_sha" --checkout /opt/workflowd/deploy/current --skills /opt/workflowd/skills \
       --github-token-file /opt/workflowd/operator/github-token \
       --approval-app-id "$approval_app_id" --bun /opt/workflowd/bin/bun --bootstrap
   ```

   **Remove `--bootstrap` on every normal subsequent deployment.** Keep the App ID
   in operator-owned launch configuration. For rollback, explicitly
   bootstrap a previously approved merge SHA after checking its current evidence;
   do not edit state manually or run the legacy deploy path.
7. Configure harness discovery or protected links to `/opt/workflowd/skills/rpi-*`.
   Remove old agent-worktree links; do not run the legacy linker again. Protect
   harness skill roots and ancestors too. If harness homes must be agent-writable,
   use a separate read-only/operator-owned skill search root and do not treat
   writable-home skills as trusted policy.
8. Verify HEAD, state SHA, full range evidence in the deployment log, unit status
   and application health. Audit ownership, modes and ACLs with `namei -l` and
   `getfacl`, including `.git`, node_modules, marker/skills, state/token parents,
   executables and service configuration. Confirm hooks/fsmonitor are disabled and
   prohibited local Git config and replacement/graft/sparse/attribute files absent. Audit `~/.bunfig.toml`,
   `$XDG_CONFIG_HOME/.bunfig.toml`, `~/.npmrc`, gh hosts/config, and Bun install cache
   (`~/.bun/install/cache` or BUN_INSTALL_CACHE_DIR). The deploy ignores global
   files and uses no cache; services or manual commands may still use them. If a
   cache is later enabled, it must be operator-owned (for example under
   `/opt/workflowd`) and installs must retain `--backend=copyfile`. As the agent UID,
   prove no secret read access and no writes to these files or replaceable ancestors.
   Keep runtime state in explicitly writable separate directories. Retire the old
   worktree only after validation.

Unix accounts, ACLs, token scope, the operator shell and user-bus isolation are
operator prerequisites; a same-UID script cannot establish them. Never use the
release directories as an agent worktree source.

## Tests

```bash
systemd-run --user --wait --pipe --collect \
  -p MemoryMax=4G -p MemorySwapMax=0 --working-directory="$PWD" \
  python3 -B -m unittest discover -s test/deploy -v
```

Deployment (systemd) CI runs these focused tests. They use disposable repositories,
offline GitHub fixtures and the **real installed gh argument list**, with a local
Unix HTTP socket for paginated responses. No host units restart, no credentials
are read, and no external GitHub API is called. Tests cover App/head binding,
unchanged CI/suite checks, range refusal, bootstrap, state persistence, environment
isolation, Git configuration, skill copying, fresh-directory attack regressions
(skip-worktree, forged index stat data and poisoned loose objects), fsck failure,
atomic activation and retained-release recovery.
