# Agent and runner directory

`workflowd-ccw.3` adds authenticated inventory of logical recipients, endpoint
bindings and per-host execution catalogs. It supplies discovery and ownership
information for later messaging and remote launch work. `job_status`, resident
inboxes, waits, event sources and `host_health` retain their existing contracts.

## Identities and managed registration

A managed recipient is allocated atomically when an accepted Agent Run is stored:
`managed:<initial-host>:<run-id>`. Duplicate acceptance, restart and native session
replacement preserve this identity. The host directory is pinned in SQLite on
first acquisition; opening that database under another configured host fails.
Historical local runs are backfilled without changing their custody or selection;
they require a current native observation before their endpoints become active.
Existing foreign-host custody is excluded. The runner identity is `runner:<host>`.
Model, provider, executor and native session are attributes, not recipient IDs.

Native bindings carry a separate monotonic `bindingVersion`. A changed native
session or custody session clears endpoint proof and increments the version.
Accepted runs report `accepted`; spawning/spawned runs report `launching`. Neither
has a deliverable endpoint. Only actual first-output verification or a successful
native observation of matching, locally owned session/resource custody can make
a verified binding active. Administrative run timestamps and retry bookkeeping
cannot renew that proof.
Terminal, operator-required or inconsistent custody is unavailable. Old observations
expire; their timestamps are retained. One-shot CLI sessions are informative
bindings and always have `deliverable: false`.

Successful OpenCode watchdog telemetry renews endpoint observations independently
of output progress; an unreachable observation invalidates endpoint proof without
renewing its last successful timestamp. Resident Codex acquisition/reacquisition clears old proof;
native resume/read must confirm the thread before it becomes deliverable again.
The owned resident periodically reads its thread, using the directory refresh
interval (30 seconds by default, checked by the existing one-second resident pass).
A failed read clears directory proof. Disposing the resident invalidates its
directory observations without changing unit/process custody or restart behavior.
Native thread metadata alone, a launch manifest, or an unconfirmed close is never
endpoint proof. Existing launch uncertainty, cancellation and closure fencing remain
authoritative. This directory does not acquire or expand that authority.

## External owner and endpoint proof

An external agent supplies its own Ed25519 owner key and a local HTTP relay.
`POST /directory/registrations` accepts this exact document:

```json
{
  "protocol": "workflowd-directory-register-v1",
  "hostId": "host-a",
  "publicKey": "BASE64_ED25519_SPKI_DER",
  "revision": 1,
  "endpoint": {
    "harness": "codex",
    "transport": "relay-http",
    "address": "http://127.0.0.1:9123/agent",
    "nativeSessionId": "native-thread-id"
  },
  "signature": "BASE64_ED25519_SIGNATURE"
}
```

Sign the UTF-8 canonical JSON document excluding `signature`, using the repository's
`canonicalJson` encoding (recursively sorted object keys, ordinary JSON scalar/array
encoding). The recipient is `external:<sha256 of decoded public-key DER>`; callers
cannot choose it or claim the managed namespace. `hostId` must match the receiving
daemon's pinned host. Addresses must be canonical HTTP URLs at `127.0.0.1` with an
explicit port and no credentials, query or fragment. Redirects are refused.

After verifying the registration signature, workflowd POSTs a fresh JSON challenge
with `protocol: "workflowd-directory-endpoint-v1"`, a random UUID `nonce`, and
`registration` containing the complete registration object excluding its signature.
The relay returns exactly
`{"signature":"BASE64_ED25519_SIGNATURE"}`, signing the complete canonical challenge
with the same owner key. The callback has a two-second deadline and a 4 KiB response
bound; registration bodies are limited to 16 KiB. This proves control of the relay
now. Harness and native-session metadata remain the relay owner's attestation; the
directory does not inspect an external agent's private session or process.

Exact signed duplicates reverify the live endpoint and refresh its lease, returning
`duplicate` with the same recipient ID. A changed endpoint/session/host requires a
higher owner-signed revision. Equal-revision conflicting bindings and old revisions
are refused. Owner revision fences survive lease expiry and restart, including an
owner-authorized move between hosts; stale host observations are filtered from
inventory. Different owners cannot claim the same local endpoint address.
Unreachable current relays become unavailable on failed re-registration and expire
when they stop renewing. There is no background external-endpoint probe.

Registration writes only directory records. It creates no Agent Run, native custody,
working resource, launch record, process ownership or cleanup permission. It cannot
stop/kill an external agent or delete its worktree. Owner keys must persist across
external restarts; losing a key requires a new logical recipient. There is no key
rotation/recovery protocol in this slice.

## Cross-host observations

The existing NATS `WORKFLOWD_COMMANDS_V1` stream carries two bounded directory
envelopes alongside its existing commands; no launch or arbitrary message command
is added. A coordinator sends `directory_observe` to
`workflowd.v1.commands.<runner-host>` and receives `directory_page` on
`workflowd.v1.commands.directory-<coordinator-host>`, through durable consumer
`directory-<coordinator-host>`. Every frame stays within the existing 16 KiB budget.
Advertisements have at most 128 pages of 2,048 JSON characters each. Oversized
directories are refused; the last complete observation then expires normally.

NATS credentials retain the established connection/subject authorization. Because
the existing account's reply permissions alone do not prove a payload's host,
directory enrollment additionally pins a distinct 32–4096-byte shared proof key
to each host. HMAC-SHA256 authenticates canonical envelope JSON excluding `signature`,
including host, coordinator, persisted generation and random request nonce. The
runner accepts only its configured coordinator and pinned credential. The observer
checks the enrolled host/key, current challenge, bounded deadline and complete page
assembly before accepting a snapshot. The proof key is configuration authority,
never a caller-supplied host label or a field exported in the catalog.

Request generations, partial assemblies, completed observations, runner response
cache and external owner fences persist in SQLite. Exact duplicates replay the
original response without rediscovery or lease extension. Old/out-of-order requests,
conflicting pages and late concurrent discovery cannot replace newer responses.
An old managed binding version cannot replace the currently observed binding even
under a new challenge. The observer validates managed host namespaces and external
owner signatures. A remote host attests its own native verification; the coordinator
does not remotely attach to the native harness.

Transport leases are measured from the coordinator's request time, so delayed or
replayed replies cannot renew liveness. Configured peers start `unavailable` with
no fabricated catalog. During partitions, the last complete observation remains
readable with explicit expiry; expired runners and endpoint leases become unusable.
Source `checkedAt`, `observedAt`, `freshUntil`, stale/access status, selection IDs
and native thinking metadata survive advertisement unchanged. Stale source or runner
observations mask model availability as unavailable. Fresh runner liveness does not
prove source freshness or account entitlement. Discovery uses the installed `.1`
OpenCode/Codex adapters; Claude remains explicitly unsupported. Credentials, account
details and arbitrary private provider overlays are never advertised.

## Composition and configuration

Both automation and `WORKFLOWD_MODE=execution` compose the directory. HTTP requires
the existing execution-capabilities token (or its agent-run token fallback); otherwise
the routes are absent. Execution-only composition adds no required OpenCode, GitHub,
CI consumer or resident subscription.

| Setting | Meaning |
| --- | --- |
| `WORKFLOWD_DIRECTORY_PEERS` | Optional coordinator JSON object mapping other host IDs to proof-key file paths; 1–64 distinct hosts/keys. |
| `WORKFLOWD_DIRECTORY_REFRESH_MS` | Coordinator refresh, default 30,000 ms; range 10–30,000. |
| `WORKFLOWD_DIRECTORY_LEASE_MS` | Coordinator/local directory lease, default 90,000 ms; range 100–300,000 and greater than refresh. |
| `WORKFLOWD_NATS_SERVERS` and existing NATS credential settings | Required when peers are configured; reuse existing authenticated transport. |
| `WORKFLOWD_DIRECTORY_CREDENTIAL_FILE` | Runner's enrolled proof-key file; never returned by inventory. |
| `WORKFLOWD_DIRECTORY_COORDINATOR_HOST` | Runner's authorized coordinator; required together with the proof key. |
| `WORKFLOWD_REMOTE_HOST_ID` | Existing validated runner host identity. Must equal the host registered in the coordinator. |
| `WORKFLOWD_REMOTE_DATABASE_PATH` | Existing runner DB; share the host daemon's DB to advertise its managed/external recipients. Otherwise this runner has a standalone directory. |
| `WORKFLOWD_EXECUTION_CAPABILITIES_CODEX_ENABLED`, `WORKFLOWD_AGENT_RUN_CODEX_BIN` | Runner discovery uses the current native Codex adapter; enabled by default on opted-in runners. |
| `OPENCODE_SERVER_URL`, `OPENCODE_SERVER_PASSWORD` or `_FILE`, `OPENCODE_SERVER_USERNAME`, `WORKFLOWD_OPENCODE_SERVER_ID` | Optional authenticated runner OpenCode adapter; no mandatory OpenCode dependency. |

Runner and daemon sharing a database must use the same host ID. Native discovery
runs with that runner process's local environment/credentials. Each host needs its
own enrolled proof key. Plan any new NATS grants separately during deployment:
runners need publish permission on the coordinator's directory reply subject;
coordinators need command-stream consumer create/info/fetch/ack permissions for
`directory-<coordinator-host>`. Existing command/result/CI permissions remain needed.
No live configuration, credentials, broker permissions or services are changed by
this implementation.

Migration `0028_agent_directory` is additive after current main's `0026` caller
mailbox and `0027` resident-unit migrations. It adds directory identity, managed
bindings, external registrations, owner fences, peer observations/page assemblies
and runner response cache, plus directory-only lifecycle observation triggers.
It changes no existing custody rows or migration `0025` closure semantics.

## Public inventory and integration limits

Authenticated daemon GET routes are `/directory`, `/directory/agents`,
`/directory/runners`, `/directory/capabilities?host=<host>`, and individual
`/directory/agents/<encoded-recipient-id>` / `/directory/runners/<encoded-runner-id>`.
Missing identities return 404; storage failures are redacted 503s. External POST
registration returns a 202 receipt, 400 for malformed/schema-excess input, 413 for
oversized bodies, 409 for owner/proof/revision conflicts or 503 for unavailable storage.

MCP `agent_directory({})` returns the complete schema-checked snapshot.
`{kind:"agents"|"runners"|"capabilities",id?:"..."}` filters or looks up a recipient,
runner or host respectively. It requires the MCP bearer and the existing daemon URL
and discovery credential configuration. Refusals have text and `isError` without a
success-shaped `structuredContent`. This is separate inventory: `job_status` does
not gain all managed runs.

`.4` can consume `AgentDirectory.inventory`, stable recipient IDs, binding versions
and verification/expiry state to resolve a target; actual sending and subscriptions
remain its work. External relays presently implement only the proof challenge, so
`deliverable` denotes a current verified binding, not a successful application message.
Native addresses identify harness transports/session bindings; they are not universal
HTTP message URLs. `.5` can consume per-host runner catalogs with executor/provider/
native-model/catalog-model separation and thinking/access evidence; advertisements
are observations, not remote launch authorization. Managed recipients remain tied to
their accepted run's initial owner host; this slice provides no managed-run host
migration or custody transfer operation. `.6` owns unified run/job completion inventory.
