# Fixture: plan that depends on an unconfirmed external protocol

This fixture stands in for command output. Do not run `bd`, `gh`, `git`, or `ssh`; treat the
sections below as their results. The repository has no `.provenance/` directory.

## `bd show workflowd-z30 --json`

```json
[
  {
    "id": "workflowd-z30",
    "title": "Abort the OpenCode session when a remote job is cancelled",
    "description": "Cancelling a remote job leaves its OpenCode session running on mint until it finishes. When the job is cancelled, call OpenCode's `session.abort` for that session so it stops promptly.",
    "acceptance_criteria": "1. A cancelled job's session receives an abort. 2. The job ends as cancelled, not failed. 3. Uncancelled jobs are unchanged.",
    "status": "open",
    "issue_type": "bug",
    "notes": "questions: https://gist.github.com/example/q30\nresearch: https://gist.github.com/example/r30\npr: https://github.com/BNasraoui/workflowd/pull/120"
  }
]
```

## `gh gist view https://gist.github.com/example/r30 --raw`

```markdown
# RPI research: workflowd-z30

Questions: https://gist.github.com/example/q30
Repository: BNasraoui/workflowd at 9b2e4c7a1d0f3e6b8a5c2d9f4e7a0b3c6d1e8f25

## How does runSession start and end an OpenCode session?

`src/opencode/session.ts:20-29` creates a session, sends one prompt, and returns when the
event stream yields `session.idle`. Cancellation of the remote job interrupts the Effect
fiber (`src/remote-runner.ts:88-97`); nothing calls the OpenCode client on interruption.

Testing: `test/opencode/session.test.ts` drives `runSession` against
`test/support/fake-opencode.ts`, an in-process HTTP and SSE server.

## What does @opencode-ai/client send when a session ends, and which session calls exist?

Not confirmed. `package.json` pins `@opencode-ai/client` `0.0.0-beta-18684`, but the package
is not installed at this commit. Reading the installed package's `session` API, or calling a
running server of that version, would confirm which calls and events exist.

## End-to-end harnesses

`bun run simulate:remote` runs `test/remote/simulation/corpus.test.ts`: a simulated runner,
real SQLite store, and `test/support/fake-opencode.ts`. Cancellation scenarios live in
`test/remote/simulation/corpus/cancel-*.json`. `bun run check` runs everything.

## Runtime evidence

`ssh mint journalctl -u workflowd-runner.service -n 3` showed the runner connected to an
opencode server reporting version 0.9.1 at http://127.0.0.1:4096.
```
