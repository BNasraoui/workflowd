# Agent sandbox repository onboarding

This is the repository-maintained revision of the [approved onboarding runbook](https://gist.github.com/BNasraoui/867c7fc12ecc51478984c6a3dad97bcf#file-operator-runbook-md), updated for the coordinator-approved caller-level publisher. Existing operator settings must be inspected and preserved; these instructions do not mean they are absent or authorize workers to change them. Only Ben/the delegated operator applies these settings. Worker implementation stays on rpi/workflowd-d6g; this document also specifies the operator-owned onboarding changes in the target repository. Keep publishing disabled until all gates pass. Save returned rule/environment/installation IDs and full workflow pins in the bead; never record keys/tokens.

## 1. Confirm repositories and publish reviewed workflows

Read-only observations on 2026-10-07:

| Input | Canonical repository | ID | Owner ID | Main check |
|---|---|---:|---:|---|
| workflowd | BNasraoui/workflowd | 1306107007 | 81005232 | Required checks |
| BNasraoui/provenance | quality-sh/provenance | 1286590015 | 319835875 | CI OK |

Use canonical names/IDs in API calls, policy and OIDC. Do not create a replacement BNasraoui/provenance repository. Both are public; workflowd is personal, provenance is now organization-owned. Existing workflowd lease ruleset 24498610 is retained exactly. Existing provenance main 21228245 and release-tags 21228248 are retained; additional rules are additive.

After D1 and D2 local gates, worker publishes the candidate, polls its exact-head CI, and stops. Coordinator records the full approved SHA in workflowd-ck1 and proof configuration. Any `.github/workflows/**`, `.github/actions/agent-publish/**` or `deploy/sandbox/**` change needs a new pin; workflow files must match an existing branch tip because gate App has no Workflows permission. Do not reuse 1dfc34c after workflow changes.

For each repository, publish only the short caller below; keep the lease implementation and publication tooling in workflowd. Both cross-repository `uses` references and `tooling-sha` must use the same coordinator-approved **full 40-character SHA**, never a branch/tag. Replace every `APPROVED_TOOLING_SHA` placeholder before committing. The example uses provenance's canonical repository/actor IDs; substitute the target's IDs for another repository.

```yaml
name: Agent sandbox lease
on:
  push:
    branches: [workflowd/leases/**]
permissions: {}
jobs:
  sandbox:
    if: >-
      github.event.deleted == false &&
      github.actor_id == '306741873' &&
      github.repository_id == '1286590015' &&
      github.event.repository.fork == false
    permissions:
      contents: read
      id-token: write
    uses: BNasraoui/workflowd/.github/workflows/agent-sandbox.yml@APPROVED_TOOLING_SHA
    with:
      tooling-sha: APPROVED_TOOLING_SHA
      repository-id: "1286590015"
      app-actor-id: "306741873"
      tailscale-client-id: ${{ vars.TS_AGENT_CLIENT_ID }}
      tailscale-audience: ${{ vars.TS_AGENT_AUDIENCE }}
  agent-publish:
    needs: sandbox
    environment: agent-publish
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    permissions:
      actions: read
      contents: read
    steps:
      - uses: BNasraoui/workflowd/.github/actions/agent-publish@APPROVED_TOOLING_SHA
        with:
          github-token: ${{ github.token }}
          gate-actor-id: "306741873"
          publish-probe-canary: ${{ secrets.PUBLISH_PROBE_CANARY }}
          publisher-app-id: ${{ vars.GHETTIMONSTER_APP_ID }}
```

Save as `.github/workflows/agent-sandbox-caller.yml`. Keep the job IDs `sandbox` and `agent-publish`: the controller binds to `sandbox / runner` and `agent-publish`. The publish job belongs to the target caller and resolves its own `agent-publish` environment. The lease call passes no secrets. Do not use `secrets: inherit`, including between repositories with the same owner.

The composite action runs reviewed `deploy/sandbox/publish.mjs` and its adjacent validator from the action's pinned installation; no target-source checkout, copied scripts, installation of agent dependencies, or caller working-directory convention is needed. It validates the existing approval and immutable artifact before its second step receives the canary. Explicit inputs keep the read token in validation and the canary in its consumer. The future `GHETTIMONSTER_PRIVATE_KEY` must similarly be an explicit input used only by a reviewed token-mint step after validation; it is absent from this candidate. See [composite action paths](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax#runs-for-composite-actions).

Workflowd's own caller uses its local reusable workflow plus an exact-`github.sha` sparse checkout of the action and deploy tooling, then the local action. Coordinator pins the target caller SHA separately as `workflowSha` and the central workflowd SHA as `toolingSha`. No result-branch input exists. Review the target caller and run the isolation guard/tests: only `agent-publish` may declare an environment or reference `secrets.`; inherited secrets are forbidden everywhere.

Before provenance publication, Ben hardens `.github/workflows/{ci.yml,security.yml,compatibility-gate.yml,review-assets.yml}` to D1's all-PR policy: anonymous exact-SHA fetch, empty permissions, no persisted action tokens or PR cache writes, and no secret-bearing dependencies. Replace token-dependent PR change discovery with local Git comparison; retain CI OK. Dependency review must use unauthenticated public reads or move to reviewed-main execution if its action requires a token. Replace `socket.yml`'s PR execution with a tokenless/no-checkout informational job; any credentialed scan remains outside PR execution and is not a prerequisite here. Inspect `agent-cargo.yml` too: an agent-selected branch can match existing push triggers, so those jobs need the same unprivileged treatment. Review `release.yml`/`release-smoke.yml` for privileged downstream artifact paths; retain reviewed-main/tag release behavior. No protection or existing CI gate is weakened to onboard. Target changes and their normal checks belong to Ben's reviewed onboarding change, not silent worker edits in another repository.

## 2. Configure the two Apps

The existing gate App has ID **4337845**, bot actor ID **306741873**. Identify its registration and installations by these IDs and the operator setup record.

GitHub avatar → Settings → Developer settings → GitHub Apps → **gate App** → Edit → Permissions & events. Retain its existing permissions and webhook URL. Set **Deployments: Read and write**; existing Actions write already covers required read. Under Subscribe to events, enable **Deployment protection rule**, then Save changes. Approve the updated installation permission request in Settings → Applications → Installed GitHub Apps → gate App → Configure. No new webhook URL/receiver is added; workflowd discovers/reviews by polling and does not consume these deliveries. [GitHub setup contract](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/create-custom-protection-rules).

The publisher is **ghettimonster**, App ID **5232172**, bot ID **339414993**. Verify its existing registration with homepage `https://github.com/BNasraoui/workflowd`, no callback/OAuth requirement, webhook inactive, and only repository **Contents: Read and write**, **Pull requests: Read and write**, **Metadata: Read-only**. Leave Actions, Workflows, Administration, Secrets and organization permissions unset. Verify the resulting slug is ghettimonster and record its App ID/bot ID; if the name is unavailable, stop rather than substituting a different author.

Because the repositories have different owners, both Apps must be installable on both accounts. For ghettimonster verify **Any account**. Before changing gate App visibility for quality-sh, the coordinator must verify workflowd ignores events from unknown installations; otherwise use the separately reviewed quality-sh gate App design. Ben must explicitly approve any visibility change (Edit → Advanced → Make public). Public registration makes the App installable; it does not grant repositories automatically. This visibility prerequisite follows GitHub's [App installation rules](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

For each App: Edit → Install App → choose BNasraoui → **Only select repositories: workflowd** → Install/Save; repeat for quality-sh → **Only select repositories: provenance**. Record each installation ID. The existing workflowd gate App installation was previously 147573449; verify, do not assume the provenance ID. Workers do not widen grants or install Apps.

## 3. Create agent-publish in each repository

Repository → Settings → Environments → New environment → name **agent-publish** → Configure environment.

- Leave human Required reviewers and Wait timer off; workflowd is the custom approver.
- Deselect **Allow administrators to bypass configured protection rules**; Save.
- Enable **gate App** under Custom deployment protection rules; Save. If absent, fix App permission/event/installation setup; do not leave the environment unprotected.
- Deployment branches and tags → **Selected branches and tags** → Add rule → **Branch** → `workflowd/leases/*` → Add. Add no Tag rule. This matches the current one-component lease ID; environment patterns omit `refs/heads/` and `*` does not match `/`. This is an infrastructure deployment restriction, unrelated to names chosen by agents. [Pattern semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
- Environment variables → Add `GHETTIMONSTER_APP_ID` with the actual App ID.
- Initially add a harmless environment-only `PUBLISH_PROBE_CANARY` for step 6 and leave the real key absent. After that probe passes and a separate reviewed candidate implements actual publishing, generate ghettimonster's private key in its App settings and paste it into **this environment's** secret `GHETTIMONSTER_PRIVATE_KEY`. Provision the other repository's environment likewise, remove the canary and temporary provisioning download. Never copy the key to mint, repository/org secrets, a lease, or a configuration file. No secret value enters the runbook/evidence.

The approved gist's companion JSONs 06–08 are exact environment-policy, deployment-branch-policy and custom-rule API bodies. Disabling administrator bypass is a separate console step: the published environment PUT schema has no can_admins_bypass field. Console steps above are sufficient. GitHub documents support for public personal repositories, owner configuration, and secrets withheld until protection passes in [Manage environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments). Environment secrets become available at job start ([Secrets reference](https://docs.github.com/en/actions/reference/security/secrets)); this remains a live acceptance probe, not an observed deployed setup.

## 4. Apply exact rulesets

Review and download the JSON attachments in the approved gist, then use a terminal authenticated as Ben. Execute one command at a time, save its returned ID, and GET that ID before continuing. Bodies contain no placeholders or agent naming rules.

```bash
# BNasraoui/workflowd
gh api --method POST repos/BNasraoui/workflowd/rulesets --input 01-existing-branches.json
gh api --method POST repos/BNasraoui/workflowd/rulesets --input 02-tags.json
gh api --method POST repos/BNasraoui/workflowd/rulesets --input 03-workflowd-main.json
# quality-sh/provenance (canonical destination of BNasraoui/provenance)
gh api --method POST repos/quality-sh/provenance/rulesets --input 01-existing-branches.json
gh api --method POST repos/quality-sh/provenance/rulesets --input 02-tags.json
gh api --method POST repos/quality-sh/provenance/rulesets --input 04-provenance-main.json
gh api --method POST repos/quality-sh/provenance/rulesets --input 05-provenance-leases.json
```

Rule 01 restricts all existing-branch updates (including fast-forwards), deletion and force-push, bypass **User 81005232 only**. It does not restrict creation. Its sole exclusion is the pre-existing infrastructure lease namespace, separately controlled by gate App; ghettimonster has no bypass there. Rule 02 retains the owner's Ben-only tag decision. Main requires a PR and its repository's Actions check with **zero required approvals**, no bypass; rule 01 still prevents Apps merging/updating main. Ben's outer bypass does not bypass main's PR/check rule. [REST ruleset schema](https://docs.github.com/en/rest/repos/rules).

Re-read effective `rules/branches/main`, new rules and the unchanged lease rule. This also stops other bots updating their existing branches; do not silently exempt them. Before provenance onboarding, verify its existing release workflow does not create tags using a token that the Ben-only tag rule will block. Before live publication, prove a new ref succeeds and a taken name, update, delete, main mutation and lease-ref mutation fail for ghettimonster, using operator-owned disposable fixtures and before/after SHAs. Never destructively probe main; use effective-rule inspection there and matched fixture branches for destructive denials. Tests must leave the existing ref unchanged. If enforcement differs, stop rollout and revise with Ben.

## 5. Tailscale and repository policy

Tailscale admin → Settings → Trust credentials → OpenID Connect: issuer `https://token.actions.githubusercontent.com`; Auth Keys write only; tag `tag:agent-runner`. Keep existing workflowd trust. For provenance provision its own credential with immutable subject:

```text
repo:quality-sh@319835875/provenance@1286590015:ref:refs/heads/workflowd/leases/*
```

Put its client ID and audience in target Settings → Secrets and variables → Actions → **Variables** as `TS_AGENT_CLIENT_ID` and `TS_AGENT_AUDIENCE`. Confirm audience from the credential and tailnet tests denying runner-initiated mint/ben-arch connections. Do not infer trust from variable presence.

Operator adds provenance's configured alias/root and sandbox policy alongside workflowd, using repository/owner IDs above, actual opencode installation ID, actor 306741873, approved target `workflowSha`, central `toolingSha`, and its Tailscale values. `publish` supplies recorded base ref, environment ID and ghettimonster App/bot IDs; it has no result-branch setting or private key. Use isolated proof configuration first: workflowd proofs target the existing RPI branch at the newly published candidate so the PR contains only the agent task; provenance proofs target reviewed main after onboarding. Record that base tip as source at dispatch. Production targets main and enablement is separate. Do not register a fresh model auth store.

## 6. Probes, live runs, review

The implemented verifier gains `--probe-publish` for the first D2 contract gate. After Ben's setup and re-pin, use a harmless environment-only canary before the real publish key: show a custom-only gate in pending deployments, approval by polling without consuming a webhook, gate App comment/identity visible to the publish job, matching artifact ID/digests, and canary unavailable to the lease. Unknown run, wrong expected SHA/artifact, stale attempt or unsuccessful agent never releases the gate. A failed probe stops D2 for revision; no human-approval workaround. Replace the canary with normal key provisioning only after this proof and the separately reviewed real-publishing implementation. Stop this candidate after CI for coordinator review/re-pin; the coordinator re-runs the canary.

Use existing proof environment/trust inputs and uniquely named transient user units capped at 6G/no swap. D3's `--proof` file supplies each repository's small task and test command, with **no branch value**; select one policy entry per invocation. The D2 probe intentionally stops before token minting while the key is absent.

```bash
bun scripts/evidence/agent-sandbox.mjs --probe-publish
bun scripts/evidence/agent-sandbox.mjs --live --proof scripts/evidence/agent-sandbox-proof.json --executor opencode:opencode-primary --model "$OPENCODE_MODEL"
bun scripts/evidence/agent-sandbox.mjs --live --proof scripts/evidence/agent-sandbox-proof.json --executor codex:local --model "$CODEX_MODEL"
bun scripts/evidence/agent-sandbox.mjs --live --proof scripts/evidence/agent-sandbox-proof.json --executor claude:local --model "$CLAUDE_MODEL"
# Then select provenance's policy and execute at least one of the live commands.
# After every push, poll the exact commit; never subscribe.
gh run list --repo BNasraoui/workflowd --commit "$PHASE_HEAD" --json databaseId,name,status,conclusion,headSha
gh run list --repo quality-sh/provenance --commit "$RESULT_HEAD" --json databaseId,name,status,conclusion,headSha
```

The three workflowd runs and at least one provenance run must each retain: draft PR URL with author ghettimonster[bot], result SHA/metadata receipt, real remote test evidence, audit lines in Actions, safe PR CI, revoked binding/token and confirmed process/Actions/ref cleanup. No patches/bundles are downloaded to mint as proof. Keep failed-run evidence. Four successes are the minimum; six are not required.

After all live receipts, use existing Claude auth and a fresh independent invocation with the final diff, plan and sanitized evidence:

```bash
claude --print --model claude-opus-5-5 < /tmp/workflowd-d6g-security-review.txt
```

The review prompt requests findings only, no edits, and covers result identity, secret isolation, rules/CI, name pass-through, audit honesty, races/recovery and both repositories. Save the report; blocking findings prevent merge. If that model/auth is unavailable, review remains incomplete; do not substitute. On failure disable publishing, retain protections/custody, and reconcile; do not delete result branches or weaken rules as automatic rollback.
