# Post-Structure Scope Review: Durable Tagged Stage Runtime State

## Verdict

`SplitFeature`

Keep `workflowd-vs3.4.3` as the parent implementation task and create bounded child
tasks under its accepted Design. The ticket has one coherent outcome and does not
contain independently prioritizable product features, but its persistence, transition,
bootstrap, quarantine, and restart boundaries are too large for one detailed
implementation and review unit.

## Estimate

```text
estimatedChangedLines:
  low: 4440
  likely: 6300
  high: 8650
confidence: medium
decision: SplitFeature
```

The range counts additions and substantive edits to human-authored production code,
tests, migrations, configuration, and required documentation. It excludes generated
files, lockfiles, vendored code, and formatter-only churn. No configuration change or
additional implementation documentation is currently required; the high estimate
allows 50 lines if a required operator-facing format note emerges.

| Planned surface | Low | Likely | High | Basis |
| --- | ---: | ---: | ---: | --- |
| `src/qrspi/stage-runtime.ts` | 450 | 600 | 800 | New strict identities, tagged records, authority inputs, results, and typed errors |
| `src/qrspi/store.ts` | 1,400 | 1,900 | 2,500 | Row decoders, aggregate reads/writes, all-dimension transactions, replacement, bootstrap, claims, quarantine, and format-aware reload |
| `src/store/migrations.ts` | 300 | 450 | 650 | Several strict related tables, composite keys, checks, partial indexes, cursor columns, format extension, and prior-frontier runner |
| `src/qrspi/domain.ts`, `src/qrspi/contracts/common.ts` | 40 | 90 | 150 | Narrow shared identifier and reference reuse only |
| `test/qrspi/store.test.ts` | 1,800 | 2,500 | 3,300 | New real-SQLite suite covering two tags, stale dimensions, rollback, replacement, bootstrap, corruption, and reopen |
| `test/store/migrations.test.ts` | 250 | 400 | 600 | Schema rejection matrix and file-backed upgrade proof |
| `test/qrspi/workflow-start.test.ts` | 100 | 180 | 300 | Placeholder, preflight-format, and unchanged-kickoff integration checks |
| `test/qrspi/stage-replay.test.ts` | 100 | 180 | 300 | Runtime-owned replay and quarantine-routing boundary checks |
| Required configuration/documentation | 0 | 0 | 50 | No planned change; contingency only |
| **Total** | **4,440** | **6,300** | **8,650** | |

## Evidence

- The current `src/qrspi/store.ts` is 1,513 lines and its `QrspiStorePort` is centered on
  WorkflowStart plus one `StageProduceInput` read. The Structure adds a second durable
  aggregate family, several public transition methods, strict aggregate decoding, and
  four distinct transaction protocols to that boundary.
- `src/store/migrations.ts` is 640 lines. Its current QRSPI schema has WorkflowOperation,
  Generation, ticket, workflow-definition, and stage-definition records, but no
  StageRun, common or tagged StageRevision, step, immutable-reference,
  operation-ownership, revision-diagnostic, or guarded stage-pointer tables. The new
  migration therefore adds a related schema family rather than one table or column.
- The planned `test/qrspi/store.test.ts` does not exist. The Structure requires it to
  cover document and implementation round trips, ordered children and references, a
  stale matrix that changes each authority dimension, rollback, replacement,
  bootstrap idempotence, a broad corruption matrix, terminal-history behavior, and
  file-backed reopen. That test surface is at least as material as the production
  store work.
- Existing nearby files show the repository's verification density:
  `test/qrspi/workflow-start.test.ts` is 2,317 lines for the existing start protocol,
  `test/qrspi/stage-replay.test.ts` is 1,021 lines, and
  `test/store/migrations.test.ts` is 833 lines. The requested runtime protocol combines
  comparable persistence, stale-authority, corruption, and restart concerns.
- The current WorkflowStart completion path in `src/qrspi/store.ts:1268-1392` uses about
  125 lines for one Generation allocation transaction after its earlier validation and
  recovery support. Bootstrap must additionally compare every placeholder and pointer,
  install a full tagged aggregate and operation ownership, change format, handle exact
  duplicate recovery, and reject partial state.
- The existing strict snapshot decoder in `src/qrspi/store.ts:341-516` uses about 175
  lines for one ordered record family. Runtime decoding must cover common revisions,
  two tagged payloads, implementation steps, references, operation ownership,
  pointers, diagnostics, relational identities, ordering, and hashes.
- The merged trusted-stage-catalog change (`c5a18e2`) changed about 3,862 lines across
  the comparable QRSPI production, migration, and test surfaces (3,665 additions and
  197 deletions). The merged exact-stage-contract change (`50be40c`) changed about
  6,109 lines on those surfaces (5,992 additions and 117 deletions). The present ticket
  combines a new relational model with more transaction and recovery behavior than
  either one local schema extension; a likely estimate near 6,300 changed lines is
  consistent with those repository examples.

## Scope Signals

- The six parent acceptance criteria divide into independently verifiable groups:
  aggregate shape, stale transition fencing, replacement, fresh bootstrap, corruption
  containment, and upgrade/restart recovery.
- The work introduces several durable protocols with different invariants: ordinary
  aggregate transitions, monotonic revision replacement, format-changing bootstrap,
  and terminal aggregate quarantine.
- Different trust boundaries dominate different parts. Typed caller input and SQL
  shape dominate persistence; lease and pointer authority dominate transitions;
  placeholder identity dominates bootstrap; readable mutable versus immutable
  authority dominates quarantine; file format dominates upgrade and restart.
- The Structure already identifies safe ordering and verification boundaries. A
  persisted but inactive aggregate can precede transition enablement; generic fencing
  can precede replacement and bootstrap; restart proof can close the integrated local
  capability after each transaction exists.
- The parts are not independently useful product capabilities. They share one accepted
  StageRun/StageRevision model and one runtime-store contract, and later QRSPI tickets
  require the complete result. This weighs against `PromoteToEpic`.
- One implementation would concentrate most changes in the already 1,513-line
  `src/qrspi/store.ts` and a new multi-thousand-line store test. That would make schema,
  stale-fence, bootstrap, and corruption findings compete in one review.
- `KeepLarge` is not justified. No atomic deployment requirement forces all behavior
  into one diff: the new schema and methods can remain inactive until bootstrap and
  claims are enabled, and every proposed child has a real SQLite verification boundary.
- No material uncertainty blocks estimation. The accepted Design resolves record
  ownership, state sets, bootstrap, quarantine, migration, legacy, and test boundaries,
  so `NeedsResearch` is not warranted.

## Decision Rationale

The likely estimate is more than six times the admission target, and even the low
estimate is more than four times it. The excess comes from required production behavior
and tests, not generated or mechanical churn. Treating the five Structure phases as one
implementation would reduce review depth across independently failure-prone transaction
boundaries.

The parent should not become an epic. Its children consume one accepted Design, expose
parts of one `QrspiStore` capability, and require no separate product choices. They are
ordered implementation tasks with inactive or guarded merge boundaries. Each child must
receive its own Structure scope review; the estimates below are provisional, and a child
whose high estimate remains above 1,000 lines may need a further split or an explicit
`KeepLarge` rationale.

## Proposed Decomposition

The labels `AC1` through `AC6` refer to the ticket's acceptance criteria in order. The
following local control and risk labels exist only to make coverage accounting explicit:

| Label | Control or risk |
| --- | --- |
| `C1` | SQL and Schema enforce exact tagged aggregate shape and durable identity |
| `C2` | Every mutation atomically fences all applicable currentness and lease authority |
| `C3` | Revision and operation history is immutable and replacement is monotonic |
| `C4` | Corrupt mutable authority is diagnosed and contained without guessed repair |
| `C5` | Generation format and ownership make legacy, partial, and placeholder work nonclaimable |
| `C6` | No owner lifecycle, status, capacity, or neighboring worker policy enters D3 |
| `R1` | Malformed or mismatched durable authority is used as trusted input |
| `R2` | Stale work advances a run, revision, pointer, step, reference, or operation |
| `R3` | Partial or mismatched bootstrap exposes placeholder work or loses history |
| `R4` | Quarantine loses uncertain-effect evidence or rewrites terminal history |
| `R5` | Upgrade or restart exposes legacy, partial-format, or incompletely owned work |

### Child 1: Persist and Reload Document Runtime Aggregates

Add the full append-only runtime schema foundation, shared StageRun/common-revision
Schemas, the document tag, guarded pointer columns, document references and operation
ownership, strict create/read methods, and real-SQLite document round-trip and rejection
tests. Create all tables needed by later children now, but expose only the verified
document aggregate path; no runtime claim or WorkflowStart behavior changes.

```text
provisionalChangedLines: { low: 650, likely: 900, high: 1200 }
dependsOn: existing workflowd-vs3.4.1 and workflowd-vs3.4.2
coverage: AC1(part), AC2(part tagged shape/current-row constraints), AC4(part decode diagnostics),
          AC6; C1, C5(part), C6; R1(part), R5(part)
```

Primary files: `src/qrspi/stage-runtime.ts`, `src/store/migrations.ts`,
`src/qrspi/store.ts`, `test/store/migrations.test.ts`, and the new
`test/qrspi/store.test.ts`.

### Child 2: Extend Persistence to Implementation Aggregates

Add the implementation tag, ordered steps, commit and checkpoint references, step-level
operation ownership, strict aggregate reload, and direct-SQL corruption tests. This
completes both tagged variants against the schema created by Child 1 while all runtime
claims remain disabled.

```text
provisionalChangedLines: { low: 550, likely: 800, high: 1100 }
dependsOn: Child 1
coverage: AC1(part), AC2(part tagged and ordered constraints), AC4(part decode diagnostics),
          AC6; C1, C6; R1(part)
```

Primary files: `src/qrspi/stage-runtime.ts`, `src/qrspi/store.ts`,
`test/store/migrations.test.ts`, and `test/qrspi/store.test.ts`.

### Child 3: Fence Runtime Transitions

Add the reusable compare-and-set boundary for run/revision lifecycle changes, pointer
movement, reference insertion, operation ownership, and implementation-step position.
Test every authority dimension independently against unchanged before-state and injected
rollback. Do not add replacement policy, bootstrap, or quarantine yet.

```text
provisionalChangedLines: { low: 700, likely: 1000, high: 1350 }
dependsOn: Child 2
coverage: AC2(part valid tagged transitions), AC3(core), AC6; C2, C6; R2(core)
```

Primary files: `src/qrspi/stage-runtime.ts`, `src/qrspi/store.ts`, and
`test/qrspi/store.test.ts`.

### Child 4: Replace Stage Revisions Monotonically

Build revision replacement on Child 3's fence: allocate the next stage revision, retain
prior and terminal rows, clear only expected pointers, retire allowed nonterminal work,
install exact new ownership, and keep replacement distinct from WorkflowOperation retry.
Verify document and implementation replacement, stale accepted pointers, rollback, and
history reload.

```text
provisionalChangedLines: { low: 400, likely: 600, high: 850 }
dependsOn: Child 3
coverage: AC2(part one-current and monotonic replacement), AC3(part replacement fencing),
          AC6; C2, C3, C6; R2(part)
```

Primary files: `src/qrspi/stage-runtime.ts`, `src/qrspi/store.ts`, and
`test/qrspi/store.test.ts`.

### Child 5: Bootstrap and Claim One Fresh Generation

Add the exact idempotent `stage_snapshots_v1` to `stage_runtime_v1` transaction,
placeholder supersession, higher non-retry operation revisions, runtime ownership and
pointers, format-aware preflight, and exact runtime claim/read. Prove unclaimable
placeholders, complete commit, duplicate convergence, mismatch rejection, rollback,
first claim, and replay through a fresh store.

```text
provisionalChangedLines: { low: 700, likely: 1000, high: 1400 }
dependsOn: Child 3; Child 2; may proceed independently of Child 4 after Child 3
coverage: AC2(part current runtime ownership), AC3(bootstrap fences), AC5(part pre/post
          bootstrap restart), AC6; C2, C3(part operation history), C5, C6; R2(part), R3, R5(part)
```

Primary files: `src/qrspi/stage-runtime.ts`, `src/qrspi/store.ts`,
`test/qrspi/store.test.ts`, `test/qrspi/workflow-start.test.ts`, and
`test/qrspi/stage-replay.test.ts`.

### Child 6: Quarantine Corrupt Runtime Aggregates

Add guarded aggregate quarantine and its bounded durable diagnostic. Abandon only a
corrupt mutable nonterminal revision, terminate its run as `data_error`, clear current
authority, dispose safe child work, retain uncertain effects and custody, preserve
terminal history, release no successor, and make identical containment idempotent.
Verify the complete corruption matrix, stale rollback, routing boundaries, and reopen.

```text
provisionalChangedLines: { low: 700, likely: 1050, high: 1450 }
dependsOn: Child 3; Child 2; may proceed independently of Children 4 and 5 after Child 3
coverage: AC2(part terminal/current constraints), AC3(quarantine fences), AC4(core),
          AC5(part quarantine restart), AC6; C2, C3, C4, C6; R1(part), R2(part), R4
```

Primary files: `src/qrspi/stage-runtime.ts`, `src/qrspi/store.ts`,
`test/qrspi/store.test.ts`, and `test/qrspi/stage-replay.test.ts`.

### Child 7: Prove File-Backed Upgrade and Restart

Complete format-specific read/preflight diagnostics and the deterministic prior-frontier
runner. Build file-backed fixtures for shipped legacy rows, pre-bootstrap state,
claimable runtime with lease/intent/observation, replacement history, every required
record family, and quarantined state. Reopen each through a fresh Effect layer and prove
unchanged legacy facts, exact authority recovery, no duplicate history, and fail-closed
claims.

```text
provisionalChangedLines: { low: 500, likely: 750, high: 1100 }
dependsOn: Children 1-6
coverage: AC1(complete), AC2(integrated local proof), AC3(integrated local proof),
          AC4(reopen proof), AC5(complete), AC6; C1-C6; R1-R5
```

Primary files: `src/store/migrations.ts`, `src/qrspi/store.ts`,
`test/store/migrations.test.ts`, `test/qrspi/store.test.ts`,
`test/qrspi/workflow-start.test.ts`, and `test/qrspi/stage-replay.test.ts`.

### Coverage and Allocation Accounting

| Parent obligation | Implementing children | Terminal proof owner |
| --- | --- | --- |
| `AC1`: every required record, append-only legacy preservation | 1, 2, 7 | 7 |
| `AC2`: currentness, history, monotonic replacement, tagged transitions | 1-4, 6 | 7 |
| `AC3`: Generation, operation, lease, and pointer fencing | 3-6 | 7 |
| `AC4`: exact diagnostics and quarantine | 1, 2, 6 | 6, reopened by 7 |
| `AC5`: recover leases, pointers, diagnostics, uncertain intent | 5-7 | 7 |
| `AC6`: no owner lifecycle, status, or capacity state | 1-7 | 7 final exclusion review |
| `C1`: exact durable shape | 1, 2 | 7 |
| `C2`: atomic all-dimension fencing | 3-6 | 7 |
| `C3`: immutable monotonic history | 4-6 | 7 |
| `C4`: corruption containment | 6 | 6, reopened by 7 |
| `C5`: format/ownership claim fence | 1, 5, 7 | 7 |
| `C6`: capability exclusions | 1-7 | 7 |
| `R1`: malformed authority | 1, 2, 6 | 7 |
| `R2`: stale advancement | 3-6 | 7 |
| `R3`: partial bootstrap | 5 | 5, reopened by 7 |
| `R4`: uncertain-effect or terminal-history loss | 6 | 6, reopened by 7 |
| `R5`: legacy/partial-format exposure | 1, 5, 7 | 7 |

Shared schema names, fixture builders, and aggregate constructors are not separate work.
Child 1 owns the full append-only table layout and the initial shared Schema vocabulary;
Child 2 extends typed behavior over that accepted layout. Child 3 owns reusable authority
inputs, stale errors, transaction helpers, and the base stale matrix. Children 4-6 add
only protocol-specific predicates and fixtures. Child 7 owns prior-frontier and reopen
fixtures and may extract shared test helpers only when reuse is demonstrated.

The provisional child ranges total 4,200 low, 6,100 likely, and 8,450 high. The parent
range is 240/200/200 lines higher to account for integration edits, conflict resolution,
and unallocated cross-child verification without counting shared helpers twice. No
acceptance criterion, control, risk, test family, migration, configuration change, or
required documentation remains unallocated. Children 3, 5, 6, and 7 still cross the
1,000-line target at their high estimate and therefore require recursive scope review
before Plan; this decomposition must not be treated as implementation-ready leaf
approval.
