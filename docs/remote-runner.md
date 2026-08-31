# Remote Probe Runner

This plane transports two command kinds: the built-in harmless probe, and `claude_resume` — a request to wake a Claude Code session that lives on the runner's host. SQLite on the coordinator is the workflow authority. JetStream provides bounded, durable, at-least-once transport; runner inbox/outbox tables fence duplicate execution and coordinator result acceptance.

### `claude_resume` threat model

A `claude_resume` command is no longer harmless: it makes the runner execute `claude -p --resume <session>` in a working directory, with a caller-supplied prompt. The daemon owns the whole resume lifecycle; the runner is a narrow, vetted effector, and the trust is deliberately constrained on the runner's own side, not the sender's:

- **Runner-local opt-in.** A runner executes a `claude_resume` command only for a directory under one of its `WORKFLOWD_RUNNER_CLAUDE_DIRS` prefixes. Unset (the default) refuses every claude wake. The daemon cannot widen this; only the host operator can, on the host.
- **No shell, ever.** The prompt and the extraction schema ride as data — the prompt is written to the CLI's stdin, never argv or a shell string. The session id and directory are pattern-validated to shell-inert character sets in the wire contract before they can appear in any command.
- **At most once.** The runner claims execution in one transaction, runs the CLI outside any transaction, and records the result in a second; a spent claim with no stored result reports `execution_interrupted` rather than re-running a wake whose effect on the session is unknown. The command's `maxAttempts` is 1, so an at-least-once redelivery never produces a second wake turn.
- **Unchanged broker grants.** `claude_resume` rides the same `workflowd.v1.commands.<host>` / `workflowd.v1.results` subjects as the probe; no new per-identity grants are needed, so a compromised runner's blast radius is exactly what it was for probes. The permissions integration test exercises a `claude_resume` command under the existing grants.

Compared to reaching the host over SSH — which would hand the daemon an arbitrary remote shell authenticated by the daemon's key — the trust boundary here is "the host will run one fixed, argv-vector command shape for a directory it opted into, when its own broker identity receives a well-formed command," with the daemon holding no credential on the host at all.

## NATS over Tailscale

1. Bind NATS to the coordinator's Tailscale address, enable JetStream file storage, and firewall TCP 4222 to the tailnet runner identities.
2. Issue one NATS credential per identity with broker-enforced subject permissions, following [Per-identity credentials](#per-identity-credentials) below. A runner identity may only manage and pull its own filtered durable consumer on `workflowd.v1.commands.<host>` and publish `workflowd.v1.results`; the coordinator identity publishes `workflowd.v1.commands.*` and administers JetStream. A plain token cannot express any of this: NATS tokens carry no subject permissions, so token mode means every credential holder can read every host's commands and publish arbitrary results. Keep token mode for local smoke tests only.
3. Put the credential in `~/.config/workflowd/runner.creds` (or `nats-token` for token-mode smoke tests) with mode `0600`; do not put it in the environment file.
4. Copy `deploy/runner.env.example` to `~/.config/workflowd/runner.env`, replacing the server and host ID. Use an absolute database path because systemd does not expand `%h` inside `EnvironmentFile` values.
5. Install `deploy/systemd/workflowd-runner.service` as a user unit, add the creds drop-in shown in `deploy/runner.env.example`, then run `systemctl --user daemon-reload && systemctl --user enable --now workflowd-runner`.

NATS should listen only on the tailnet address or localhost behind a Tailscale proxy. Use TLS in addition to Tailscale when broker policy requires independent transport encryption.
Use a `tls://host:4222` server URL when NATS TLS is enabled; `nats://` is accepted for a tailnet-only or local development listener.

## Per-identity credentials

The client accepts exactly one credential source: `WORKFLOWD_NATS_TOKEN`, `WORKFLOWD_NATS_TOKEN_FILE`, `WORKFLOWD_NATS_CREDS` (creds content in the environment, for injection by an external supervisor), or `WORKFLOWD_NATS_CREDS_FILE` (path to a standard `.creds` file). Empty values count as unset so a systemd drop-in can blank a source that the shipped unit already sets.

Scoped authorization uses NATS decentralized JWTs (operator mode) rather than a static `authorization { users [...] }` block, and that choice is forced, not stylistic: a `.creds` file authenticates with a user JWT plus NKey signature, which a server only accepts under a trusted operator, and static password/nkey users are credential formats this client deliberately does not speak. Operator mode is also the cheaper thing to operate on a two-machine tailnet: user permissions live inside each signed user JWT, so minting a credential for a new host never touches broker configuration, and the memory resolver keeps the server config a single static file with no account server to run.

Mint the world once with [`nsc`](https://github.com/nats-io/nsc) on the coordinator host:

```sh
nsc add operator --name workflowd --sys
nsc add account WORKFLOWD
nsc edit account WORKFLOWD \
  --js-mem-storage -1 --js-disk-storage -1 --js-streams -1 --js-consumer -1
nsc add user --account WORKFLOWD coordinator \
  --allow-pub 'workflowd.v1.commands.*' \
  --allow-pub '$JS.API.>' \
  --allow-pub '$JS.ACK.WORKFLOWD_RESULTS_V1.>' \
  --allow-sub '_INBOX.>'
nsc add user --account WORKFLOWD runner-gpu-host \
  --allow-pub 'workflowd.v1.results' \
  --allow-pub '$JS.API.INFO' \
  --allow-pub '$JS.API.CONSUMER.INFO.WORKFLOWD_COMMANDS_V1.runner-gpu-host' \
  --allow-pub '$JS.API.CONSUMER.CREATE.WORKFLOWD_COMMANDS_V1.runner-gpu-host' \
  --allow-pub '$JS.API.CONSUMER.CREATE.WORKFLOWD_COMMANDS_V1.runner-gpu-host.>' \
  --allow-pub '$JS.API.CONSUMER.DURABLE.CREATE.WORKFLOWD_COMMANDS_V1.runner-gpu-host' \
  --allow-pub '$JS.API.CONSUMER.MSG.NEXT.WORKFLOWD_COMMANDS_V1.runner-gpu-host' \
  --allow-pub '$JS.ACK.WORKFLOWD_COMMANDS_V1.runner-gpu-host.>' \
  --allow-sub '_INBOX.>'
nsc generate config --mem-resolver --config-file broker-auth.conf
nsc generate creds --account WORKFLOWD --name coordinator > coordinator.creds
nsc generate creds --account WORKFLOWD --name runner-gpu-host > runner.creds
```

Include `broker-auth.conf` from the nats-server configuration alongside the JetStream and listen settings. The subject lists mirror what the transport actually uses — stream and consumer administration, pull fetches, synchronous acks, and inbox replies — and `test/remote/remote-transport-permissions.integration.test.ts` exercises exactly these grants against a real broker, including the denial of a runner credential touching another host's subjects.

What this still does not enforce, so unattended operation does not over-trust the broker:

- Runner identities in the account share publish access to `workflowd.v1.results`, so a compromised runner can publish results naming another host. The coordinator's durable result acceptance (command, host, generation, attempt, and stored claim authority checked in one transaction) is the guard against forged results, not the broker.
- `_INBOX.>` subscribe access is account-wide, so identities in the account could observe each other's request replies. Tightening this needs per-identity inbox prefixes, which the transport does not configure today.
- The client cannot verify that the broker enforces anything: a misconfigured broker without the operator block accepts these connections and enforces nothing. After changing broker authorization, prove a denial (for example with `nats pub workflowd.v1.commands.other-host --creds runner.creds`, which must be rejected).

## Coordinator and probe

Enable the coordinator inside the central workflowd process with `WORKFLOWD_REMOTE_COORDINATOR_ENABLED=true`, `WORKFLOWD_NATS_SERVERS`, and a NATS credential. Enqueue a probe into the same authoritative workflowd database with:

For the shipped central unit, install a `workflowd.service.d/20-nats.conf` drop-in so the secret does not enter `workflowd.env`:

```ini
[Service]
LoadCredential=nats-creds:%h/.config/workflowd/coordinator.creds
Environment=WORKFLOWD_NATS_CREDS_FILE=%d/nats-creds
```

```sh
bun run remote:enqueue --probe smoke-1 --host this-host
```

The enqueue command creates a versioned kernel job through workflow instance, wait, event, and delivery state. The coordinator claims that job under the normal kernel lease, stores the exact attempt/worker/token/lease authority in a dispatch row, and republishes prepared rows after restart. Once prepared, ordinary kernel reclamation excludes the uncertain external effect. This post-lease custody is deliberate but finite: the dispatch expiry is the authority bound, after which coordinator reconciliation advances the generation, publishes a cancellation fence for externally uncertain work, and either creates a fresh kernel attempt or terminally fails an exhausted job. Result acceptance checks the published command, host, generation, attempt, observation time, and stored claim authority in the same transaction that completes the kernel job result.

A runner commits every receipt or rejection before confirmed acknowledgement, applies per-job generation fences before queued commands, and recovers received work and result outbox rows after restart. Broker messages may still be duplicated or redelivered; operational guarantees are at-least-once transport plus durable fencing, not a single-delivery guarantee.
