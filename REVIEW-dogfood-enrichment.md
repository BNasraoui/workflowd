# Thermonuclear Code Review — Dogfood Session Enrichment Endpoint

- **Under review:** `git diff 32c43af..a4a23102e0dc3fe768eac28b6ed7b96f653bb53b` — *"Expose read-only dogfood session enrichment (provenance-dogfood-enrichment/v1)"* on `agent-run/9de0ab65b0382e1e`
- **Scope:** 11 files, +639/−9 — `src/config.ts`, `src/http.ts`, `src/kernel/dogfood-store.ts` (new), `src/layers.ts`, `src/runtime.ts`, `deploy/workflowd.env.example`, plus tests (`test/config.test.ts`, `test/kernel/dogfood-http.test.ts` (new), `test/kernel/dogfood-store.test.ts` (new), `test/layers.test.ts`, `test/runtime.test.ts`)
- **Method:** every finding below was verified against the full code path on the reviewed tree (checked out at `a4a2310` via a scratch branch, since the branch itself is held by another worktree). Performance claims are **empirically measured**, not speculative; query plans are from `EXPLAIN QUERY PLAN` against the real migration schema.

---

## Gate results (run on the reviewed tree, `a4a2310`)

| Gate | Command | Result |
|---|---|---|
| Tests | `bun test` | **1344 pass, 0 fail** (3063 assertions, 131 files, 66.78s) |
| Typecheck | `bun run typecheck` (tsc --noEmit) | clean |
| Lint | `bun run lint` (eslint --max-warnings=0) | clean |
| Format | `bun run format:check` (prettier) | clean |
| Dead exports | `bun run knip` | clean |
| Effect diagnostics | `bun run effect:check` | clean (266/266 files) |
| Skill sync | `bun run skill:check` | clean |

All gates green. The findings below are things the gates **cannot** see.

---

## Findings (ranked)

### 1. MAJOR — Unindexed correlated subquery: O(sessions × runs) full scan per request, on a synchronous driver

**Where:** `src/kernel/dogfood-store.ts:84-89` (query), interacting with `src/store/migrations.ts:1221-1262` (`kernel_agent_runs` has **no index on `session_id`** — the only index is the partial `kernel_agent_runs_watchable ON (state, updated_at, run_id) WHERE state IN (...)`, which the subquery cannot use because it filters on `session_id`).

**What breaks:** For every `kernel_sessions` row, the correlated scalar subquery `SELECT r2.run_id FROM kernel_agent_runs r2 WHERE r2.session_id = s.session_id ORDER BY r2.updated_at DESC, r2.run_id DESC LIMIT 1` does a **full table scan of `kernel_agent_runs` plus a temp B-tree sort**. `EXPLAIN QUERY PLAN` on the real schema confirms: `CORRELATED SCALAR SUBQUERY 1 → SCAN r2 → USE TEMP B-TREE FOR ORDER BY`.

**Measured (in-memory DB, real migrations, this exact query):**

| Ledger | Without index | With `CREATE INDEX kernel_agent_runs_session ON kernel_agent_runs (session_id, updated_at, run_id)` |
|---|---|---|
| 2,000 sessions / 20,000 runs | **3,620 ms**, plan `SCAN r2` per row | **23.5 ms** (~154× faster), plan shows no correlated scan |

That's ~2k sessions — a *young* ledger. `kernel_agent_runs` is the core append-only table (every `register` inserts; `completed`/`failed` rows are never purged), so the cost grows **quadratically** and forever.

**Why it's worse than "slow endpoint":** the Bun sqlite client executes `prepare(...).all(...)` **synchronously on the main thread** (`node_modules/@effect/sql-sqlite-bun/dist/SqliteClient.js:86`), inside Effect. One GET doesn't just stall the CLI — it **freezes the entire workflowd process**: webhook ingestion (GitHub will retry/timeout), the kernel worker loop, and every other route.

**Concrete failure scenario:** dogfood is enabled on the long-lived deployment; after a few months the ledger passes ~10k sessions / ~100k runs; someone runs `provenance dogfood report --enrich -`; workflowd stalls for tens of seconds to minutes, in-flight GitHub webhooks time out, jobs stop ticking. No test can catch this — the store tests seed 2 sessions — so CI stays green right up until production.

**Fix:** migration adding `CREATE INDEX kernel_agent_runs_session ON kernel_agent_runs (session_id, updated_at, run_id)` (proven above: 154×, plan collapses to an index seek). Optionally also rewrite the join as a single `GROUP BY`/window max to avoid per-row seeks. Severity arguably reaches **critical** for any deployment that leaves the route enabled, purely on availability.

### 2. MAJOR — Duplicate `native_session_id` rows shadow each other by unspecified scan order; run data silently disappears

**Where:** `src/kernel/dogfood-store.ts:91` (`ORDER BY s.native_session_id` — not unique) and `:96` (`Object.fromEntries(...)` — silent last-write-wins).

**What breaks:** The schema *permits* duplicate `native_session_id` across custody sessions: `kernel_sessions`' uniqueness for live sessions is only the partial index `kernel_sessions_active_native ON (provider_kind, provider_id, server_id, endpoint_identity, native_session_id) WHERE state IN ('ready','active')` (`src/store/migrations.ts:906-908`). Legal duplicate states include: same native id on two endpoint identities, and a `completed` history row coexisting with a fresh `ready` row (re-registration after harness restart/resume — exactly the lifecycle dogfood data accumulates). The query has **no state filter and no session-side tiebreak**, so when two rows share a native id, the winner is whatever the scan order says. SQLite explicitly does not guarantee ordering of equal keys.

**Demonstrated (against the real schema):** two custody sessions with native id `ses_dup` — session A (`gpu-box`) with two agent runs, session B (`mint`) with none — produce `{"harness":"opencode","harness_version":1,"machine":"mint"}`: **B wins by insertion luck and A's run data (`model`/`agent`/`repository`) vanishes from the document entirely**. A different plan or insert order flips the winner. The commit message promises "latest run wins"; it says nothing about which *session* wins, and the implementation doesn't either.

**Concrete failure scenario:** a pain-point note cites native session `ses_x`; the ledger holds a completed row and a re-registered row for it; the enrichment attributes the note to the wrong harness/machine or drops the model/agent/repository fields — the provenance report silently mislabels provenance, which is the one thing this endpoint exists to guarantee.

**Fix:** make the winner a contract decision: e.g. `ORDER BY s.native_session_id, (s.state IN ('ready','active')) DESC, s.updated_at DESC, s.session_id DESC` and dedupe in TypeScript (first-wins) — plus a regression test pinning which session wins and an assertion that a run-bearing session is never shadowed by a run-less one.

### 3. MINOR — The `run_id DESC` tiebreak is deterministic but semantically arbitrary

**Where:** `src/kernel/dogfood-store.ts:87`.

`updated_at` ties are realistic (`markSpawned` bursts pass the same `now` for multiple runs; `src/kernel/agent-run-store.ts:268-273`). Production run ids are `agent-run-<sha256 hex>` (`src/kernel/agent-run-ingress.ts:122`) — hash-derived, with **no time ordering** — so `run_id DESC` picks an arbitrary run on ties (e.g. a run spawned at 09:00:00.000 loses to a hash-greater run also updated at 09:00:00.000). The store test only pins the tiebreak with *distinct* `updated_at` values (`test/kernel/dogfood-store.test.ts:135-158`), so this path is unpinned. Output is stable per-DB (total order via unique `run_id`), hence minor, but "latest run wins" is false on ties. **Fix:** `ORDER BY updated_at DESC, created_at DESC, run_id DESC`, or document run_id as a purely deterministic tiebreak.

### 4. MINOR — One malformed row 500s the entire ledger document

**Where:** `src/kernel/dogfood-store.ts:93` (`Effect.forEach(rows, decodeRow)` — fail-fast) and the `DogfoodStoreDataError` path. A single row that fails `EnrichmentRow` decode (e.g. a legacy row written before a CHECK constraint tightened) fails the whole request → the endpoint serves nothing for anyone. The HTTP test covers only `SqlError` → 500 (`test/kernel/dogfood-http.test.ts:84-94`); the data-error path is untested. **Fix:** skip-and-log the offending row (the contract is a report join, not a financial ledger), and add the decode-failure 500 test.

### 5. NIT — No state filter on `kernel_sessions`

`src/kernel/dogfood-store.ts:90` fences null/empty native ids but includes sessions in every state, including `data_error` and `operator_required`. Including `completed` history is clearly right for a provenance join; whether junk-state rows should be published deserves a one-line comment or a state list.

### 6. NIT — Test gaps beyond the happy path

What the tests *do* pin well: 200 with contract body, 401 without consulting the store (`called === 0`), 404 when unconfigured, 500 on `SqlError`, omitted-not-null for run-less sessions, latest-run-wins with distinct timestamps, empty-native-id fence (forced via `PRAGMA ignore_check_constraints` — a nice touch), wiring (layers + startup-defect test with real HTTP fetch). What they would **not** catch: findings 1–3 (no large-ledger perf test, no duplicate-native-id test, no equal-`updated_at` tiebreak test), non-GET methods on the configured path (falls through to 404 — same as every neighbor, but untested), and the `DogfoodStoreDataError` branch.

### 7. NIT — Method guard returns 404 rather than 405 for non-GET

`src/http.ts:105-111`: with dogfood configured, `POST /workflows/dogfood/sessions` falls through to the generic 404. Consistent with all neighboring surfaces (none emit 405), so not a regression — just imprecise, and a HEAD request also 404s.

### 8. NIT — No docs page for the new surface

`docs/mcp-server.md` documents the agent-wait surface; the dogfood route/token lives only in `deploy/workflowd.env.example` and the store's doc comment. The env-example text is accurate (omit both → disabled; exactly one source when enabled), so this is optional polish.

---

## Dimensions audited clean (verified, not assumed)

- **Token comparison — timing-safe, house pattern, no homebrew.** The route uses the *same* shared `authorized()` helper as qrspi/test-jobs/agent-waits/agent-runs (`src/http.ts:422-427`): SHA-256 both sides, then `crypto.timingSafeEqual`. Length-independent, constant-time. The dogfood binding is structurally identical to `AgentRunIngressBinding` (`token` + port method).
- **Config validation — documented conventions followed exactly.** Both sources set → `WORKFLOWD_DOGFOOD_TOKEN and WORKFLOWD_DOGFOOD_TOKEN_FILE cannot both be set`; neither set → feature absent (`dogfood` omitted from `AppConfig`, route absent → 404, tested); empty direct token → "must not be empty"; file token strips one trailing newline then rejects empty; the **min-8-chars check applies to file-sourced tokens too** (`src/config.ts:346-352`) and matches the `WORKFLOWD_AGENT_RUN_TOKEN`/`TEST_JOB`/`AGENT_WAIT` wording ("must contain at least 8 characters", tested at `test/config.test.ts:385-393`). All failures throw from `loadConfig` → startup error, per convention.
- **SQL injection surface — zero.** The query is a compile-time tagged-template literal; no interpolated user input anywhere in the file.
- **Contract fidelity.** Exactly `{"contract": "provenance-dogfood-enrichment/v1", "sessions": {...}}` with the six snake_case fields serialized verbatim (`transformRows` is undefined in this client, so no case mangling). Omitted-not-null is correct at the type *and* value level: the only NULLs the LEFT JOIN can produce are the run columns of run-less sessions (all `kernel_agent_runs` joined columns are `NOT NULL`), and `toEnrichment` spreads them away (`:61-69`); pinned by `dogfood-store.test.ts:107-131`. `harness_version` is `INTEGER NOT NULL CHECK (> 0)` in a STRICT table ↔ `Schema.Int`. Field mapping matches spec: `provider_kind→harness`, `provider_version→harness_version`, `owning_host_id→machine`, `model_id→model`, `agent`, `repository`.
- **Information disclosure — nothing beyond the contract.** The SELECT names seven columns; `prompt`, `prompt_sha256`, `resume_prompt`, `directory`, `diagnostic`, `endpoint_identity`, `endpoint_alias`, session ids and state are never emitted. Binding defaults to `127.0.0.1` (`src/config.ts:489`, `WORKFLOWD_HOST`); exposing via `tailscale serve` is an operator choice that would also expose every other token-gated route — the bearer token remains mandatory on this path, so the posture is unchanged relative to the agent-run/agent-wait surfaces.
- **HTTP details.** 200 `application/json`; 401 `{"error":"unauthorized"}` returned *before* the store is touched (asserted by the `called === 0` test); store failures log the cause for operators but emit only `{"error":"internal server error"}` — matching every sibling handler.
- **Read-only claim — holds.** The port executes exactly one SELECT; no INSERT/UPDATE/DELETE, no pragma, no migration in the request path. (The WAL/`busy_timeout` pragmas at `SqliteClient.js:73-75` fire once at client construction and predate this change; migrations at startup are the pre-existing `WorkflowStoreLive` behavior.)
- **Effect idioms / house style — matches neighbors.** `Context.Service` naming (`workflowd/kernel/DogfoodStore`), `Data.TaggedError`, `Layer.effect(X, make)` (identical to `AgentRunStoreLive`/`KernelSessionStoreLive`), membership in the shared `kernelStoreLayer` (`src/layers.ts:197`), the optional-service startup defect guard mirrors `agentRuns` exactly (`src/runtime.ts:222-224`, tested as a startup death in `runtime.test.ts:1000-1017`), and the runtime binding is copy-shaped after `testJobCanary`/`agentWaits`/`agentRuns` (`src/runtime.ts:464-471`). `Effect.logError` + opaque 500 on `catchCause` is the standard pattern here.

---

## What the commit message promises vs. what's pinned

| Commit-message claim | Pinned by tests? |
|---|---|
| Join `kernel_sessions` → `kernel_agent_runs` on `session_id` | Yes (`dogfood-store.test.ts`) |
| Keyed by `native_session_id` | Yes |
| Latest run wins | Only when `updated_at` differs — tie path unpinned (finding 3) |
| Null/empty native ids fenced out | Yes (empty forced via `ignore_check_constraints`) |
| Omitted-not-null fields | Yes |
| Exactly-one-source token, 404 unconfigured, 401 bad token, read-only | Yes |
| *Implicit:* document correct under duplicate native ids / big ledgers | **No** (findings 1–2) |
