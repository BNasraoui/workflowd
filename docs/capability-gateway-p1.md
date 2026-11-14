# P1 capability gateway contract

## Public bootstrap configuration — approved v2 addendum

Ben approved **both Tailscale federation client ID and audience** as public
bootstrap configuration in review `01a18ac2-d32b-7362-b43a-c0aad6ce2c74`.
[Tailscale's federation documentation](https://tailscale.com/kb/1581/oauth-federation)
identifies these two fields as non-secret. This is a classification clarification,
not a masking fix or a CI-secret policy exception.

`publicBootstrapFields` is the complete additional allowlist: client ID is an
ASCII identifier of 1–128 characters; audience is a bounded URI-like identifier
of 1–256 characters without whitespace, control characters, query or userinfo.
Controller `SandboxPolicy` parsing enforces the same constraints. The capture
launcher validates before starting the enrollment child. It never serializes
the environment or passes arbitrary input fields to the public serializer.

GitHub's runner prints `env`/`with` **before** the child starts. Consequently
runtime validation is not a pre-header sanitizer. These two reusable-workflow
inputs must come only from administrator-maintained caller configuration (the
existing caller uses repository variables), validated against the stated bounds
before activation. Agent prompts, branches, results and repository content are
not configuration sources. Do not route agent text through these fields.
No actual configured values were accessed during implementation.

The exception does not include OIDC/run/provider tokens, arbitrary account
identifiers, private peer addresses/topology/routes, payloads or diagnostics.
Public receipts still contain only fixed stage/outcome/reason, bounded count
and a generated correlation ID. Effective federation claims, Tailscale ACLs,
and pinned caller/tooling selection require separate activation evidence.

## Credential ownership

The existing credential host remains the only refresh owner. Confirmed 429
non-rotation persists a generation-bound cooldown in the existing `.rotation`
file under `.access.lock`; uncertain rotation remains fenced across processes.
The distinct-GID fixture tests ordinary supplementary-group preservation and
subsequent provider-owner admission, not a deployed root-owned service.
