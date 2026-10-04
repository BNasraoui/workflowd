# RPI plan template

Keep the filled plan's prose under two pages; code blocks do not count. Delete sections that
do not apply.

````markdown
# RPI plan: <id> — <ticket title>

Ticket: <id> Research: <research gist url> PR: <the bead's `pr:` note>
Repository: <owner/repo> at <full commit sha>

## Outcome

<Two or three sentences: what is true when all phases land.>

## Unconfirmed facts

- <fact the plan relies on that research did not confirm>: probed in Phase <n>; if false,
  <drop or change that phase>

## Phase 1: <observable result>

Result: <what a caller or user can now do or see>

Files:

```text
src/
  worker.ts            (changed)
  retry-policy.ts      (new)
test/
  remote/simulation/retry.test.ts (new)
```

Shape:

```diff
 interface RetryInput {
   readonly attempts: number
+  readonly lastFailureAt: Date
 }
```

Checks:

- Probe (only if an unconfirmed fact applies): <command that confirms the fact>, first.
- `bun run check`
- End-to-end: `bun test test/remote/simulation/retry.test.ts` drives a real runner and job
  store through the remote simulation harness (research: <question> section).

## Phase 2: <observable result>

...

## Graph

<Without .provenance/: "No .provenance/ in this repository; no Graph section.">

| Rule | Refines | Statement | Test shape | Verification |
| ---- | ------- | --------- | ---------- | ------------ |

Topic: <linked open Topic | proposed Topic with its Questions | none: small change under
existing Rules | shaping gap: no Requirement fits>

## Decisions for the reviewer

- <choice>: <options>; recommended <option> because <reason>
````
