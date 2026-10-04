# Fixture: plan revision after a runtime contradiction

Treat these sections as command output. Do not run commands or publish anything.
The repository has no `.provenance/`.

## Bead workflowd-x41

The ticket asks for exponential retry backoff. Notes link the draft PR
https://github.com/BNasraoui/workflowd/pull/90 and the approved plan
https://gist.github.com/example/p41.

## Research https://gist.github.com/example/r41

Repository: BNasraoui/workflowd at 9b2e4c7a1d0f3e6b8a5c2d9f4e7a0b3c6d1e8f25.
`src/worker.ts:88-91` calls `scheduleRetry`. `src/runtime.ts:30-52` defines
`WorkerDeps` with a clock and no random source. The simulation harness at
`test/remote/simulation/harness.ts:40-49` constructs `WorkerDeps`.

## Implement report https://gist.github.com/example/i41

Phase 1 was pushed. Phase 2 stopped for plan revision: the approved plan names
`src/worker.ts` and the new corpus scenario, but the worker needs a random source
in `WorkerDeps` and the simulation harness needs a seeded random source. These
require changes to `src/runtime.ts` and `test/remote/simulation/harness.ts`.
