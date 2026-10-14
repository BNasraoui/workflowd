# Verified mint deployment (F3/F4)

`verified-deploy.py` is an operator entrypoint. It deploys an explicit full SHA
only after fetching `origin/main` from `BNasraoui/workflowd` and verifying:

- The SHA is a commit reachable from the fetched main branch.
- GitHub associates it with the merge result of a PR into this repository's main.
  At least one human owner, member or collaborator other than the author approved
  the final PR head. Dismissed or superseded approvals and outstanding change
  requests fail admission. Direct pushes and intermediate rebase commits are
  deliberately refused; select the PR's final merge-result SHA.
- The newest `Required checks` check-run from GitHub Actions (App ID 15368) is
  completed with conclusion `success` for that exact SHA. Missing, pending,
  neutral, skipped, cancelled and failed results are refused.
- That check belongs to the newest push run of `.github/workflows/ci.yml` for
  the same SHA on main, and the workflow completed successfully. PR-head CI alone
  is insufficient. Optional OpenCode Review is not a deploy requirement.

This pins the repository's existing aggregate gate, which depends on all blocking
CI jobs. Operators must keep the main ruleset and this policy aligned if the gate
is renamed or new required checks are added outside that aggregate. Review policy
is deliberately conservative and does not offer an override switch. API failures,
missing evidence and malformed responses fail closed. Paginated check-run,
workflow-run, PR and review responses are all consumed.

The script requires a standalone clone: a real local `.git` directory, no linked
worktrees and no object alternates. It disables global/system Git configuration,
clears inherited Git environment overrides, uses `core.hooksPath=/dev/null` on
commands and persists that setting in the clone. It serializes deployments using
a lock inside `.git`.

After admission, it stops the three workflowd units, resets and cleans the tree,
checks out the exact SHA detached, resets and cleans again, runs
`bun install --frozen-lockfile`, materializes tracked `skills/rpi-*` blobs into a
dedicated skill directory, and restarts and checks all three units. Clean uses
`git clean -ffdx -e node_modules`; the retained dependency tree must already be
operator-owned. It is never copied from an agent checkout. Skill symlinks and
submodules are not accepted as skill content. Skill copies come from Git blobs,
not dirty working files, preserve executable modes, replace old links without
following them, and remove obsolete RPI directories in this dedicated target.
Do not point `--skills` at a general-purpose skill home.

JSON records in `<checkout>/.git/verified-deploy.jsonl` and stdout include the
full SHA, PR number, check/run IDs, UTC time, paths, units and outcome (`verified`,
`deployed`, or `failed`). A verification refusal does not stop units or modify the
working tree. An install/copy/restart failure records failure and requires operator
recovery; there is no automatic unverified rollback. Units can remain stopped.
Use the same entrypoint with a previously verified merge SHA to roll back.
`is-active` checks unit state; application health still needs operator validation.

## Operator migration on mint

These are manual steps; adding this code does not change the live host. Schedule
a maintenance window and drain active work before stopping the units. Keep
`update-dev-infra.timer` disabled. Retire its old workflowd checkout/linking path;
`update-dev-infra.example` and `link-agent-skills.sh` are legacy developer tools,
not production entrypoints. Do not schedule either against the new clone.

1. Establish a distinct agent Unix account before calling the deployment isolated.
   Processes running as the deploy owner can write its files regardless of mode
   bits. Stop or migrate agent processes still using the operator UID. The agent
   account must have no sudo/polkit route to become the deploy owner, no access to
   its user systemd bus, and no writable path to its credentials, executables,
   Git configuration, service/drop-in files or deployment entrypoint. Follow the
   separate [agent-user runbook](../docs/agent-user.md) for the broader migration.
2. As an operator, record the old deployed SHA and unit WorkingDirectory/ExecStart
   settings without copying credentials into reports. Stop the three units. Move
   the old worktree out of the service path with `git worktree move` from its owning
   repository, or retain it in place and use the new path below. Never copy its
   `.git` file, object store, hooks, configuration or node_modules into the clone.
3. Create an operator-owned standalone clone under a root-owned parent. Example
   commands below assume the existing operator account is `ben`. Keep the protected
   parent root-owned; only the child deployment and skill directories are writable
   by the operator. Do not grant the agent UID write ACLs or membership in a group
   with write permission. The GitHub credential used for verification needs only
   read access to repository contents, checks, Actions and pull requests.

   ```bash
   sudo install -d -o root -g root -m 0755 /opt/workflowd
   sudo install -d -o ben -g ben -m 0755 /opt/workflowd/deploy /opt/workflowd/skills
   umask 022
   env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR \
     GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
     git -c core.hooksPath=/dev/null clone --no-checkout \
       --config core.hooksPath=/dev/null \
       https://github.com/BNasraoui/workflowd.git /opt/workflowd/deploy
   ```

4. Bootstrap the entrypoint as a separately reviewed, root-owned file outside the
   checkout. Obtain this PR's merged script from a trusted operator session, verify
   its SHA and review/CI evidence, and install it as below. Do not execute a script
   supplied by an agent worktree to establish the trust boundary. Future entrypoint
   updates need the same operator review; deployments do not overwrite this copy.

   ```bash
   sudo install -d -o root -g root -m 0755 /usr/local/libexec/workflowd
   sudo install -o root -g root -m 0755 /path/to/reviewed/verified-deploy.py \
     /usr/local/libexec/workflowd/verified-deploy.py
   ```

5. Repoint the existing operator user units `workflowd.service`,
   `workflowd-runner.service` and `workflowd-mcp.service` to
   `/opt/workflowd/deploy`. Inspect both WorkingDirectory and any absolute ExecStart
   paths, including drop-ins. Preserve credentials and environment configuration;
   do not copy secrets into the clone. Run `systemctl --user daemon-reload`.
   All three units must exist; the script does not silently skip missing units.
6. Use operator-installed Git, Python 3.9+, gh and pinned Bun (currently 1.3.14),
   all outside agent-writable paths. Execute from a trusted working directory,
   with a trusted PATH and operator gh configuration. Choose a reviewed merged
   SHA whose **post-merge main CI has finished**, then deploy in a capped unit:

   ```bash
   cd /opt/workflowd
   deploy_sha=FULL_40_CHARACTER_MERGE_SHA
   systemd-run --user --wait --pipe --collect \
     -p MemoryMax=4G -p MemorySwapMax=0 \
     --working-directory=/opt/workflowd \
     --setenv="PATH=$PATH" \
     /usr/bin/python3 -I /usr/local/libexec/workflowd/verified-deploy.py \
       "$deploy_sha" --checkout /opt/workflowd/deploy --skills /opt/workflowd/skills
   ```

7. Configure harness skill discovery to read `/opt/workflowd/skills`, or replace
   each old RPI link in the managed harness skill roots with a link to its
   `/opt/workflowd/skills/rpi-*` copy. Those destinations contain verified files,
   not symlinks into a writable source tree. Protect managed skill roots and their
   ancestors from the agent UID too; remove old links to agent worktrees. Do not
   run the legacy linker afterward. If harness homes must remain agent-writable,
   use a separate operator-owned skill search directory/read-only mount and do
   not treat skills discovered in writable homes as trusted policy.
8. Confirm the new HEAD, `.git` directory, `core.hooksPath`, successful deployment
   record, unit state and application health. Review ownership, mode bits and ACLs
   on the checkout (including `.git` and node_modules), skill copies and every
   ancestor with `namei -l` and `getfacl`. As the future agent account, verify read
   access where needed and **no write access** to those paths, the entrypoint,
   service configuration or their parents. Do not grant write/traverse exceptions
   that permit replacement through an ancestor. Keep runtime state in separate
   explicitly writable directories. Retire the old worktree only after validation.

The script enforces Git and GitHub admission; Unix account, ACL and service-bus
isolation are operator prerequisites, not properties a same-UID script can create.
The clone must never become a worktree source for agents. GitHub console follow-up:
require at least one approval of the final PR head (dismiss stale approvals),
retain the GitHub Actions `Required checks` gate, and restrict bypass permissions. No ruleset, App, environment or secret changes
are made by this PR. Deployment requires separate operator action after merging.

## Tests

```bash
systemd-run --user --wait --pipe --collect \
  -p MemoryMax=4G -p MemorySwapMax=0 --working-directory="$PWD" \
  python3 -B -m unittest discover -s test/deploy -v
```

The existing Deployment (systemd) CI job runs these tests, and `Required checks`
already depends on that job. Tests use disposable Git repositories and offline
GitHub fixtures; they never restart host units or install dependencies.

API contracts: [check-runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference),
[workflow runs](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow),
and [PR reviews](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request).
