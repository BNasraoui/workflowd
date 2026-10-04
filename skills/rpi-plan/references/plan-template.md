# RPI plan template

Keep the filled plan under two pages. Delete sections that do not apply.

````markdown
# RPI plan: <id> — <ticket title>

Ticket: <id> Research: <research gist url> PR: <draft PR url>
Repository: <owner/repo> at <full commit sha>

## Outcome

<Two or three sentences: what is true when all phases land.>

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

- `bun run check`
- End-to-end: `bun test test/remote/simulation/retry.test.ts` drives a real runner and job
  store through the remote simulation harness (research: <question> section).

## Phase 2: <observable result>

...

## Graph

| Rule | Refines | Statement | Test shape | Verification |
| ---- | ------- | --------- | ---------- | ------------ |

Topic: <linked open Topic | proposed Topic with its Questions | none: small change under
existing Rules | shaping gap: no Requirement fits>

## Decisions for the reviewer

- <choice>: <options>; recommended <option> because <reason>
````
