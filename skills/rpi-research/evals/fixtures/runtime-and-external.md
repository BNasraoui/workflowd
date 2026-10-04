# Fixture: questions needing runtime evidence and an external tool

This fixture stands in for command output. Do not run `gh`, `bd`, `git`, or `ssh`; treat the
sections below as their results. The repository has no `.provenance/` directory. The
default branch is `main`.

## `gh gist view https://gist.github.com/example/q30 --raw`

```markdown
# RPI questions: workflowd-z30

Repository: BNasraoui/workflowd at 9b2e4c7a1d0f3e6b8a5c2d9f4e7a0b3c6d1e8f25

## Pointers

- `src/opencode/session.ts` (`runSession`)
- `@opencode-ai/client`
- host `mint`, unit `workflowd-runner.service`

## Questions

1. How does `runSession` in `src/opencode/session.ts` start and end an OpenCode session?
2. What does `@opencode-ai/client` send on the event stream when a session ends?
3. How is `workflowd-runner.service` installed on mint, and what did its journal show at its
   last start?
4. Which tests and end-to-end harnesses exercise `runSession`?
```

## Repository snapshot at `9b2e4c7`

`src/opencode/session.ts`:

```ts
20  export const runSession = (client: OpencodeClient, prompt: string) =>
21    Effect.gen(function* () {
22      const session = yield* client.session.create({})
23      yield* client.session.prompt({ id: session.id, prompt })
24      yield* client.event.subscribe().pipe(
25        Stream.takeUntil((event) => event.type === "session.idle"),
26        Stream.runDrain,
27      )
28      return session.id
29    })
```

`package.json` pins `"@opencode-ai/client": "0.0.0-beta-18684"`. `node_modules/` is absent at
this commit (dependencies not installed); the package source is not in the repository.

`test/opencode/session.test.ts` drives `runSession` against `test/support/fake-opencode.ts`,
an in-process HTTP and SSE server that emits `session.idle` after one prompt. Run with
`bun test test/opencode/session.test.ts`.

## `ssh mint systemctl cat workflowd-runner.service` (read-only)

```ini
# /etc/systemd/system/workflowd-runner.service
[Service]
ExecStart=/opt/workflowd/bin/bun /opt/workflowd/src/remote-runner.ts
Restart=on-failure
```

## `ssh mint journalctl -u workflowd-runner.service -n 3 --no-pager` (read-only)

```text
Oct 03 22:14:01 mint systemd[1]: Started workflowd-runner.service.
Oct 03 22:14:02 mint bun[4411]: runner connected to nats://127.0.0.1:4222
Oct 03 22:14:02 mint bun[4411]: opencode server http://127.0.0.1:4096 version 0.9.1
```

## `gh gist create --desc "RPI research workflowd-z30" /tmp/rpi/workflowd-z30/research.md`

```text
https://gist.github.com/example/r30
```

## `gh pr create ...`

```text
https://github.com/BNasraoui/workflowd/pull/120
```
