# Remote Probe Runner

This slice transports only the built-in harmless probe. SQLite on the coordinator is the workflow authority. JetStream provides bounded, durable, at-least-once transport; runner inbox/outbox tables fence duplicate execution and coordinator result acceptance.

## NATS over Tailscale

1. Bind NATS to the coordinator's Tailscale address, enable JetStream file storage, and firewall TCP 4222 to the tailnet runner identities.
2. Create a scoped token/account allowed to create/read its filtered durable consumer, pull from `workflowd.v1.commands.<host>`, and publish `workflowd.v1.results`. The coordinator needs the inverse permissions plus JetStream administration for stream creation.
3. Put the token in `~/.config/workflowd/nats-token` with mode `0600`; do not put it in the environment file.
4. Copy `deploy/runner.env.example` to `~/.config/workflowd/runner.env`, replacing the server and host ID. Use an absolute database path because systemd does not expand `%h` inside `EnvironmentFile` values.
5. Install `deploy/systemd/workflowd-runner.service` as a user unit, then run `systemctl --user daemon-reload && systemctl --user enable --now workflowd-runner`.

NATS should listen only on the tailnet address or localhost behind a Tailscale proxy. Use TLS in addition to Tailscale when broker policy requires independent transport encryption.
Use a `tls://host:4222` server URL when NATS TLS is enabled; `nats://` is accepted for a tailnet-only or local development listener.

## Coordinator and probe

Enable the coordinator inside the central workflowd process with `WORKFLOWD_REMOTE_COORDINATOR_ENABLED=true`, `WORKFLOWD_NATS_SERVERS`, and a NATS token credential file. Enqueue a probe into the same authoritative workflowd database with:

For the shipped central unit, install a `workflowd.service.d/20-nats.conf` drop-in so the secret does not enter `workflowd.env`:

```ini
[Service]
LoadCredential=nats-token:%h/.config/workflowd/nats-token
Environment=WORKFLOWD_NATS_TOKEN_FILE=%d/nats-token
```

```sh
bun run remote:enqueue --probe smoke-1 --host this-host
```

The enqueue command creates a versioned kernel job through workflow instance, wait, event, and delivery state. The coordinator claims that job under the normal kernel lease, stores the exact attempt/worker/token/lease authority in a dispatch row, and republishes prepared rows after restart. Once prepared, ordinary kernel reclamation excludes the uncertain external effect. This post-lease custody is deliberate but finite: the dispatch expiry is the authority bound, after which coordinator reconciliation advances the generation, publishes a cancellation fence for externally uncertain work, and either creates a fresh kernel attempt or terminally fails an exhausted job. Result acceptance checks the published command, host, generation, attempt, observation time, and stored claim authority in the same transaction that completes the kernel job result.

A runner commits every receipt or rejection before confirmed acknowledgement, applies per-job generation fences before queued commands, and recovers received work and result outbox rows after restart. Broker messages may still be duplicated or redelivered; operational guarantees are at-least-once transport plus durable fencing, not a single-delivery guarantee.
