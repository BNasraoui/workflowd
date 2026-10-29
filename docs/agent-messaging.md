# Durable agent messages

`workflowd-ccw.4` adds messages and one-shot event subscriptions to the registered
recipient directory. Sending does not create an Agent Run, acquire a repository,
launch a native process, or grant cleanup authority. A recipient can be external,
on another enrolled host, or unrelated to the sender's task.

## Enablement and authority

Messaging is disabled by default. Set `WORKFLOWD_MESSAGING_ENABLED=true` on the
coordinator and participating runners during an owner-controlled rollout. The
coordinator requires the existing execution discovery credential. Runners require
the existing directory host enrollment. Invalid boolean values are refused.
Directory-only deployments retain read-only directory behavior. Opted-in runners
advertise `messageProtocol: 1`; a remote host without this advertisement is refused
as unsupported before message acceptance. Disabled runners omit the optional field,
preserving directory v1 replay. Upgrade the coordinator before enabling messaging
on runners: older strict directory decoders cannot consume the new optional field.

HTTP uses the existing discovery bearer token. MCP requires its existing bearer
and daemon discovery configuration. These are privileged host interfaces: they
can inspect messages, publish events and manage subscriptions for recipients.
A host-origin message has sender `host:<daemon-host>`. A supplied sender label
never establishes agent identity.

External agents include `proof: {publicKey, signature}`. The Ed25519 key must
hash to the sender's registered `external:<hash>` identity; its signature covers
the canonical JSON **message**, without the proof wrapper. The sender must be
active in the directory. Remote registrations observed through the enrolled
directory are eligible. This proves the sender, not receipt by the target.

Managed residents can POST `{runId, message}` to `/messages` on their existing
resident Unix socket. Codex retains its peer PID/ancestry and current custody
checks. The OpenCode compatibility socket additionally requires its existing
`capability`, matching capability hash and native custody. New OpenCode sessions
are not issued a new legacy capability by this change. The authenticated run can
send only as its own `managed:<host>:<run>` recipient. HTTP bodies cannot supply
this internal run authority. Broader agent-facing migration remains `.7` work.

## Public contract

Authenticated HTTP operations:

| Operation | Request | Result |
| --- | --- | --- |
| `POST /messaging/send` | `{message, proof?}` | 202 acceptance/duplicate receipt |
| `GET /messaging/messages/<id>` | — | Durable message, pinned target, delivery state, acceptance time |
| `POST /messaging/subscribe` | `{id, recipient, condition}` | 202 one-shot registration/duplicate receipt |
| `GET /messaging/subscriptions/<id>` | — | Condition and pending/matched/consumed/cancelled state |
| `POST /messaging/cancel` | `{id}` | Current subscription state |
| `POST /messaging/publish` | `{id, event}` | 202 recorded/duplicate event receipt |

MCP exposes `send_message`, `message_status`, `subscribe_to_event`,
`event_subscription_status`, `cancel_event_subscription` and `publish_agent_event`
with the same schemas. Refusals are tool errors without success-shaped content.

A message has this shape:

```json
{
  "id": "d8b84b74-91ee-4c73-88b5-10ce37cc55a2",
  "sender": "external:<owner-key-hash>",
  "recipient": "managed:host-b:agent-run-id",
  "correlation": "conversation-id",
  "replyTo": null,
  "payload": {"type": "task.question", "version": 1, "data": {"text": "Status?"}}
}
```

IDs are stable lowercase UUIDs. Reusing an ID with different content conflicts.
A reply references a stored message with reversed sender/recipient and the same
correlation. The coordinator stores both incoming and outgoing messages, so a
reply does not require parent/child run ownership. Host identities are senders;
they are not invented delivery endpoints in the agent directory.

Send requests are bounded to 8 KiB of canonical JSON; HTTP bodies and transport
frames have 16 KiB limits. Type/version identify the application payload; `data`
is JSON. Publishing through this interface is bounded to 6 KiB, leaving room for
its message envelope. Producers use this publish interface to enter the messaging
namespace; public event names cannot impersonate protected legacy kernel events.

Malformed requests return 400, oversized HTTP bodies 413, absent authentication
401, false sender claims 403, missing identities 404, conflicting IDs 409 and
unavailable directory/storage 503. A known one-shot CLI endpoint is not an
attachable native input channel. Unavailable recipients are refused before
acceptance; native/relay unsupported outcomes remain explicit in delivery state.

## Custody and acknowledgements

An acceptance receipt reports `accepted` or `duplicate`, the stable ID and the
current delivery state. The message and its original endpoint binding are already
committed to SQLite. Restart and a lost HTTP response do not create another ID.

| Delivery state | Meaning |
| --- | --- |
| `pending` | SQLite owns delivery; no native acknowledgement yet |
| `queued` | Accepted by the existing durable resident inbox; native acknowledgement is pending |
| `delivered` | Native input admission or a signed external relay receipt confirms acceptance |
| `unsupported` | The bound consumer cannot perform this operation |
| `unavailable` | The bound consumer explicitly refused availability |
| `stale_binding` | An unsent message's pinned binding was replaced; it was not redirected |
| `uncertain` | An operation may have been accepted; custody is retained and no blind resend is allowed |

None of these states means task completion. Subscription `consumed` means its
message was durably accepted, not delivered or completed. Cancelling a consumed
subscription cannot retract an accepted message. Completion normalization and
unified inventory belong to `.6`.

Native delivery reuses `resident_inbox`, its stable client IDs and existing
closure/custody safeguards. An additional transaction checks recipient host,
binding version, native identity and current proof before claiming a prepared
message. Temporary proof loss leaves it prepared. A changed binding fences it.
A process crash after `sending` leaves an uncertain intent. Codex queries queue
and history; OpenCode retains its existing conservative uncertain outcome.
Neither transport acknowledgement nor absent history authorizes another prompt.

Codex reads actual loaded `idle`/`active` and direct-input availability for a new
message: idle starts a turn, active queues input. OpenCode uses its installed v2
asynchronous queue admission interface, retaining the run's model/thinking fields.
A managed endpoint without an available resident consumer reports unsupported;
this feature does not attach a new process or resume an arbitrary CLI session.
Claude external relays use the same public message contract. Landed one-shot
Claude/Codex CLI paths remain unavailable for arbitrary direct input.

## External relay protocol

The verified loopback relay receives a POST containing:

```json
{
  "protocol": "workflowd-message-deliver-v1",
  "nonce": "fresh-uuid",
  "message": {"id": "...", "sender": "...", "recipient": "...", "correlation": "...", "replyTo": null, "payload": {"type": "...", "version": 1, "data": null}},
  "bindingVersion": 1,
  "nativeSessionId": "registered-native-id"
}
```

The relay replies `{status, signature}`. Status is `delivered`, `unsupported`,
`unavailable` or `unknown`; sign canonical `{delivery: <complete POST>, status}`
with the directory owner key. The fresh nonce prevents a registration challenge
or an unrelated cached receipt from proving this delivery. Responses are bounded
to 4 KiB and two seconds; redirects are refused.

The relay must retain message IDs and receipts durably around its native input
operation. Workflowd commits its sending intent before POSTing. A lost response
or restart uses `workflowd-message-query-v1` with the same message/binding and a
fresh nonce. Query **must not submit native input**. Only a valid delivered query
receipt resolves uncertainty. Unknown, invalid, unsupported or unavailable query
responses do not authorize another send. An old relay implementing only directory
challenges leaves delivery uncertain; it cannot fabricate successful delivery.

## Transport, subscriptions and recovery

The existing authenticated NATS command stream carries bounded version-1 message
and receipt envelopes on `workflowd.v1.commands.messages-<host>`, using durable
consumer `messages-<host>`. Each envelope is HMAC signed with the existing enrolled
peer proof key, covering both host identities and its complete content. A receipt
also binds the immutable message and target digest. Subject access and claimed
host/session labels alone are insufficient authority. Opted-in enrolled peers
attest accepted sender authority and can request delivery to locally registered
recipients; local endpoint proof and native custody still govern admission.

Plan subject publish/consume/ack grants separately during rollout. No broker,
credential, service or production configuration is changed here. A runner shares
its host daemon's existing SQLite database and host identity. Messages addressed
to remote recipients retain their SQLite outbox until an authenticated receipt
arrives. Transport acknowledgement releases only a JetStream delivery. Lost
receipts trigger the same immutable request, whose recipient-side SQLite row
prevents another native send. Mutable receipt states cannot downgrade uncertainty;
a verified delivered receipt can resolve it. Bounded pages advance beyond earlier
uncertain work. Expired peer observations refuse new sends; already accepted
messages retain their original route during a partition.

Subscriptions use existing kernel instances, exact type/version/key/correlation
waits and event cursors. Application conditions are hashed into a dedicated kernel
event namespace, preserving legacy completion and custody event authority. They observe matching events after registration, route one
stable message and consume the wait in the same SQLite transaction. Subscriptions
and accepted event messages survive coordinator restart. Host-authorized agent or
external producers publish into that event store; there is no second event broker.
Normalizing all legacy completion/GitHub producers and the full public lifecycle
migration remain `.6`/`.7` integration work.

Migration `0039_agent_messages` is additive after `0038_agent_directory`. It changes
no historical run, native custody, proof, inbox, server or closure facts. Ordinary
restart preserves message identities, pinned routes, sending intents and waits.
A database-loss incarnation protocol, external owner key recovery, automatic
uncertainty reconciliation by operators and message retention/garbage collection
are not supplied by this slice. Preserve the database and external relay receipts.
`.5` can consume message identity and delivery receipts for remote execution;
these receipts do not authorize a launch or replace its own execution fences.
