# Ben approval for main

The F1 gate adds the `Ben approval` check, produced by a dedicated GitHub App on
the exact PR head SHA. Ben releases the signing job through the
`ben-merge-approval` environment. This works for Ben-authored PRs without requiring
him to approve his own PR review. `Required checks` remains independently required.

The implementation is dormant until Ben completes the console setup below. This
PR does not change any ruleset, environment, App, secret, or mint configuration.

## Trust boundary and prerequisites

- Ben performs setup and approvals from a trusted workstation/browser. Generate
  and retain the App private key there; never copy it to mint, repository files,
  repository-wide secrets, agent sessions, logs, PRs, or beads.
- **A credential on mint that can act as Ben to approve deployments or administer
  repository/App settings defeats this boundary.** Before calling F1 resolved,
  Ben must ensure all agent-accessible credentials lack those rights and ruleset
  bypass rights. Separating the App key alone does not distinguish Ben from a
  token acting as Ben. This is an operator prerequisite, not a change made here.
- Required environment reviewers must be supported by the repository's GitHub
  plan/visibility. If the reviewer control is unavailable, stop activation.
- The App has only repository **Checks: Read and write**, plus GitHub's mandatory
  **Metadata: Read-only**. It cannot merge, edit contents, approve environments,
  or administer the repository. The workflow's separate `GITHUB_TOKEN` has only
  the read permissions needed to load trusted code and inspect approval/reviews.
- The environment must select **Branches: main** explicitly, with no tag rule.
  “Protected branches only” is broader and is not sufficient for this gate.
  No administrator bypass is allowed on the environment or main ruleset.

## Console setup (Ben only)

1. On GitHub, avatar → **Settings → Developer settings → GitHub Apps → New GitHub
   App**. Choose a unique name, for example `workflowd-ben-approval`, and set the
   homepage to `https://github.com/BNasraoui/workflowd`. Disable **Webhook → Active**.
   Do not enable user authorization, device flow, or request user permissions.
   Under **Repository permissions**, select only **Checks: Read and write**;
   leave all other optional repository, organization, and account permissions at
   **No access**. Metadata read access is automatic. Select **Only on this account**
   for installation and create the App.
2. On the App's **General** page, record its numeric **App ID**. This is the
   ruleset **integration_id**; it is not the installation ID, client ID, or bot user
   ID. Click **Generate a private key** on the trusted workstation. Store the
   downloaded PEM securely without printing it.
3. App settings → **Install App → BNasraoui → Only select repositories → workflowd
   → Install**. Confirm only Checks write and Metadata read in the installation.
4. Repository **Settings → Environments → New environment**, name exactly
   `ben-merge-approval`. Under **Deployment protection rules**, enable **Required
   reviewers**, select only **BNasraoui (Ben)**, and save. Leave **Prevent
   self-review** unchecked: Ben must be able to dispatch and approve his own run.
   Uncheck **Allow administrators to bypass configured protection rules** and save.
5. In that environment, **Deployment branches and tags → Selected branches and
   tags → Add deployment branch or tag rule → Branch → main**. Remove any other
   branch/tag patterns. In **Environment variables**, add `BEN_APPROVAL_APP_ID`
   with the numeric App ID. In **Environment secrets**, add
   `BEN_APPROVAL_PRIVATE_KEY` with the PEM contents using the console. Neither is
   a repository-wide secret. Do not place the key anywhere on mint.
6. Review and merge the implementation PR using the existing process. The workflow
   must exist on `main` before dispatch. This initial bootstrap merge is not
   evidence that the new gate is enforced. Ben should personally review changes
   to the gate workflow, script, and policy snapshot on future PRs as well.
7. Use a small open, non-draft verification PR targeting `main`, with green CI
   and completed independent review. Record its full current head SHA. Go to
   **Actions → Ben approval gate → Run workflow**, choose branch **main**, enter
   `pr_number` and the exact lowercase 40-character `head_sha`, then run. Inspect
   the run title and PR diff at that SHA. The job must wait at the environment.
   **Review deployments → ben-merge-approval → Approve and deploy** releases it.
   Verify the PR has `Ben approval: success`, authored by the new App, linking to
   that run. Do this within seven days of selecting the required check so it
   appears in GitHub's selector. Do not merge the verification PR yet.
8. Repository **Settings → Rules → Rulesets → Main: PR and checks → Edit**.
   Preserve the existing rules and `refs/heads/main` target. Keep enforcement
   **Active** and bypass list empty. Under **Require status checks to pass**,
   retain `Required checks` with source **GitHub Actions** and add **Ben approval**
   with the dedicated App as its expected source, **not Any source**. Enable
   **Require branches to be up to date before merging** (strict status checks).
   Keep **Require a pull request before merging**; the PR approval count can
   remain zero because the environment supplies Ben's approval. Save.
9. Read back the ruleset (console or read-only command below) and verify these
   parameters, substituting the App's numeric ID:

   ```json
   {
     "type": "required_status_checks",
     "parameters": {
       "required_status_checks": [
         { "context": "Required checks", "integration_id": 15368 },
         { "context": "Ben approval", "integration_id": "APP_ID_AS_INTEGER" }
       ],
       "strict_required_status_checks_policy": true,
       "do_not_enforce_on_create": false
     }
   }
   ```

   The quoted App placeholder above must be a JSON integer in the actual
   ruleset. The currently observed ruleset ID is `24696059`; locate it by name
   if it has been recreated. Read-only verification:

   ```sh
   gh api repos/BNasraoui/workflowd/rulesets/24696059 \
     --jq '{enforcement, bypass_actors, conditions, rules}'
   ```

   If the console cannot select the dedicated App source, stop activation and
   resolve that configuration; a name-only required check does not establish
   the intended boundary. Do not add the App to any bypass list.

## Normal operation and acceptance checks

Finish CI and independent review, update the branch with `main` if required,
then dispatch and approve as in step 7. Every new head needs another dispatch
and environment approval. Agents may request a run but cannot release it under
the credential prerequisite above. Re-running jobs is refused (`run_attempt`
must equal 1); start a new dispatch after resolving a refusal.

Before considering rollout complete, Ben should verify on the verification PR:

- A new commit has no successful App approval, and merging is blocked even when
  `Required checks` succeeds. The previous head's approval does not carry forward.
- Before environment approval, no App check is posted. Rejecting the deployment
  leaves merging blocked. An approved fresh dispatch on the current head succeeds.
- A dispatch with an old SHA, another ref, a closed/draft PR, or a PR targeting
  another base never posts success on the new head.
- A requested reviewer/team, visible pending draft review, outstanding change
  request, queued/in-progress check (including optional `OpenCode Review`), or
  pending commit status causes refusal. Finish the review before a fresh dispatch.
- Both required contexts have the expected App sources, strict checks are on,
  and the branch must be current with `main`. Keep the verification PR/check and
  run URLs as rollout evidence, without credentials or personal contact data.

The gate reads paginated review/check/status data after Ben approves, repeats
validation after token creation, and re-reads the PR immediately before posting.
Unknown API responses and API failures refuse approval. It also refuses failed
checks/statuses and requires successful `Required checks` from GitHub Actions.
The App token is repository-scoped, Checks-write only, and revoked by the pinned
token action's post step. No PR code, dependency install, artifact, or cache is
loaded into the approval job; checkout uses the dispatched `main` commit SHA.

GitHub may hide another reviewer's unsubmitted draft. Off-platform reviews are
also invisible. Ben must confirm those reviews have finished before releasing
the job. API reads and check creation are not atomic: review state can change
after validation, and an approval on the same SHA is not automatically revoked.
If review restarts after approval, Ben must hold the merge; if approval must be
invalidated, advance the PR head and request a fresh approval. Strict checks
handle base updates, and SHA binding prevents approval of a different head.

## Rollback and recovery (Ben only)

For a broken job or suspected key exposure, disable **Actions → Ben approval
gate → … → Disable workflow**, cancel queued/in-progress runs, and revoke the
App's key/installation as appropriate. Leave the required App check in place
to keep new merges blocked. Previously approved heads need separate operator
attention; disabling the workflow does not invalidate existing checks.

Preferred recovery: fix through a reviewed PR, restore a trusted key in the
protected environment if needed, re-enable the workflow, and dispatch a fresh
approval. If the broken gate prevents that merge, Ben may temporarily remove
only the `Ben approval` requirement under a supervised maintenance window,
keeping PRs, `Required checks`, strict checks, and the empty bypass list. This
temporarily restores the pre-gate approval gap. Record the window and restore
the App-pinned requirement immediately after the fix.

For permanent rollback, Ben removes only `Ben approval` from the ruleset,
disables the workflow, removes the environment key, and uninstalls the dedicated
App after active runs finish or are canceled. Retain existing PR/CI protection
and strict checks. Record F1 as unresolved until a replacement human gate exists.

## Validation and references

Focused local tests: `bun test test/approval-gate test/sandbox/ci-policy.test.ts`.
The CI Repository integrity job runs pinned actionlint on this workflow:
`go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 .github/workflows/ben-approval.yml`.
Policy tests reject changes to the reviewed workflow's trust boundaries; a
deliberate workflow edit requires reviewing and updating its SHA-256 snapshot
in `src/sandbox/ci-policy.ts`. Full suites run in CI. Live activation tests require
Ben's console setup and cannot be replaced by the local API fixtures.

GitHub references: [environment setup and availability](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments),
[environment reviewers and self-review](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[ruleset checks and expected sources](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
[workflow approval history and deployment review API](https://docs.github.com/en/rest/actions/workflow-runs),
[review API](https://docs.github.com/en/rest/pulls/reviews),
[App creation](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
