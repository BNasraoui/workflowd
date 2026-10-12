# Agent user credential prerequisite

Phase 1 is blocked. No agent account, credential provisioning, policy or service
configuration is installed by this change.

The installed Codex 0.159.1 file credential backend was tested using a temporary
canonical credential file and two separate temporary homes. Updating synthetic
API-key credentials directly preserves the link to the canonical file. A logout
and subsequent synthetic credential write replaces the controller home's link
with a regular file. The canonical file and the other home retain the previous
synthetic credential. Re-login therefore does not preserve this shared-file
layout, even before introducing another UID.

The evidence command emits only version information, booleans and the number of
UIDs exercised. It uses the installed CLI with a restricted environment and
temporary homes, suppresses client output, and deletes its fixtures afterward.
It reads no existing provider credentials and performs no provider login or
inference request. The CLI's API-key persistence command receives only invented
fixture values on stdin.

```sh
systemd-run --user --wait --pipe --collect -p MemoryMax=6G -p MemorySwapMax=0 \
  bun scripts/evidence/agent-user.mjs --probe-credentials
systemd-run --user --wait --pipe --collect -p MemoryMax=6G -p MemorySwapMax=0 \
  bun test test/agent-user/credentials.e2e.test.ts
```

The probe exits 1 for an incompatible layout and 2 if evidence cannot be
collected. The E2E test deliberately requires sharing to survive re-login; it
fails on the observed installed version. A passing prerequisite alone would
still not establish cross-UID compatibility.

This is a same-UID filesystem prerequisite, not a two-UID authentication test
or proof about OAuth refresh. Concurrent refresh, revoked-auth diagnostics,
atomic replacement, Claude and OpenCode compatibility, and disposable-VM tests
remain unverified. Provisioning must remain paused pending review and a revised
credential-sharing design. Do not share entire configuration homes, copy live
credentials, add logins, or relax access boundaries to bypass this failure.
