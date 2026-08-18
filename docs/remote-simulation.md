# Deterministic remote simulation

The remote simulation is test infrastructure under `test/remote/simulation`. It runs the real
remote coordinator, runner, SQLite stores, codecs, and transport port with one coordinator and two
host-addressed runners. It does not emulate NATS. The in-memory transport only controls the
behaviors needed at the port boundary: delivery, delay, duplication, reordering, disconnection,
reconnection, and acknowledgement.

Actions are plain typed data. A seed deterministically generates an action schedule, and failures
include a compact replay line such as:

```text
seed=11776009 enqueue:runner-a,coordinator,reorder:host
```

The short fixed corpus runs in the normal test suite and CI:

```sh
bun run simulate:remote
```

Longer runs should use the soak entrypoint, which drives the same seeds outside `bun test` and so
is not bounded by a test timeout (still bounded to 500 steps per seed):

```sh
WORKFLOWD_SIM_SEEDS=49,24301,11776009 WORKFLOWD_SIM_STEPS=500 bun run soak:remote
```

It prints one result line per seed and exits non-zero if any seed fails to settle.

Seed `1` is deliberately omitted above: it does not quiesce within 32 rounds at 487 or more
steps. That is an open simulation finding, not a harness limit.

`bun run simulate:remote` sizes its timeout from the seed and step counts. Override it directly with
`WORKFLOWD_SIM_TIMEOUT_MS` on a slow machine. Note that a *failing* seed then pays for shrinking,
which re-runs the whole schedule once per candidate action and is effectively unbounded on long
schedules, so prefer `soak:remote` when a long run is expected to find something.

The intentionally broken `singleMessageBatches` mutation seam is test-only. Its test demonstrates
that command-before-fence ordering is found and deletion/value shrinking reduces the replay to the
three actions needed to reproduce it. The mutation is never enabled by the normal corpus.

After every action, the harness compares durable state with a small independent model of accepted
and terminal jobs. It also checks exact dispatch lease custody, immutable terminal outcomes,
single execution, host addressing, cursor monotonicity, coordinator inbox/result coherence, and
runner inbox/outbox coherence. Quiescence reconnects endpoints, releases delayed traffic, and then
requires all recoverable work to become terminal within a fixed number of rounds.

Time starts from a fixed instant. Dispatch leases are shorter than command expiry so tests cover
both accepting a valid result after lease time and expiry-driven retry. The `cancel` action advances
to command expiry and runs the coordinator's existing reconciliation path; this exercises its
durable cancelled fence rather than inventing an external cancellation API. Service Layers are
fresh on each step, while SQLite files and transport state persist. Explicit restart actions rebuild
and inspect that preserved state, so they add no second runtime lifecycle model.

## Generator choice

`@hegeldev/hegel` 0.4.5 was evaluated against Bun 1.3.14 and this repository's TypeScript setup.
It supports Bun, explicit seeds, and integrated shrinking, but it remains a pre-1.0 beta with an
explicitly unstable API, uses native Rust libraries through `koffi`, and has no model-command or
state-machine API. Adding that native dependency would make this test harness less portable without
removing the domain-specific transition and validity logic.

The simulator therefore uses a small local Mulberry32 generator plus deterministic deletion and
time-value shrinking. Hegel is not the simulator, and can be reconsidered after its API stabilizes
or it gains stateful command support.

Live NATS tests remain unchanged and continue to verify broker and client configuration. The
simulation requires neither Docker nor NATS.
