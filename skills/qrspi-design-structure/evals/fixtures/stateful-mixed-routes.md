# Accepted Structure input package: Meridian Ledger posting service

This file is a complete accepted Structure input package for evaluation; a producer
applies the contract to the text below without opening the fictional repository. The
repository is `meridian/ledgersvc`, the TypeScript and PostgreSQL posting service behind
the Meridian Ledger product, and the accepted implementation baseline commit is
`4b1e88c07a3d9f61e5c2148d0ab73fe9c15d8207`. Everything under "Repository baseline
inventory" is factual repository state at that commit.

## Binding

| Field | Value |
| --- | --- |
| workflowId | `wf_meridian_ledgersvc_LEDG-482` |
| generation | `4` |
| accepted Design revision | `03-design.md` revision `3`, commit `7c05a91d2b64ef38a0d7159c4be26f8103ad57bb` |
| acceptance package sha256 | `9f2a1c4d7b60e358a1c94f2d0e77b613c8d5a9042f1b7e6a55c30d81e4a9b72f` |
| gate response sha256 | `3c7e15b9a04d6621f8b2e9571d3a4c086e90b7d255af1c34b721e6d098c4a5f3` |
| promotion request sha256 | `71d0c8a42e6b3f95c40a7d189b52e6c30f8d4a17d3e95b62a86c1f4027b9e5d8` |
| promotion result sha256 | `e58b3d0761c4a92f2d70b8e5b93f61ca4a0d27e68c15b3f97e2a604d1fb8c395` |
| pinned graph snapshot identity | `meridian-ledger-graph@snapshot-2026-04-11T09:22:04Z-0007` |
| snapshot content hash | `0a4f92c6d715b8306c29e4a7f38b105d92e7c461b0d38fa54c17e2b986a05d3f` |
| Structure policy | `structure-coverage-policy`, revision `2.3.0`, sha256 `c62b8f0419d7a3e585f0c2b6d47e91a33b8560cfe2a94d1770c3b8e5a91f6d24` |
| deviation | none; the snapshot is pinned by the confirmed promotion result |

## Accepted graph records

### Informational sources

| Logical ID | Graph ID | Statement |
| --- | --- | --- |
| S1 | `ledgersvc-d7-4b1e88-src-s1` | Support runbook `docs/runbooks/posting-rejections.md`, describing how rejection reasons reach support staff. |
| S2 | `ledgersvc-d7-4b1e88-src-s2` | Treasury policy note "Daily debit caps for retail accounts", version 2026-03. |
| S3 | `ledgersvc-d7-4b1e88-src-s3` | Correspondent Bank API reference, settlement instruction endpoint, version 4.2. |
| S4 | `ledgersvc-d7-4b1e88-src-s4` | Incident report INC-2291, a duplicate settlement instruction sent after a client timeout. |
| S5 | `ledgersvc-d7-4b1e88-src-s5` | Interest accrual product brief, revision 7. |

### Accepted requirements

| Logical ID | Graph ID | Statement |
| --- | --- | --- |
| R1 | `ledgersvc-d7-4b1e88-req-r1` | A posting that would take an account's same-day debit total above its configured daily debit limit is rejected with reason `daily_debit_cap_exceeded`. |
| R2 | `ledgersvc-d7-4b1e88-req-r2` | A balance response states the amount held by active holds separately from the available balance. |
| R3 | `ledgersvc-d7-4b1e88-req-r3` | An interest-bearing account accrues interest once per booking day, and each accrual is durably recorded so it is neither skipped nor repeated across restarts. |
| R4 | `ledgersvc-d7-4b1e88-req-r4` | When an entry settles against a correspondent bank, exactly one settlement instruction for that entry reaches the bank. |
| R5 | `ledgersvc-d7-4b1e88-req-r5` | Every rejection reason recorded on a posting is one of the seeded reason codes and is counted in posting rejection metrics. |
| R6 | `ledgersvc-d7-4b1e88-req-r6` | For any rejected posting, support can read the reason code and the limit value that applied at posting time. |

### Accepted decisions and resolutions

| Logical ID | Graph ID | Position |
| --- | --- | --- |
| D1 | `ledgersvc-d7-4b1e88-res-d1` | Enforce the daily debit cap as one more posting guard registered in the existing guard registry, reading the account limit and the same-day debit total through the existing posting reader. Authorizes work in this repository. |
| D2 | `ledgersvc-d7-4b1e88-res-d2` | Report the held amount on the existing balance view, computed from the existing hold store and served through the existing balance RPC handler. Authorizes work in this repository. |
| D3 | `ledgersvc-d7-4b1e88-res-d3` | Record each interest accrual as a durable accrual run with its own states and day cursor, so a restarted process neither skips nor repeats a booking day. Authorizes work in this repository. |
| D4 | `ledgersvc-d7-4b1e88-res-d4` | Send the settlement instruction to the correspondent bank when an entry settles, and reconcile instructions whose outcome the service cannot observe. Authorizes work in this repository. |
| D5 | `ledgersvc-d7-4b1e88-res-d5` | ledgersvc must not send customer-facing notifications and must not add a notification transport, queue, or template to this repository. Authorizes no work; forbids a surface. |
| D6 | `ledgersvc-d7-4b1e88-res-d6` | The regulatory accrual extract and its filing schedule are owned by the FinOps reporting service under ticket `FINOPS-2214`. ledgersvc publishes no extract and re-plans none of that work. |

### Accepted controls and rules

| Logical ID | Graph ID | Statement |
| --- | --- | --- |
| C1 | `ledgersvc-d7-4b1e88-rul-c1` | Every posting guard evaluates inside the posting transaction and returns a seeded reason code; a guard may not open its own transaction. |
| C2 | `ledgersvc-d7-4b1e88-rul-c2` | Every rejection path increments the rejection counter with the reason code label. |
| C3 | `ledgersvc-d7-4b1e88-rul-c3` | No account limit value may be read from a cache that outlives the posting transaction. |
| C4 | `ledgersvc-d7-4b1e88-rul-c4` | Any outbound instruction to a correspondent bank carries a deterministic idempotency key derived from the entry identity. |
| C5 | `ledgersvc-d7-4b1e88-rul-c5` | Money amounts are integer minor units; posting and accrual paths use no floating point arithmetic. |

### Accepted verification obligations

| Logical ID | Graph ID | Obligation |
| --- | --- | --- |
| V1 | `ledgersvc-d7-4b1e88-ver-v1` | Prove that a posting at the limit is accepted and a posting one minor unit above it is rejected with the seeded reason code. |
| V2 | `ledgersvc-d7-4b1e88-ver-v2` | Prove that the balance response reports held and available amounts for an account holding both active and expired holds. |
| V3 | `ledgersvc-d7-4b1e88-ver-v3` | Prove that an accrual interrupted part way through a booking day is neither repeated nor skipped after a process restart. |
| V4 | `ledgersvc-d7-4b1e88-ver-v4` | Prove that a settlement instruction whose response is lost resolves to exactly one instruction at the bank. |

### Accepted residual risk dispositions

| Logical ID | Graph ID | Disposition |
| --- | --- | --- |
| X1 | `ledgersvc-d7-4b1e88-rsk-x1` | Treasury may change daily limits without telling engineering. Accepted. Owner: Treasury Ops, T. Ferran. Condition: limits stay in `accounts.daily_debit_limit_minor`. Follow-up: quarterly limit review, ticket `TREAS-77`. |
| X2 | `ledgersvc-d7-4b1e88-rsk-x2` | Correspondent bank timeout behaviour is documented but unverified against production. Accepted for the first release. Owner: Payments lead, M. Okoye. Condition: instructions stay idempotent. Follow-up: shadow run before enablement, ticket `PAY-1310`. |
| X3 | `ledgersvc-d7-4b1e88-rsk-x3` | Booking timezones are not uniform across legacy accounts, so a booking day boundary can differ by account. Accepted. Owner: Ledger lead, A. Weiss. Condition: each accrual records the timezone it used. Follow-up: legacy account audit, ticket `LEDG-503`. |

## Accepted edges

Edge IDs follow `<edge_type>_<from_type>_<from_id>_to_<to_type>_<to_id>`, where the type
segments are `src`, `req`, `res`, `rul`, `ver`, and `rsk`, and the IDs are the exact graph
IDs above. The graph records no dependency edge between D1, D2, D3, and D4.

| Edge ID | Reads as |
| --- | --- |
| `needs_req_ledgersvc-d7-4b1e88-req-r1_to_src_ledgersvc-d7-4b1e88-src-s2` | R1 cites the treasury policy note. |
| `needs_req_ledgersvc-d7-4b1e88-req-r4_to_src_ledgersvc-d7-4b1e88-src-s4` | R4 cites incident INC-2291 and, through it, the correspondent API reference S3. |
| `needs_req_ledgersvc-d7-4b1e88-req-r3_to_src_ledgersvc-d7-4b1e88-src-s5` | R3 cites the accrual product brief. |
| `needs_req_ledgersvc-d7-4b1e88-req-r6_to_src_ledgersvc-d7-4b1e88-src-s1` | R6 cites the support runbook. |
| `resolves_res_ledgersvc-d7-4b1e88-res-d1_to_req_ledgersvc-d7-4b1e88-req-r1` | D1 resolves R1. |
| `resolves_res_ledgersvc-d7-4b1e88-res-d1_to_req_ledgersvc-d7-4b1e88-req-r5` | D1 resolves R5. |
| `resolves_res_ledgersvc-d7-4b1e88-res-d1_to_req_ledgersvc-d7-4b1e88-req-r6` | D1 resolves R6. |
| `resolves_res_ledgersvc-d7-4b1e88-res-d2_to_req_ledgersvc-d7-4b1e88-req-r2` | D2 resolves R2. |
| `resolves_res_ledgersvc-d7-4b1e88-res-d3_to_req_ledgersvc-d7-4b1e88-req-r3` | D3 resolves R3. |
| `resolves_res_ledgersvc-d7-4b1e88-res-d4_to_req_ledgersvc-d7-4b1e88-req-r4` | D4 resolves R4. |
| `produces_res_ledgersvc-d7-4b1e88-res-d1_to_rul_ledgersvc-d7-4b1e88-rul-c1` | D1 produces C1. |
| `produces_res_ledgersvc-d7-4b1e88-res-d1_to_rul_ledgersvc-d7-4b1e88-rul-c2` | D1 produces C2. |
| `produces_res_ledgersvc-d7-4b1e88-res-d1_to_rul_ledgersvc-d7-4b1e88-rul-c3` | D1 produces C3. |
| `produces_res_ledgersvc-d7-4b1e88-res-d4_to_rul_ledgersvc-d7-4b1e88-rul-c4` | D4 produces C4. |
| `produces_res_ledgersvc-d7-4b1e88-res-d3_to_rul_ledgersvc-d7-4b1e88-rul-c5` | D3 produces C5, which also binds D1, D2, and D4. |
| `needs_ver_ledgersvc-d7-4b1e88-ver-v1_to_res_ledgersvc-d7-4b1e88-res-d1` | V1 attaches to D1. |
| `needs_ver_ledgersvc-d7-4b1e88-ver-v2_to_res_ledgersvc-d7-4b1e88-res-d2` | V2 attaches to D2. |
| `needs_ver_ledgersvc-d7-4b1e88-ver-v3_to_res_ledgersvc-d7-4b1e88-res-d3` | V3 attaches to D3. |
| `needs_ver_ledgersvc-d7-4b1e88-ver-v4_to_res_ledgersvc-d7-4b1e88-res-d4` | V4 attaches to D4. |
| `needs_rsk_ledgersvc-d7-4b1e88-rsk-x1_to_res_ledgersvc-d7-4b1e88-res-d1` | X1 attaches to D1. |
| `needs_rsk_ledgersvc-d7-4b1e88-rsk-x2_to_res_ledgersvc-d7-4b1e88-res-d4` | X2 attaches to D4. |
| `needs_rsk_ledgersvc-d7-4b1e88-rsk-x3_to_res_ledgersvc-d7-4b1e88-res-d3` | X3 attaches to D3. |
| `needs_res_ledgersvc-d7-4b1e88-res-d6_to_req_ledgersvc-d7-4b1e88-req-r3` | D6 assigns the reporting side of R3 to FinOps under `FINOPS-2214`. |

## Repository baseline inventory

Facts about `meridian/ledgersvc` at commit `4b1e88c07a3d9f61e5c2148d0ab73fe9c15d8207`.

### Posting, service, and external code

| Path | Facts at the baseline commit |
| --- | --- |
| `src/store/ledger-store.ts` | Exports `LedgerStore` with `withTransaction(fn)`, `postEntry(tx, input: PostEntryInput, guards: PostingGuard[]): Promise<PostEntryResult>`, and `listEntriesForAccount(accountId, window)`. |
| `src/store/posting-guard.ts` | Exports the `PostingGuard` interface with `evaluate(ctx: PostingContext): GuardOutcome`, and the `PostingContext` type carrying `accountId`, `amountMinor`, `postedAt`, `tx`, and `reader: PostingReader`. |
| `src/store/posting-reader.ts` | Exports `PostingReader` with `sumDebitsInWindow(accountId, from, to): Promise<bigint>` and `getAccount(accountId): Promise<AccountRow>`, both bound to the caller's transaction. |
| `src/store/guards/`, `src/store/guard-registry.ts` | The directory contains `insufficient-funds-guard.ts` and `account-status-guard.ts`; the registry exports `defaultGuards: PostingGuard[]`, composed from every file in that directory. |
| `src/store/hold-store.ts`, `src/service/balance-service.ts` | `HoldStore` exposes `listActiveForAccount(accountId)` and `totalActiveMinor(accountId): Promise<bigint>`; `BalanceService.getBalance(accountId): Promise<BalanceView>` runs inside `LedgerStore.withTransaction` and already calls `HoldStore`. |
| `src/service/balance-view.ts`, `src/service/rpc/balance-handler.ts` | `BalanceView` declares `availableMinor`, `postedMinor`, `currency`, and an additive optional-field convention stated in the file header; the handler maps it onto the wire response and forwards optional fields it does not itself name. |
| `src/service/rejection.ts`, `src/observability/metrics.ts` | `RejectionReason` is loaded at start from the `ledger_rejection_reasons` table; metrics exports `counter()` and `histogram()` and registers `ledger_posting_rejected_total` with a `reason` label. |
| `src/external/correspondent-client.ts` | Exports `CorrespondentClient.fetchBalance(bankId)`. That is its only method. |

### Schema and migrations

| Path | Facts at the baseline commit |
| --- | --- |
| `db/migrations/0001_accounts.sql`, `db/migrations/0002_ledger_entries.sql` | `accounts` has `id`, `currency`, `status`, `daily_debit_limit_minor bigint not null`, `interest_bearing boolean not null`, and `booking_timezone text not null`; `ledger_entries` has the index `idx_ledger_entries_account_posted_at (account_id, posted_at)`. |
| `db/migrations/0003_holds.sql` | Creates `holds` with `account_id`, `amount_minor`, `expires_at`, and the index `idx_holds_account_active`. |
| `db/migrations/0004_rejection_reasons.sql` | Creates `ledger_rejection_reasons` and seeds `insufficient_funds`, `account_frozen`, `currency_mismatch`, and `daily_debit_cap_exceeded`. |
| `db/migrations/0005_hold_expiry.sql`, `db/README.md` | `0005` adds the hold expiry sweep index and is the highest-numbered migration in the tree; the README states the forward-only migration convention and file naming pattern. |

### Tests and fixtures

| Path | Facts at the baseline commit |
| --- | --- |
| `test/support/database.ts`, `test/support/fixtures.ts` | `withEphemeralDatabase(fn)` applies every migration to a throwaway database per test file; `seedAccount(overrides)`, `seedEntries(accountId, rows)`, and `seedHolds(accountId, rows)` populate it. |
| `test/support/guards.ts`, `test/support/balance.ts` | `runGuard(guard, ctx)` evaluates one guard against a seeded transaction; `buildBalanceHarness()` wires `BalanceService`, `HoldStore`, and the RPC handler against a seeded database. |
| `test/support/http-stub.ts` | Serves fixed recorded responses for `CorrespondentClient` reads. It has no delay, timeout, error-injection, or partial-response mode. |
| `test/store/posting-guard.test.ts` | Covers both registered guards through `runGuard` and `seedEntries`, including boundary amounts. |
| `test/store/ledger-store.test.ts`, `test/store/hold-store.test.ts`, `test/db/migrations.test.ts` | The store tests follow the `withEphemeralDatabase` plus `seed*` pattern; the migration test applies every migration forward and asserts the resulting schema. |
| `test/service/balance-service.test.ts` | Uses `buildBalanceHarness()` and asserts the wire response fields, including holds that have expired. |

### Absent at this baseline

- No `accrual_runs`, `accrual_days`, or equivalent table, no migration above `0005`, no durable run, job, schedule, or cursor record of any kind, no scheduler process, timer loop, or cron entry in `src/` or in the deployment manifests under `deploy/`, no state machine or transition module anywhere in `src/`, and no fencing token, lease, or claim column in any table.
- No interest calculation code; `src/` contains no rate, accrual, or day-boundary module.
- No outbound write to any external system: `CorrespondentClient` declares no write method, and there is no `correspondent_instructions` table, idempotency key store, outbox, or instruction status column. No recovery, reconciliation, or unknown-outcome rule for any external effect exists, and no code in `src/` observes an external system after a failed attempt.
- No test support for fault injection, process restart, clock control, or coordinating a database and an HTTP stub inside one scenario. `test/support/` contains `database.ts`, `fixtures.ts`, `guards.ts`, `balance.ts`, and `http-stub.ts` only.
- No notification transport, queue, template, or customer messaging code in `src/`, no reporting or extract code in `src/`, and no export job in `deploy/`.
