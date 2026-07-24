---
name: effect-v3
description: Use for every change to Effect code in workflowd, including services, Layers, Schema models, typed errors, resource scopes, retries, concurrency, SQL, Bun adapters, and Effect-based tests. Keeps implementations compatible with the repository's pinned Effect 3.22 stack rather than Effect v4 beta APIs.
---

# Effect 3

Treat the installed package declarations and existing project patterns as the source of truth. This repository uses `effect` 3.22.0 with the pinned v3 Platform, Bun, SQL, and SQLite packages in `package.json`.

## Before Editing

1. Read `package.json` and the nearby production and test code.
2. Check APIs against the installed declarations under `node_modules` or the `effect@3.22.0` tag.
3. Keep the current v3 service and Layer architecture unless the task explicitly requests a migration.

Effect v4 examples use different service, package, and unstable-module APIs. Do not translate working v3 code to `ServiceMap.Service` or `effect/unstable/*` while this project remains on v3.

## Implementation Rules

- Keep expected failures in the typed error channel. Use `Effect.try` or `Effect.tryPromise` for operations that may throw or reject; use `Effect.sync` or `Effect.promise` only when the operation is genuinely infallible.
- Decode unknown HTTP, GitHub, OpenCode, environment, and database values with Schema at their boundary instead of asserting types.
- Keep `Effect.run*` and `BunRuntime.runMain` at host integration boundaries. Compose Effects within services and workers.
- Acquire live servers, processes, files, database resources, and subscriptions with scoped ownership and explicit finalizers.
- Preserve interruption. Cleanup must terminate owned work, await completion, and avoid turning cancellation into an expected domain failure.
- Build Layers once near subsystem or application composition roots. Service methods should expose their real errors and requirements instead of hiding local provisioning.
- Keep direct Bun subprocess code when workflowd needs its process-group and bounded-output behavior; do not replace it with a higher-level API without preserving those guarantees.
- Prefer existing domain tags, branded identifiers, Schema models, and service contracts over parallel local representations.

## Verification

Run targeted tests while editing, then finish with:

```bash
bun run check
```

The check must typecheck, analyze all project files with the Effect language service, lint, verify formatting, and pass the test suite. If Effect diagnostics report fewer checked files than total files, treat the check as failed rather than accepting incomplete analysis.
