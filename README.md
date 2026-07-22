# Workflowd

Local GitHub pull-request automation backed by OpenCode, Bun, Effect, and SQLite.

## Flow

```text
GitHub App webhook
  -> Tailscale Funnel :8443
  -> Bun HTTP listener :8787
  -> SQLite delivery inbox and job queue
  -> existing agent worktree + git pull --ff-only
  -> OpenCode review session (optional fix session only when explicitly enabled)
  -> SQLite publication outbox
  -> sticky PR comment and Check Run
```

Pull-request events are deduplicated by `X-GitHub-Delivery`. Any exact Review Target change advances the PR Generation and supersedes older queued work. A newly accepted webhook also revokes and re-arms active reconciliation for that pull request so a response fetched before the webhook cannot overwrite it. SQLite leases recover work after process restarts; an owner may mutate leased work only while the operation time is strictly before lease expiry.

## Worktrees

The controller first checks the OpenCode worktree registry at `~/.local/share/opencode/worktree-jobs`, then configured local repository roots and their registered Git worktrees.

When it finds the PR branch locally, it:

1. Holds an exclusive in-process lock for that worktree.
2. Removes stale controller context and requires a clean worktree.
3. Runs `git pull --ff-only` with Git hooks disabled.
4. Verifies `HEAD` equals the webhook head SHA.
5. Writes a bounded diff under `.workflowd/`.
6. Runs the configured agent in that worktree.
7. Removes only controller-owned `.workflowd/` state when finished.

A managed checkout and temporary worktree are used only when no matching local worktree exists. Private repositories therefore require working local Git credentials for managed fallback.

Managed review worktree paths include the immutable job generation and attempt. Managed Fix Work paths remain stable across attempts so retries can recover retained edits. Cleanup can make an old session directory unavailable, but a later job generation never reuses that path for unrelated contents.

## Resumable OpenCode sessions

Workflowd checkpoints the configured OpenCode server identity and exact native session ID before prompting an agent. Applicable review publications resolve that durable, generation-bound reference and include a copy-pastable command of the form:

```sh
opencode attach 'https://mint.example-tailnet.ts.net:4096' --dir '/exact/worktree' --session 'ses_exact'
```

Set `WORKFLOWD_OPENCODE_ATTACH_URL` to a credential-free URL reachable only through the private network. The command intentionally omits Basic-auth values and never uses `--continue`; OpenCode obtains credentials from the reviewer's local environment. Firewall, listener, and tailnet policy—not URL secrecy—must prevent public access.

Session-reference metadata is retained with its execution. Workflowd does not copy or delete OpenCode transcripts. Superseded, failed, aborted, expired, endpoint-mismatched, and missing native sessions are reported explicitly and are never redirected to a newer generation or guessed by title. Worktree cleanup does not change the stored directory; if either the directory or server session is gone, the retained reference remains audit metadata rather than silently targeting replacement contents.

## Policies

- Reviews run through the read-only `pr-reviewer` agent.
- Fix Work is disabled by default. Reviews and `/agent fix` cannot enqueue or execute fixes unless `WORKFLOWD_FIX_WORK_ENABLED=true` is explicitly configured.
- When Fix Work is enabled, a review requesting changes automatically queues `pr-fixer` only when all of these checks pass: the review is actionable, the head is in the same repository, the branch begins with `opencode/` or `plan/` by default, and the PR author's exact GitHub login is listed in `WORKFLOWD_TRUSTED_AGENT_USERS` (login matching is case-insensitive).
- The trusted identity is the PR author reported by GitHub and persisted with the current PR generation. It is not inferred from repository write access, branch name, branch creator, commit author, or organization membership. Therefore an unlisted collaborator's same-repository branch remains review-only even when its name has an eligible prefix. Command authorization is an additional check, not an override: `/agent fix` cannot run Fix Work for an unlisted author or ineligible branch.
- The fixer verifies changes and commits without pushing. The controller validates the `Workflowd-Job: <job-id>` trailer and commit SHA, then pushes without force-pushing.
- Enable Fix Work only for trusted agent-owned pull requests because fixer verification runs repository commands on this host.
- A subsequent `pull_request.synchronize` webhook queues the follow-up review.
- Authorized users may leave `/agent review`, `/agent fix`, or `/agent status` comments. Configure them with `WORKFLOWD_COMMAND_USERS`.
- The OpenCode server must set `OPENCODE_DISABLE_PROJECT_CONFIG=1`, so an untrusted PR cannot replace the automation agents or permissions. The shipped systemd drop-in enforces this.

## GitHub App

Configure the GitHub App with a public webhook URL that routes to the controller:

```text
https://hooks.example.com/hooks/github
```

Subscribe to these GitHub events:

- Pull request (`pull_request`)
- Issue comment (`issue_comment`); only newly created PR comments containing an exact `/agent` command are acted on

Repository permissions:

- Pull requests: Read and write
- Issues: Read and write
- Checks: Read and write
- Metadata: Read-only

Install the App on every repository that should be automated. Generate a private key and store it outside the repository with mode `0600`.

## Installed Layout

The shipped user unit assumes:

- Repository: `%h/Documents/repos/workflowd`
- Bun: `%h/.bun/bin/bun`
- OpenCode unit: `opencode-server.service`, bound to `127.0.0.1:4096` with Basic authentication
- Workflowd listener: `127.0.0.1:8787`
- Non-secret environment file: `%h/.config/workflowd/env`
- Credential source files: `%h/.config/workflowd/github-webhook-secret` and `%h/.config/workflowd/opencode-server-password`

Edit the unit if the repository or Bun is installed elsewhere.

## Configuration

Install and edit the environment template:

```bash
install -d -m 0700 "$HOME/.config/workflowd"
install -m 0600 deploy/workflowd.env.example "$HOME/.config/workflowd/env"
```

The required installed values are:

- `GITHUB_APP_ID`: numeric GitHub App ID
- `GITHUB_PRIVATE_KEY_PATH`: absolute path to the App PEM file
- `OPENCODE_SERVER_USERNAME`: must match the OpenCode server, normally `opencode`
- `WORKFLOWD_OPENCODE_ATTACH_URL`: credential-free OpenCode URL reachable from reviewer tailnet machines
- `WORKFLOWD_COMMAND_USERS`: comma-separated authorized GitHub usernames; an empty value disables commands
- `WORKFLOWD_FIX_WORK_ENABLED`: set `true` to fix trusted agent-owned pull requests; keep `false` for review-only operation
- `WORKFLOWD_TRUSTED_AGENT_USERS`: comma-separated allowlist of PR-author GitHub logins eligible for Fix Work; required and non-empty when Fix Work is enabled
- `WORKFLOWD_GIT_SIGNING_KEY`: full OpenPGP fingerprint of the GitHub-registered controller key used to sign and verify Fix Work commits; required when Fix Work is enabled

Fix Work remains disabled by default. Existing installations that previously set `WORKFLOWD_FIX_WORK_ENABLED=true` must add at least one `WORKFLOWD_TRUSTED_AGENT_USERS` login before upgrading; startup fails closed when the allowlist is absent or empty. No database migration is required: every claimed Fix Work job, including one queued before upgrade, is rechecked against the current repository, branch-prefix, review, and author policy before the fixer runs. Removing a login takes effect after restart; queued and subsequent work for that author is disabled or left review-only.

All optional environment names, defaults, separators, timeout/lease settings, and development secret alternatives are documented in `deploy/workflowd.env.example`. Startup rejects invalid ports, URLs, model/agent identifiers, branch prefixes, GitHub users, and leases that do not outlast their timeout.

### Credentials

The installed unit uses systemd `LoadCredential`; do not put either password in `~/.config/workflowd/env`.

Prepare these exact inputs with raw secret contents and mode `0600`:

```bash
install -m 0600 /secure/source/github-app.pem "$HOME/.config/workflowd/github-app.pem"
install -m 0600 /secure/source/github-webhook-secret "$HOME/.config/workflowd/github-webhook-secret"
install -m 0600 /secure/source/opencode-server-password "$HOME/.config/workflowd/opencode-server-password"
```

The OpenCode password file must contain the same password used by `opencode-server.service`. A single trailing newline in a credential file is ignored. For development outside systemd, set exactly one of the direct or `_FILE` variables for each secret; setting both is a startup error.

## OpenCode Agents

Install both agents and the required server safety drop-in:

```bash
install -Dm0644 deploy/opencode/agent/pr-reviewer.md "$HOME/.config/opencode/agent/pr-reviewer.md"
install -Dm0644 deploy/opencode/agent/pr-fixer.md "$HOME/.config/opencode/agent/pr-fixer.md"
install -Dm0644 deploy/systemd/opencode-server.service.d/10-disable-project-config.conf "$HOME/.config/systemd/user/opencode-server.service.d/10-disable-project-config.conf"
```

OpenCode loads agents and configuration only at startup. Restart `opencode-server.service` after independent verification to apply these files. `systemctl --user cat opencode-server.service` must show `Environment=OPENCODE_DISABLE_PROJECT_CONFIG=1` before processing untrusted repositories.

## Ticket Writing Skill

Install the bundled `ticket-writing` skill for OpenCode through skills.sh:

```bash
npx skills add BNasraoui/workflowd --skill ticket-writing --agent opencode -y
```

Confirm that OpenCode discovers the installed skill:

```bash
opencode debug skill
```

The skill is model-invoked. Ask OpenCode to draft, refine, translate, or review a ticket
for QRSPI readiness. For example:

```text
Refine workflowd-123 and update the Bead once it is ready for QRSPI.
```

The canonical ticket template lives in
`skills/ticket-writing/references/ticket-template.md`; do not copy it into
OpenCode configuration.

## Design Boundary Reviewer Skill

Install the model-invoked `design-boundary-reviewer` skill through skills.sh:

```bash
npx skills add BNasraoui/workflowd --skill design-boundary-reviewer --agent opencode -y
```

Run `opencode debug skill` and verify that `design-boundary-reviewer` appears in the
discovered skill list.

Use it to trace every material capability in a draft Design to the current ticket and
its issue graph before human Design approval. It returns `ScopeClean`, `ReviseDesign`, or
`NeedsClarification` and does not replace the post-Structure size and decomposition
review.

The canonical skill, authority model, output contract, fixtures, and recorded evaluation
results live under `skills/design-boundary-reviewer/`.

## Workflowd Unit

Install, but do not enable or start, the Workflowd unit:

```bash
install -Dm0644 deploy/systemd/workflowd.service "$HOME/.config/systemd/user/workflowd.service"
systemctl --user daemon-reload
```

The unit requires `opencode-server.service`, loads both credentials into a protected runtime directory, starts only after OpenCode startup validation succeeds, and uses `UMask=0077`. Fix Work remains disabled by default and is enabled through `WORKFLOWD_FIX_WORK_ENABLED=true` for trusted agent-owned pull requests.

## Verification

Run these before activating either the Workflowd listener or Funnel:

```bash
bun install --frozen-lockfile
bun run check
git diff --check
systemd-analyze --user verify deploy/systemd/workflowd.service
systemctl --user cat opencode-server.service
```

Activation is intentionally separate from package installation. After independent verification, an operator may restart OpenCode, start the Workflowd unit, and configure Funnel:

```bash
systemctl --user restart opencode-server.service
systemctl --user start workflowd.service
tailscale funnel --bg --https=8443 http://127.0.0.1:8787
```

These commands start services but do not enable the Workflowd unit at login. This package does not run them.

Operational smoke commands:

```bash
systemctl --user is-active opencode-server.service workflowd.service
curl --fail --silent --show-error http://127.0.0.1:8787/health
systemctl --user status workflowd.service
journalctl --user -u workflowd.service --since "10 minutes ago"
tailscale funnel status
```

The health response is `{"status":"ok"}`. Confirm a GitHub test delivery receives HTTP `202`, then check that a review job produces the sticky PR comment and per-head Check Run. Port 443 remains private to the tailnet for OpenCode; only Funnel port 8443 should expose the Workflowd listener.

## Development

```bash
bun install --frozen-lockfile
./scripts/install-git-hooks.sh
bun run check
```

The hook checks each local branch pushed against
`<ticket-type>/<ticket-id>-<slug>`, for example
`feature/workflowd-0zr-add-pre-push-guard`. Supported ticket types are
`feature`, `bug`, `task`, `chore`, and `epic`; the ticket must exist in Beads
with the matching type. The installer changes only this repository's local
`core.hooksPath`. Git's `--no-verify` option bypasses the check, so the hook is
local feedback rather than a security boundary.

The tested runtime baseline is Bun `1.3.14`, Effect `3.22.0`, and OpenCode/SDK `1.18.3`.
