# Verified mint deployment (F3/F4)

`verified-deploy.py` is an operator entrypoint for a full merge-result SHA on
freshly fetched `origin/main` in `BNasraoui/workflowd`. Before stopping units or
changing working files, it verifies **every first-parent commit** between the
last successfully deployed SHA and the target, oldest first. Each commit needs:

- A merged PR whose merge-result SHA matches the commit and whose base is this
  repository's main. Direct pushes and intermediate rebase commits are refused.
- A completed, successful `Ben approval` check on that PR's final **head SHA**, from
  the merge gate App configured by `--approval-app-id`. This is the App's numeric
  **integration ID**, not its installation ID. The newest matching check wins;
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

The script requires a standalone clone, independent Git metadata, no worktrees or
object alternates, and canonical HTTPS origin. It ignores global/system Git
configuration; every wrapper command disables hooks and fsmonitor and permits
only HTTPS transport. Before using the clone it reads local config without
following includes and refuses `include*`, `filter.*`, `core.fsmonitor`,
`credential.*`, `http.*`, `url.*`, worktree config, and `.git/info/attributes`.
It serializes operators with a lock in `.git`.

The entrypoint replaces its child environment, uses `/usr/bin:/bin`, and loads
only a dedicated read-only token file into `GH_TOKEN`. A mode-0700 temporary home under `/opt/workflowd/operator`,
used for HOME, XDG_CONFIG_HOME and GH_CONFIG_DIR exclude the owner's gh login/config (including
`http_unix_socket`), global bunfig and npmrc files. Inherited proxy, Git, Bun/npm
and token overrides are cleared. It requires an absolute pinned Bun executable,
prints tool versions, and refuses Git older than 2.34, gh older than 2.45, or Bun
other than 1.3.14. Run it with Python 3.9+ and `-I` from a trusted shell.

After admission it stops all three units, resets and cleans, checks out the exact
SHA detached, and resets/cleans again. Clean uses `git clean -ffdx -e /node_modules`:
only the root dependency tree survives. That retained tree must be operator-owned
and never copied from an agent checkout. Installation uses the absolute Bun path
with `install --frozen-lockfile --no-cache --backend=copyfile`; no shared Bun cache
is trusted or hardlinked. Repository-local bunfig/npmrc and lifecycle policy are
part of the reviewed commit.

Tracked `skills/rpi-*` blobs are copied using NUL-delimited Git filenames, preserving
executable modes. Symlinks/submodules are refused. The destination must already
contain the regular marker file `.workflowd-verified-skills` before any deletion;
create it only in a dedicated managed root. Existing links are replaced without
following them and obsolete RPI directories are removed. Never mark a general
skill home as managed. The three units are then restarted and checked as active.

JSON records in `<checkout>/.git/verified-deploy.jsonl` and stdout contain target
and previous SHA, bootstrap status, state path, each admitted commit's PR/head,
approval App/check IDs, CI check/run IDs, UTC time, paths, units and outcome.
A verification refusal leaves units running and working files untouched.
Install/copy/restart failure records failure and requires operator recovery;
units can remain stopped. There is no automatic unverified rollback. Unit state
is not application health: the operator must validate that separately.

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
   env -i PATH=/usr/bin:/bin HOME=/opt/workflowd/operator \
     GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
     git -c core.hooksPath=/dev/null -c core.fsmonitor=false \
       -c protocol.allow=never -c protocol.https.allow=always \
       clone --no-checkout --config core.hooksPath=/dev/null \
       https://github.com/BNasraoui/workflowd.git /opt/workflowd/deploy
   ```

   Provision a **dedicated fine-grained read-only GitHub token**, restricted to this
   repository with Contents, Checks, Actions and Pull requests read permissions
   (plus mandatory Metadata). Store it as `/opt/workflowd/operator/github-token`,
   owned by Ben, mode 0600. Provision from a trusted operator session without
   putting the value in shell history, argv, reports or logs. Never copy the
   owner's gh login or use its approval/admin token. The deploy reads this file
   into GH_TOKEN itself; inherited GH_TOKEN/GITHUB_TOKEN are discarded. Keep the
   last-deployed file absent until the first successful bootstrap deployment.
4. Activate #109's [Ben approval gate](../docs/ben-approval-gate.md) from a trusted
   workstation: dedicated Checks-write App, protected `ben-merge-approval`
   environment with Ben as reviewer, exact main branch selection, and App-pinned
   `Ben approval` in the main ruleset alongside `Required checks`, strict checks
   and no bypass. Do not raise the required PR review count to force a self-review.
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
   protected clone and binaries. Preserve operator-owned credential/env files
   outside the clone. Run `systemctl --user daemon-reload`. All three units must
   exist. Audit any service Bun configuration/cache separately; deploy isolation
   does not rewrite service environments.
6. Choose an approved merged SHA after its **post-merge main CI finishes**. The
   first baseline must itself have a successful App check on its PR head; legacy
   merges without this evidence cannot be deployed, even with bootstrap. Personally
   audit the earlier history trusted by the initial bootstrap and record why.
   Run from a trusted operator session using the explicit paths below:

   ```bash
   cd /opt/workflowd
   deploy_sha=FULL_40_CHARACTER_MERGE_SHA
   approval_app_id=NUMERIC_MERGE_GATE_APP_ID
   systemd-run --user --wait --pipe --collect \
     -p MemoryMax=4G -p MemorySwapMax=0 \
     --working-directory=/opt/workflowd --setenv=PATH=/usr/bin:/bin \
     /usr/bin/python3 -I /usr/local/libexec/workflowd/verified-deploy.py \
       "$deploy_sha" --checkout /opt/workflowd/deploy --skills /opt/workflowd/skills \
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
   prohibited local Git config/attributes absent. Audit `~/.bunfig.toml`,
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
protected clone as an agent worktree source.

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
isolation, Git configuration, cleanup and skill copying.
