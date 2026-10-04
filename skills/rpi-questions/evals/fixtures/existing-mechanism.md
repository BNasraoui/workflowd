# Fixture: ticket that reuses an existing mechanism

This fixture stands in for command output. Do not run `bd`, `gh`, or `git`; treat the
sections below as their results. The repository has no `.provenance/` directory.

## `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`

```text
main
```

## `git rev-parse HEAD` (after `git checkout --detach origin/main`)

```text
5e1c0a9d4b7f2e8361a0c5d9e4f7b2a1c8d3e6f0
```

## `bd show workflowd-y12 --json`

```json
[
  {
    "id": "workflowd-y12",
    "title": "Make remote:enqueue --watch reconnect when NATS drops",
    "description": "`bun run remote:enqueue --watch` exits when the NATS connection drops. Run `run_7f3a` died at 02:10 when nats-server restarted on mint. The runner already reconnects through `connectWithRetry` in `src/remote/nats-client.ts`; reuse it in `src/remote-enqueue.ts` so watching survives a restart.",
    "acceptance_criteria": "--watch keeps streaming events across a nats-server restart. Without --watch, behavior is unchanged.",
    "status": "open",
    "issue_type": "bug"
  }
]
```

## Repository snapshot at `5e1c0a9`

`src/remote/nats-client.ts`:

```ts
12  export const connectWithRetry = (servers: string) =>
13    Effect.retry(connectOnce(servers), Schedule.exponential("500 millis"))
```

`src/remote-runner.ts`:

```ts
30  const nc = yield* connectWithRetry(config.natsUrl)
```

`src/remote-enqueue.ts`:

```ts
44  const nc = yield* connectOnce(config.natsUrl)
58  if (args.watch) yield* watchEvents(nc, runId)
```

`test/remote/simulation/corpus.test.ts` runs a simulated runner against an embedded NATS
server. `test/remote-enqueue.test.ts` covers argument parsing only.

## `gh gist create --desc "RPI questions workflowd-y12" /tmp/rpi/workflowd-y12/questions.md`

```text
- Creating gist questions.md
https://gist.github.com/example/q12
X Failed to open browser
```

Exit status: 1.
