---
task: eng-xxxx-description
type: structure-outline
repo: [current repository]
branch: [current branch name]
sha: [result of git rev-parse HEAD]
---

# [Plan Title]

[2-3 sentence plan summary]

## Desired End State

- [what will be true when this is done]
- ...

## Implementation Overview

- [ ] Phase 1: [Phase Title]
- [ ] Phase 2: [Phase Title]
- [ ] ...

---

## Phase 1: [Phase Title]

[Overview of what this phase accomplishes]

### File Changes

- **`path/to/file.ts`**: [what changes in this file]
- **`path/to/file.ts`**: [what changes in this file]


[optional - show new method signatures or changes, use ... verbatim in body]
```typescript
async function [name]([args]): [returntype] { ... }
````

- **`path/to/file.ts`**: [what changes in this file]

[optional - show new method signatures or changes, use ... verbatim in body]
```diff
 async function [name](
   [arg1],
+  [arg3],
-  [arg2],
 ): [returntype] { ... }
````

### Validation

#### Automated Verification

- [ ] [runnable command, e.g. `bun --bun run typecheck`]
- [ ] ...

#### Manual Verification

- [ ] [manual test step]
- [ ] ...

---

## Phase 2: [Phase Title]

...

---

## Open Questions

- [questions about plan structure that need clarification]
- ...
