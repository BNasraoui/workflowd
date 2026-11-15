# Provider-access owner activation

The capability gateway uses the existing authenticated credential-host Unix socket.
There is one refresh owner per canonical Claude or Codex login. No inbound HTTPS listener or
forward proxy is added. Native consumers sharing that rotating login are refused
when `providerAccess.claude.clientId` is configured; they must use this owner or an
independent login.

The [P3 native profiles](capability-gateway-p3.md) extend this custody to
`providerAccess.codex.clientId` and an independent, explicitly bounded OpenCode
API-key file (`providerAccess.opencode.canonical`). Codex uses the same canonical
layout/consumer exclusion and rotation fence. The static key has no refresh
fallback and does not come from Mint's shared OpenCode database.

## Explicit source opt-in

The shipped `deploy/systemd/workflowd-agent-host.service` remains Unix-only.
Its `RestrictAddressFamilies=AF_UNIX` blocks the HTTPS refresh transport. Provider
ownership requires both the policy opt-in and the separately reviewed drop-in
example at `deploy/systemd/workflowd-agent-host.service.d/20-provider-access-https.conf.example`.
The installer does not install that example. Without its activation marker the
credential host refuses a provider-owner policy before opening its socket or
touching credentials.

The drop-in resets the address-family allowlist to `AF_UNIX AF_INET AF_INET6`.
This **permits socket families**, not just HTTPS or a particular domain/port.
Destination restrictions are enforced by the native adapter: fixed
`https://platform.claude.com/v1/oauth/token` for Claude or
`https://auth.openai.com/oauth/token` for Codex, POST, verified TLS, refused redirects,
10-second deadline, bounded request fields and 16-KiB response. There is no
configurable origin or insecure TLS fallback. The environment activation marker
is configuration intent; it is not evidence of the effective kernel sandbox.

## Operator-controlled migration

Activation requires a separate reviewed operational change. Stop consumers of the
shared rotating login, establish a single canonical generation, and keep genuinely
independent logins separate. Preserve the configured `ownerUid` and `groupGid`;
provider-owned canonical files require mode `0600` instead of shared mode `0660`.
Parent-directory ownership/mode and existing canonical links remain checked by
credential-host admission. Select the native OAuth client ID in the owner policy,
then arrange the reviewed drop-in and policy together. Confirm effective service
settings and supported TLS trust before enabling gateway traffic. Source/fixture
tests do not establish the settings of a deployed unit.

Rotation holds the credential admission lease and per-canonical interprocess lock,
rereads canonical state, writes an uncertain-rotation marker before the provider
effect, and preserves owner/group/mode across fsynced atomic replacement. New
access is published only after durable replacement. An uncertain marker requires
operator reconciliation of the canonical generation; deleting it and retrying an
old refresh token is not recovery. No real refresh is part of local validation.

## Local evidence boundary

Run named synthetic fixtures through the supervisor-approved isolated launcher,
retaining the repository resource guard. TLS fixtures use only generated fixture
certificates/CA trust and isolated loopback. A fixture-applied seccomp socket filter
can check the address-family behavior selected by these source templates; it does
not run systemd or establish actual deployed unit enforcement. That operational
check remains an activation prerequisite.
