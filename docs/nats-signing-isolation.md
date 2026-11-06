# NATS signing custody and remote command authentication (A5)

Status: proposed design, investigation only. Tracking: `workflowd-d9b2`.
No deployment, credential issuance, key export, service restart, or runtime code
change is part of this PR. Operator actions below require a separate rollout.

## Decision

Keep NATS, JetStream, noscope, and the existing role names. Move operator,
account identity, and unrestricted signing seeds into offline operator custody
off mint. Put one **scoped account signing key per runtime role** in a small,
restricted issuer on ben-arch (or another operator-controlled host if ben-arch
cannot meet renewal availability). Mint receives only expiring user credentials,
public trust documents, and a role-bound issuer client credential.

Treat command authorization as a separate boundary. For the smallest design
that covers an arbitrary process running as `ben` on mint, ben-arch must approve
the exact privileged operation locally and verify that approval before execution.
Use an application signing key independent of NATS, held on ben-arch and unavailable
to mint. The first version is an operator-local approval tool, not an unattended
signing endpoint. This intentionally makes cross-host `claude_resume` approval-gated.

If unattended resumes are required, move their trusted workflow decision-maker
and state off mint, including independently authenticated inputs. That is a
larger follow-up. Automatically signing every request from the mint coordinator,
even on another host, does not meet this threat model. Root removal alone is
useful and can ship first, but must not be reported as complete A5 command protection.

### Alternatives considered

| Option                                                | Tradeoff                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Offline roots; role-scoped signers on mint            | Smallest custody-only change, but mint retains renewable coordinator command authority and signing-key theft is not bounded by credential TTL.                     |
| All runtime issuance off mint (recommended)           | Keeps signing seeds off mint with a small provider change; adds issuer availability and still needs application authorization.                                     |
| Sign commands using a key owned by mint's coordinator | Helps against a broker-only compromise when the key is independently protected; does not cover another process with the coordinator's Unix authority.              |
| Move trusted workflow authority off mint              | Can preserve unattended operation if inputs are independently authenticated; larger state, deployment and availability change than local exact-operation approval. |

## Evidence and limits

Read-only observations on 2026-10-14, against workflowd commit
`2256098d07dfc3b75f5ddcf914853fc48e83e954`:

| Observation                                                  | Evidence                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mint has operator and account seed files                     | Metadata-only inventory under `~/.local/share/nats/nsc/keys`: one operator, three account-type, five user-type filenames. Contents were not read. The nsc directory and key directory are mode 0700.                                                                                                                |
| Runtime minting uses the account identity                    | `~/.local/bin/workflowd-nats-mint:10–23` edits the named WORKFLOWD user expiry, generates its credential, and returns noscope's JSON envelope. Inspected users have account issuers and no `issuer_account`; broker WORKFLOWD account claims have no delegated signing keys.                                        |
| Six-hour renewals reuse stored user identities               | mint's coordinator and runner ExecStart use `noscope run --provider nats --role … --ttl 21600 --env-key WORKFLOWD_NATS_CREDS --restart-before-expiry 300`; `Restart=always`. The helper rounds JWT expiry up to minutes and reports the requested TTL in the envelope. No fresh user key is created by that helper. |
| The provider is a launcher, not a role authorization service | `~/.config/noscope/providers/nats.toml:1–4` invokes the local helper with caller-supplied role and TTL. It is mode 0600 and defines neither refresh nor revoke. The helper has no caller-to-role authorization or TTL ceiling. No helper was executed during this investigation.                                    |
| Broker trust is static public configuration                  | `~/.config/nats/nats.conf:1–6` enables JetStream and includes `broker-auth.conf`; that file embeds an operator JWT and SYS/WORKFLOWD account JWTs with `resolver: MEMORY`. WORKFLOWD has no signing-key or revocation entries. mint units grant writable access to the nats data directory.                         |
| The tooling supports delegated roles                         | Installed versions: noscope 0.1.0, nsc 2.11.0, nats-server 2.11.8. Read-only nsc help exposes `edit signing-key` role/pub/sub scope options and `edit operator --require-signing-keys`. No mutation commands were run.                                                                                              |
| ben-arch deployment is not freshly verified                  | Project memory records its noscope provider invoking mint over SSH as `runner-ben-arch`. The remembered SSH config path is now absent on mint; direct batch SSH to ben-arch returned `Connection refused`. Its provider, private-key inventory, service user, and live units remain operator verification items.    |

The local noscope source checkout is commit
`0e87a571de0c76c83af7c46e767c0d5b650a7886`; its relationship to the installed
binary was not independently reproduced. `src/ports/provider_exec.rs:231–271`
validates role syntax and substitutes argv without a shell; this is not role
authorization. `src/ports/provider.rs:387–405` checks config permissions.
`src/app/run.rs:95–113,160–172` injects credentials once at spawn and signals the
child before expiry so the service can restart and mint again. Filesystem modes
and service sandboxes do not isolate secrets from another process of their owner.

In workflowd, [contract.ts](../src/remote/contract.ts) defines unsigned commands,
fences, and results. [runner.ts](../src/remote/runner.ts) decodes deliveries before
`recordBatch`; [runner-store.ts](../src/remote/runner-store.ts) checks host, expiry,
generation and duplicate/conflicting IDs and durably fences execution.
[claude-resume-executor.ts](../src/remote/claude-resume-executor.ts) checks a directory
prefix and session existence before invoking the Claude adapter with the supplied
prompt and schema. These checks constrain execution and replay; none proves who
authorized the payload. The current directory check is lexical; the proposed
policy also needs canonical-path containment, including symlink/traversal handling.

[transport.ts](../src/remote/transport.ts) carries commands and fences on
`workflowd.v1.commands.<host>` and results on `workflowd.v1.results`.
[coordinator-result-store.ts](../src/remote/coordinator-result-store.ts) correlates
results with durable dispatch state; correlation is not cryptographic sender
authentication. The broad trust description in [remote-runner.md](remote-runner.md)
should be updated when the authenticated protocol is implemented.

## Threat boundary

A process with mint's `ben` authority can reach that user's NATS material,
coordinator credentials, service configuration and broker state. Removing roots
limits durable issuance authority, but neither six-hour expiry nor broker subject
grants proves that a command reflects an approved workflow. A compromised broker
also cannot be the application verifier's source of truth for trusted public keys.
This design protects ben-arch execution integrity, not availability or confidentiality
of plaintext messages passing through mint. The broker can still delay or lose work.

`workflowd-3m17` reduces the agent threat once its live cutover is complete: the
agent UID must have no NATS files, issuer-client credentials, application keys,
service environment, coordinator database, broker configuration, privileged
service-control access, or unrestricted signer/SSH access. Harness login sharing
must not share these authorities. Writable executables/configuration used by the
trusted services would also defeat the separation.

The [agent-user draft](agent-user.md) explicitly leaves live provisioning and
cutover to later phases; merged code is not evidence of host isolation. A completed
UID boundary protects against an ordinary agent process, but does not protect
against compromise of `ben`, the coordinator, or host root. It complements A5;
it does not remove the need for off-mint custody or independent approval. APIs
available to the agent must enforce job authority so they do not become an
indirect path to privileged commands.

## NATS custody and issuance

| Material                                                                             | Proposed custody and authority                                                                                                                                             |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator identity and operator signing seeds                                         | Offline encrypted operator store off mint, with a separately verified recovery copy. Used only to authorize account/trust changes.                                         |
| WORKFLOWD and SYS account roots; unrestricted account signers; SYS admin credentials | Offline off mint. No runtime service receives administrative issuance authority. Inventory SYS as well as WORKFLOWD.                                                       |
| Scoped WORKFLOWD signers                                                             | Restricted issuer identity off mint, one key per coordinator, runner-mint and runner-ben-arch role. Its store contains no root or unrestricted signer.                     |
| User credentials                                                                     | Only the service entitled to the role; six-hour lifetime and five-minute restart margin initially retained. No credential contents in argv, logs, reports or repositories. |
| Broker trust                                                                         | Public operator/account JWTs on mint, installed through an operator-controlled configuration path. These contain no seed.                                                  |
| Application approval key                                                             | Separate ben-arch operator identity, outside the runner/agent-accessible store; public verification keys pinned locally on the runner. Never derive it from a NATS seed.   |

A scoped signing key has a permission template in the operator-authorized account
JWT. An ordinary unscoped account signer would retain excessive user issuance
authority. NATS describes this distinction in its
[decentralized authentication documentation](https://docs.nats.io/learn/security/decentralized-auth).
Use the installed nsc 2.11.0 interface, not the newer `nats auth` command examples
on that page. Confirm behavior with an isolated 2.11.8 broker before rollout.

The initial scope templates reproduce the observed transport grants:

- Coordinator: publish `workflowd.v1.commands.*`, `workflowd.v1.ci.>`,
  `$JS.API.>`, `$JS.ACK.WORKFLOWD_RESULTS_V1.>`; subscribe `_INBOX.>`.
- Runner for host H: publish `workflowd.v1.results`, `$JS.API.INFO`,
  `$JS.API.CONSUMER.INFO.WORKFLOWD_COMMANDS_V1.runner-H`,
  `$JS.API.CONSUMER.CREATE.WORKFLOWD_COMMANDS_V1.runner-H`,
  `$JS.API.CONSUMER.CREATE.WORKFLOWD_COMMANDS_V1.runner-H.>`,
  `$JS.API.CONSUMER.DURABLE.CREATE.WORKFLOWD_COMMANDS_V1.runner-H`,
  `$JS.API.CONSUMER.MSG.NEXT.WORKFLOWD_COMMANDS_V1.runner-H`, and
  `$JS.ACK.WORKFLOWD_COMMANDS_V1.runner-H.>`; subscribe `_INBOX.>`.

These are compatibility grants, not a claim of complete least privilege. The
coordinator retains account-wide JetStream administration; shared inbox access,
shared result publication, and consumer-creation filter authorization need separate
hardening. A signature is still required even if these grants are later narrowed.
The coordinator's scope is inherently command-capable: installing that signer
on mint would not solve cross-host command authorization.

Keep noscope's provider contract. Replace the helper's local root-backed nsc call
with a narrow authenticated request to the off-mint issuer. A forced-command SSH
endpoint is sufficient if implemented with a dedicated principal, pinned host key,
no forwarding/PTY/general shell, and explicit role binding per client key. The
issuer derives the role from authenticated identity, never trusts a requested role,
and refuses unknown roles or TTL outside `1..21600` seconds. A mint client cannot
request runner-ben-arch or SYS credentials. No generic nsc or signing endpoint is
exposed. The ben-arch runner uses its own bound local endpoint.

Use isolated per-role nsc stores and serialize renewals to avoid concurrent edits.
Issue scoped user claims using that role's signer, empty direct permissions as
required by scoped claims, the correct issuer account and non-bearer authentication.
The scoped grant constrains subjects; do not assume it imposes a six-hour JWT maximum.
The issuer must enforce expiry. A stolen signer can continue issuing until its
public signing key is removed from the account trust document; six hours bounds
an issued credential, not possession of signing authority.

Renewal failure must fail closed, with bounded retries and metadata-only alerts;
never fall back to root minting or indefinitely valid credentials. ben-arch sleep
or outage becomes an issuance availability dependency. Verify that it can meet the
renewal window or select another trusted host before cutover. Preserve noscope's
restart behavior initially; continuity work remains tracked by `workflowd-2hz`.

## Application authentication and authorization

Introduce a versioned authenticated envelope for **all commands and fences**.
Use a standard Ed25519 implementation with an explicit protocol/domain prefix,
algorithm, key ID, deployment audience, message type, issue time and expiry.
Sign a deterministic encoding of the complete command body: host, command/job IDs,
attempt, generation, and, for `claude_resume`, session, directory, prompt, extraction
schema and timeout. Pin the encoding with test vectors and reject duplicate JSON
keys/unknown protocol fields rather than relying on object serialization accidents.
Reserve signature/envelope overhead within the existing 16 KiB transport limit.

The local approval tool on ben-arch displays the full operation and its source,
checks host/session/directory policy, and signs the exact prepared command and its
corresponding current fence only after local operator approval. Approval is bound
to the deployment, one command ID, generation and expiry, with a locally enforced
maximum lifetime (initially 30 minutes). Republish identical bytes; a different
payload or new attempt/generation needs a new approval. Expiry controls execution
admission, while the separately approved timeout bounds the running operation.
Never approve only a directory, session or arbitrary prompt template. The tool
has no mint-callable auto-approve interface. A compromise of mint cannot create
new locally approved operations, though it can deliver an already approved one
within its authorized window.

Before writing any fence/current-generation or executable inbox state, the runner
verifies signature, key-to-host/kind permission, audience, timestamps and maximum
lifetime, and then applies existing host, generation, deduplication and execution
checks. Persist verified bytes, digest and signer ID with the execution claim;
recheck expiry and current key authorization on recovery before execution. Keep
replay records through the complete acceptance window. Refuse unsigned legacy
messages at cutover. An invalid signature must not change durable job authority.
Key IDs resolve only through runner-local operator-managed public-key policy,
never through a key carried by the message or broker.

Use the same envelope for probes, current fences and cancellation fences; do not
leave a second unsigned route to authority-changing state. A separate mint-held
application key may authorize only bounded, rate-limited probes and fences tied to
those probe jobs. It must not authorize Claude job fences or unknown future kinds.
Claude cancellations require the off-mint authority; an operator-local stop remains
available if the transport is unavailable. New command kinds default to denied
until a runner policy and signer authorization are added. Continue requiring local
canonical-directory containment and session policy even with a valid signature.

Sign results with a separate runner application key per host, verified against
pinned host keys before coordinator result acceptance. Existing dispatch/lease
checks still apply. Shared result subjects and IDs alone do not establish the
host of origin. A compromised mint can still impersonate its own mint runner or
alter mint's coordinator state; these signatures do not make a compromised
coordinator trustworthy. ben-arch's independent execution approval remains the
boundary. CI/event messages must not automatically become authority for a privileged
resume without this approval; a separate event-authentication design can follow.

## Operator migration and acceptance

1. **Confirm scope and availability.** Inspect ben-arch provider and unit metadata,
   SSH access restrictions, key locations and service identities without printing
   credentials. Confirm off-mint issuer availability, approve the manual-resume
   tradeoff, and record which services actually use the separate agent UID.
2. **Prepare recovery off mint.** Securely transfer the root store to offline custody,
   verify recovery privately, and inventory copies, exports, old fallback creds,
   backups and SYS administrative material. No seed transfer through PRs, beads,
   terminals or CI. Removal of a file does not invalidate a previously copied seed.
3. **Prepare delegated trust offline.** Create per-role scoped signers and public
   account documents; retain account identities and JetStream limits. Enable strict
   signing-key usage only after all accounts, including SYS, are signed by an
   authorized operator signer and all users use authorized account signers. Validate
   direct-root user rejection with the pinned server. Never leave an unrestricted
   account signer in the online issuer.
4. **Resolve historical root exposure.** If copied root authority cannot be excluded,
   use a fresh off-mint operator identity and remove the old operator trust after
   transition. Re-sign the existing account identities to avoid changing JetStream
   account storage identity; verify this in rehearsal. Strict signing-key enforcement
   must make old direct account-signed users inadmissible. If that cannot be proven,
   use new account identities and an explicit tested JetStream data migration;
   do not declare historical authority revoked merely because roots moved.
5. **Rehearse in isolation.** With invented keys and a temporary broker, test every
   role's permitted transport flow and denied cross-role operations, scoped-claim
   verification, TTL enforcement, expired/removed-key credentials, issuer outages,
   strict signing, renewal and connection eviction. Test command tampering, wrong
   host/kind/audience, replay across restart, unsigned/current/cancelled fences,
   key rotation and recovery of queued work. Check paths through symlinks/traversal.
   No live authorization probes from this PR. Run heavy checks in capped units
   (`MemoryMax=4G`, `MemorySwapMax=0`); full suites belong in CI.
6. **Install verifier and issuer before enabling traffic.** Deploy the authenticated
   protocol to both sides with public keys pinned out of band. Drain or quarantine
   old unsigned inbox/stream work; do not grandfather received rows into execution.
   Preserve execution receipts so uncertain work is never replayed. Operator installs
   the new public operator/account JWT configuration into the memory resolver,
   validates it, and performs the rehearsed reload or restart. Do not assume an
   `nsc push` updates this static memory-resolver file. Reconnect clients and verify
   both legitimate access and old-authority refusal on existing/new connections.
7. **Cut over services and remove mint signing custody.** Change noscope providers
   and restricted issuer access on each host; rotate user credentials through the
   normal provider response. Remove legacy mint helper access to the root store,
   unnecessary writable nsc paths and fallback credentials. Remove roots, unrestricted
   signers and their local backups from mint only after off-mint recovery verification;
   handle storage snapshots under the operator's retention policy. Audit permissions
   and UID access. Run one approved resume and signed probe, check result provenance,
   then observe two six-hour renewal cycles without a root dependency.

Success requires separate evidence for (a) no online mint root/unrestricted signer,
(b) role-bound off-mint issuance and (c) independent authorization of every ben-arch
privileged operation. Record only public key fingerprints, versions, statuses and
bounded failure reasons. No GitHub ruleset, App setting, environment or secret change
is required by this design. All host/configuration actions above remain operator
steps, not actions performed by this PR.

## Rollback and recovery

Before changing trust, retain the last working public config, service definitions,
SQLite/JetStream backups and a tested off-mint issuance path. Define a maintenance
window and stop admission while trust/protocol versions disagree.

For issuer outages, the operator can supply a newly issued short-lived credential
from the off-mint authority through a protected service credential path. It must
retain the same scoped role and expiry; otherwise leave the affected service
stopped. Never restore root seeds to mint, unrestricted legacy fallback credentials,
or a remote shell for renewal.

For authenticated-protocol failure, keep ben-arch privileged execution disabled
while rolling back code or repairing the verifier. Preserve inbox claims and result
receipts; inspect uncertain operations locally. Do not roll back to accepting
unsigned privileged commands. A temporary probe-only mode can retain diagnostics.

For signer replacement, install the replacement public key/policy before issuing
new credentials or approvals, allow a bounded overlap for known in-flight work,
then remove the old signer. For suspected compromise, revoke immediately and reject
pending approvals from that signer, including on recovery. NATS signer removal
requires a newly authorized account JWT installed on the broker and verified
connection rejection/eviction; editing the issuer store alone is insufficient.
Changing application trust requires local runner policy updates too.

Do not restore a retired operator trust root to recover availability. If a prior
account configuration is needed, have the current off-mint authority re-authorize
its safe settings without reintroducing removed signers or revocations. Where account
identities changed, restore only with the rehearsed data-migration recovery plan.
A failed rollback leaves privileged execution stopped for operator follow-up.
