# CI and OpenCode evidence preflight — 2026-09-29

Source head: `30b89d85a56f27693a5a90b080e04b672aa13b5d`.
Fetch and fast-forward pull reported already up to date.

Read-only App API preflight at 04:53 UTC passed:

- One active, unsuspended installation, with selected repository access.
- Installation repository listing contains exactly `BNasraoui/workflowd` (total 1).
- App and installation both grant Actions read; updated permission is accepted.
- App and installation subscribe to `workflow_run` and `check_suite`.
- Webhook URL is configured. The configuration endpoint does not expose an active
  field; fresh workflow run/job deliveries receiving HTTP 202 establish activity.

Only the App ID was parsed from the production env. The private key and webhook
secret were copied into a private scratch directory beneath this worktree.
An installation token was used only to enumerate repository access. No credential,
webhook URL, raw response, or token was logged. Scratch credential copies were
removed in `finally`. No App setting, production service, or CI run was changed.

The final isolated run passed all 12 scenarios. See
[the complete CI and OpenCode evidence](./ci-opencode-evidence.md).
