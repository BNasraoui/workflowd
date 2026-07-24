# Impact and Risk Review

## Subject

| Field | Identity |
| --- | --- |
| Ticket | `workflowd-vs3.4.3`, live Beads record updated `2026-07-24T12:57:06Z` |
| Design | `03-design-discussion-stage-runtime-state.md`, revision 2, SHA-256 `665887ff21f56b79a8fc28b6c3328175b02e2c21932542e4f49653b108e53cf2` |
| Ownership report | `03-design-boundary-review-r2.md`, matching Design revision 2, SHA-256 `0dd615983a4fab14850ec1e1cae3d4dea7ce9d662be28bcb19da2f5ecccdea9d`; entry verdict `ScopeClean` |
| Review binding | Separate envelope `03-design-acceptance-binding-r2.json`, contract version 1; binds the ownership-report path and SHA-256 above to Design revision 2 and its SHA-256 |
| Source set | Binding source-set SHA-256 `7a7eea7fceb21095ede2114cfba5ad664922fb2b7e19a9af64e06bfc2585836e`; Questions SHA-256 `0230c0957a44461749e9cd57598d1805601f337dc807fbaeec8de267a7e2e0dd`; Research SHA-256 `d3bd713578742ccdce8de5a7bf3d00cbc92af88a24db04ae69219a07abde4f98`; repository base `50be40c936c696c4030bd2a2cbb6c9a0bdc8f375` |
| Workflow Generation | 1 |
| Policy revision | `local.impact-risk@1`, SHA-256 `fca8e7391d1a244f5121053474e5dae18ed89faad34cf8ac325ee764e888391b` |

## Verdict

`ReviseDesign`

## Human Summary

The Design leaves the runtime bootstrap internally inconsistent: WorkflowStart remains responsible for creating a ready legacy-shaped `StageProduce` operation, while later initialization requires an already new-format Generation and never defines the guarded conversion or disposal of that operation. It also requires a corrupt mutable StageRevision to enter `data_error` while declaring that StageRevision states remain exactly the normative set, which has no `data_error` state. Revise these two decisions, then issue a new binding and repeat ownership and impact review for the new Design revision.

## Source Inventory

| Source | Status | Revision and completeness | Relevance |
| --- | --- | --- | --- |
| Current ticket | Examined | Live `bd show workflowd-vs3.4.3 --json`; updated `2026-07-24T12:57:06Z`; complete description, Design, acceptance criteria, notes, status, dependencies, and authority examined | Defines current-ticket outcomes, exclusions, and acceptance obligations. |
| Complete issue graph | Examined | Live `bd dep tree workflowd-vs3.4.3 --direction=both` plus complete live JSON for parent and children `workflowd-vs3.4.1` through `.12`; dependency direction, status, scope, Design, acceptance criteria, and notes examined | Establishes sequencing and explicit neighboring owners without reusing ownership-report conclusions. |
| Accepted Questions | Examined | `01-research-questions-stage-runtime-state.md`, complete, SHA-256 `0230c0957a44461749e9cd57598d1805601f337dc807fbaeec8de267a7e2e0dd`; `.qrispi-state` records `accepted` | Defines the accepted research coverage. |
| Accepted Research | Examined | `02-research-stage-runtime-state.md`, status `complete`, commit `50be40c936c696c4030bd2a2cbb6c9a0bdc8f375`, SHA-256 `d3bd713578742ccdce8de5a7bf3d00cbc92af88a24db04ae69219a07abde4f98`; `.qrispi-state` records `accepted`; Open Questions is `None` | Supplies current code, test, migration, recovery, and identity evidence. |
| Exact Design | Examined | Revision 2, complete, SHA-256 `665887ff21f56b79a8fc28b6c3328175b02e2c21932542e4f49653b108e53cf2`; digest independently verified | Review subject and source-order decisions. |
| Matching ownership report | Examined | Bound path and SHA-256 independently verified; only identity and entry verdict `ScopeClean` consumed | Satisfies the entry condition; no ownership conclusion was used as impact evidence. |
| Authoritative review binding | Examined | `03-design-acceptance-binding-r2.json`, contract version 1, complete; exact Design, report, source-set, Generation, repository base, and policy identities present | Authoritatively resolves the exact review subject. |
| `docs/qrspi-contract.md` | Examined | Complete repository file, SHA-256 `55470a92b645ccfcea8f694ec43ae64b6dd9f6f7615664539e05756b4edcfc7d`; WorkflowOperation and StageRun/StageRevision sections at lines 298-446 and 596-708 examined | Normative operation, fencing, parent-effect, run, revision, and state rules. |
| `docs/qrspi-stage-runtime-design.md` | Examined | Complete repository file, SHA-256 `149ec8c3423f978bcb7d2e1eab202c431396e5e1c6ef6f6dd9dcb58b18dd532b`; lines 244-333 examined | Normative identities, records, exact state-set requirement, and Generation cursor shape. |
| Current affected source | Examined | Repository base named by binding; `src/store/migrations.ts:385-640`, `src/qrspi/store.ts:193-1510`, `src/qrspi/workflow-start.ts`, `src/qrspi/domain.ts`, `src/qrspi/contracts/common.ts`, `src/qrspi/stage-catalog.ts`, `src/layers.ts`, `src/runtime.ts`, `src/main.ts`, and `src/http.ts` examined directly or through accepted Research with cited locations | Establishes the current storage, input shape, transaction, startup, supervision, ingress, and diagnostic boundaries. |
| Current affected tests | Examined | `test/qrspi/workflow-start.test.ts`, `test/qrspi/stage-replay.test.ts`, `test/qrspi/contracts.test.ts`, `test/qrspi/source-assembly.test.ts`, `test/store/migrations.test.ts`, and `test/deploy.test.ts`; relevant current assertions and accepted Research references examined | Proves current malformed seeded input, ready state, format marker, real-SQLite patterns, rollback, restart, and deployment assumptions. |
| Deployment and operating model | Examined | `deploy/systemd/workflowd.service`, `deploy/workflowd.env.example`, `src/main.ts`, `src/layers.ts`, and `src/runtime.ts`; complete current repository definitions | Single Bun process under systemd, file-backed SQLite, supervised polling workers, startup migrations, and restart-on-failure shape the exposure and recovery boundaries. |
| Current observability and operational evidence | Unavailable | Repository logging, HTTP health response, typed diagnostics, and durable error fields examined; no runtime log sample, metric stream, alert rule, dashboard, incident record, or operator query snapshot was supplied or found as authoritative current evidence | Limits claims about production detection latency and occurrence frequency; unavailable evidence was not treated as no impact. |
| Provenance graph snapshot | Unavailable | No authoritative snapshot was supplied; none was inferred | Not needed to establish R1 or R2 and not fabricated. |

## Design Decision Inventory

| ID | Source decision | Decision | Intended outcome | Design evidence |
| --- | --- | --- | --- | --- |
| D1 | Desired End State; architecture layers 1-3; resolved record division | Add strict StageRun, common StageRevision, one-to-one document/implementation payloads, ordered steps, and immutable reference records. | Persist each tagged runtime shape without nullable false combinations and retain exact history. | Design lines 23-26, 61-72, 77-83, 122-126. |
| D2 | Pointer ownership | Keep only the current stage/run cursor and Git head on Generation; keep pending, published, and accepted revision pointers on StageRun, with monotonic stage revisions across runs. | Separate workflow position from per-stage revision authority and avoid latest-row inference. | Design lines 24-25, 62-63, 79-80, 128-132. |
| D3 | Shared operation and neighboring identity seams | Keep one WorkflowOperation lifecycle; bind document revisions or implementation steps to physical producer/publication operations and persist only immutable reference and identity hooks needed by later owners. | Reuse lease/retry/external-effect history without taking over producer, publisher, reconciliation, or handoff lifecycles. | Design lines 26, 67-72, 81, 134-138, 170-174. |
| D4 | Invariant placement | Use strict SQLite constraints for local shape and Effect Schema, hashes, identity checks, and transaction-scoped compare-and-set for semantic and cross-row invariants; do not use progression triggers. | Make malformed shape unrepresentable locally and return typed semantic failures at store boundaries. | Design lines 82-83, 140-144, 186-233. |
| D5 | Initialization and WorkflowStart boundary | Expose a D7-invoked guarded initialization primitive, require an expected current new-format Generation, and leave WorkflowStart's existing Generation replacement and legacy operation seeding behavior unchanged. | Keep run selection/progression out of D3 while allowing a later runner to install the first runtime records atomically. | Design lines 23-24, 75, 85-99. |
| D6 | State-changing transition fencing | Recheck Generation/format, run, pointers, revision/tag/source/step, operation revision, lease, and external authority in one transaction; return typed stale on zero rows without weaker retry. | Prevent stale workers and observations from advancing current state. | Design lines 27, 100-114, 146-150, 235-252. |
| D7 | Revision replacement | Allocate the next stage revision monotonically, retain history, retire nonterminal work, clear expected stale pointers, insert exact relationships, and install the new pending pointer atomically. | Recover from failed revisions without reopening terminal history or conflating operation retry with stage replacement. | Design lines 152-156, 213-233. |
| D8 | Corruption handling | Strictly decode and identity/hash-check durable rows; quarantine identifiable corrupt mutable operations or revisions as `data_error`, clear authority, retain exact diagnostics, and block corrupt immutable authority without guessed repair. | Fail closed while preserving evidence and preventing corrupt data from advancing work. | Design lines 28, 158-162, 254-284. |
| D9 | Migration, format, and restart | Add append-only migrations, preserve old rows without inference, fail closed on old work through a persisted format/currentness fence, and reload all new-format authority after restart; D11 owns offline legacy disposition. | Upgrade safely without inventing historical facts and recover current work after process restart. | Design lines 29, 164-168, 186-212, 303-317. |
| D10 | Capability exclusions | Exclude stage-specific workers, progression policy, producer/publisher/review/gate/Provenance/reconciliation/handoff lifecycles, readiness/capacity state, inferred legacy conversion, terminal reopening, and mutable-path/latest-row authority. | Keep D3 boundary-clean and prevent authority from leaking into the durable-state capability. | Design lines 31-39, 170-174. |
| D11 | Verification boundary | Verify Schemas and store transitions with real SQLite, migration metadata/constraints, stale dimensions, rollback, quarantine, history, file-backed upgrades, and restart recovery. | Produce deterministic evidence at the lowest boundary that can prove storage and transition claims. | Design lines 176-180, 303-317. |

## Affected Surface Trace

| Decision | Surface | Disposition | Evidence |
| --- | --- | --- | --- |
| D1 | Code | Adds tagged domain Schemas, store records, decoders, and persistence methods. | Ticket Scope; Design lines 23-26 and 77-83; current port ends at WorkflowStart methods in `src/qrspi/store.ts:193-286`. |
| D1 | Data | Adds StageRun, common/payload revision, step, and immutable-reference rows with historical identities. | Design lines 79-81; normative records at `docs/qrspi-stage-runtime-design.md:271-298`. |
| D1 | Configuration | NoMaterialImpact: record shape is fixed by the closed six-stage contract and does not add a configurable store or stage kind. | Design lines 31-33; parent ticket fixes the six built-ins; current definitions remain server-owned. |
| D1 | Interfaces | Expands QrspiStore and domain interfaces with tagged record reads/writes and exact identities. | Ticket Scope; Design lines 23 and 80-83. |
| D1 | ExternalEffects | NoMaterialImpact: these records describe durable state and immutable references; D3 performs no producer or publication effect. | Design lines 33-35 and 75. |
| D1 | Operations | Increases migration, integrity-check, backup, and recovery surface in the file-backed SQLite database. | `src/main.ts:15-24`; `src/qrspi/store.ts:1504-1510`; Design lines 176-180. |
| D1 | Users | Indirectly determines whether maintainers see exact retained history or ambiguous stage state. | Ticket acceptance criteria 1-5; normative StageRun pointers at `docs/qrspi-contract.md:617-624`. |
| D1 | NeighboringTickets | Supplies required persisted identities to D4-D9 and D11-D12. | Live issue graph scopes for `workflowd-vs3.4.4` through `.12`. |
| D2 | Code | Adds guarded cursor and pointer reads/writes and same-run composite checks. | Design lines 128-132; current Generation has only Git/state fields at `src/store/migrations.ts:502-526`. |
| D2 | Data | Moves revision authority to StageRun while retaining only linear current-stage/run position on Generation. | Design lines 24 and 79-80. |
| D2 | Configuration | NoMaterialImpact: pointer ownership is a fixed invariant, not an operator option. | Rejected alternatives in Design lines 131-132. |
| D2 | Interfaces | Every progression caller must carry expected pointer values rather than query newest rows. | Design lines 100-113 and 128-132. |
| D2 | ExternalEffects | NoMaterialImpact: pointer movement authorizes later effects but D2 itself performs none. | Design lines 24 and 34-35. |
| D2 | Operations | Restart and support queries must restore and inspect the exact cursor/pointer set. | Design lines 29 and 164-168. |
| D2 | Users | Prevents stale or merely published work from being treated as accepted user-visible progress. | `docs/qrspi-contract.md:617-624`, `700-708`. |
| D2 | NeighboringTickets | D7 owns the policy and event that move these pointers; D9 consumes the exact accepted Design pointer. | Live `workflowd-vs3.4.7` and `.9` scopes. |
| D3 | Code | Adds relational operation ownership and immutable-reference/identity insertion seams to the shared store. | Design lines 26, 81, 134-138, 170-174. |
| D3 | Data | Creates unique revision/step-to-operation and immutable-reference associations. | Design lines 67-71 and 80-81. |
| D3 | Configuration | NoMaterialImpact: no new worker, queue, adapter, or owner endpoint is configured by D3. | Design lines 31-36. |
| D3 | Interfaces | Later producer, publisher, reconciliation, and handoff code receives exact IDs rather than mutable-path discovery. | Design lines 81 and 170-174. |
| D3 | ExternalEffects | NoMaterialImpact: operation/reference relationships are persisted, but external execution and publication remain excluded. | Design lines 33-35. |
| D3 | Operations | Makes stalled or conflicting physical operations traceable to one revision or step. | Ticket requires diagnostics and shared relationships; `workflow_operations` retains physical history at `src/store/migrations.ts:423-487`. |
| D3 | Users | Indirectly protects trust in artifact/commit/checkpoint identity; no direct UI is added. | Design lines 35-36 and immutable-reference outcome at lines 25-26. |
| D3 | NeighboringTickets | D4/D5/D6/D7/D8 consume the seams and own their lifecycles. | Live issue graph scopes for `workflowd-vs3.4.4` through `.8`. |
| D4 | Code | Splits local SQL constraints from semantic Schema/hash/transaction checks. | Design lines 82-83 and 140-144. |
| D4 | Data | Enforces keys, checks, foreign keys, positive ordinals, state literals, and partial uniqueness. | Existing pattern in `src/store/migrations.ts:423-530`, `575-608`. |
| D4 | Configuration | NoMaterialImpact: foreign keys and busy timeout are store initialization rules, not mutable feature configuration. | `src/qrspi/store.ts:1504-1510`. |
| D4 | Interfaces | Store methods return typed decode/currentness outcomes instead of exposing raw rows. | `src/qrspi/store.ts:290-339`; Design lines 140-150. |
| D4 | ExternalEffects | NoMaterialImpact: invariant enforcement remains inside SQLite/store boundaries. | Design line 83. |
| D4 | Operations | Corrupt rows can block startup/preflight and produce exact diagnostics rather than silent drift. | `src/layers.ts:142-150`; Research lines 203-227. |
| D4 | Users | Converts malformed authority into explicit failure rather than incorrect progression. | Ticket AC4; Design lines 158-162. |
| D4 | NeighboringTickets | D10 must compose the store and preserve local fail-closed startup; D12 supplies integrated evidence. | Live `.10` and `.12` scopes. |
| D5 | Code | Requires a new initialization transaction while retaining current WorkflowStart completion code that seeds child operations. | Design lines 85-99; current seeding at `src/qrspi/store.ts:1338-1377`. |
| D5 | Data | Must bridge a Generation and two pre-existing legacy-shaped operations into the new StageRun/Revision model, but no format transition or operation disposition is defined. | Design lines 88-95 and 98; `test/qrspi/workflow-start.test.ts:442-450`, `1650-1681`. |
| D5 | Configuration | NoMaterialImpact: initialization is a store protocol and D7 policy, not a runtime option. | Design lines 75 and 85. |
| D5 | Interfaces | Initialization requires an already new-format Generation and exact operation identities although WorkflowStart creates no exact StageProduce input. | Design lines 88-93; current test proves the seeded input fails `StageProduceInput` decoding at `test/qrspi/workflow-start.test.ts:448-450`. |
| D5 | ExternalEffects | NoMaterialImpact before claim: initialization is intended to be purely transactional. | Design lines 87-96. |
| D5 | Operations | R1: literal sequencing either strands each new Generation behind the format fence or leaves a malformed ready operation exposed to a future worker. | Current operation is `ready` at `test/qrspi/workflow-start.test.ts:1671-1674`; current Generation format is `stage_snapshots_v1` at lines 1650-1651. |
| D5 | Users | R1 can prevent the first stage from starting or surface a `data_error` immediately after accepted kickoff. | `src/qrspi/store.ts:547-597` rejects/quarantines malformed StageProduce inputs. |
| D5 | NeighboringTickets | D7 is asked to invoke initialization and D10 to run the generic worker, but neither issue can infer the missing format/operation transition safely. | Live `.7` scope owns initialization; live `.10` scope owns worker composition; D3 owns the required seam. |
| D6 | Code | Adds complete compare-and-set predicates and typed stale mapping to every state-changing method. | Design lines 100-114 and 146-150. |
| D6 | Data | Makes pointer, operation revision, lease, and observation updates atomic with parent/child effects. | Design lines 107-113. |
| D6 | Configuration | NoMaterialImpact: fences are mandatory invariants, not tunable policy. | Ticket AC3 and Design line 148. |
| D6 | Interfaces | Callers must supply exact expected identities and handle typed stale outcomes. | Design lines 104-113 and 146-150. |
| D6 | ExternalEffects | Prevents stale observations from applying parent effects; external mutation itself remains with later capabilities. | `docs/qrspi-contract.md:417-430`; Design lines 109-113. |
| D6 | Operations | Bounds race effects and supports safe retry diagnosis after zero-row updates. | Existing pattern at `src/qrspi/store.ts:915-960`. |
| D6 | Users | Prevents replaced or lease-lost work from changing accepted workflow progress. | Ticket AC3; parent acceptance requires stale outcomes not advance. |
| D6 | NeighboringTickets | D4-D9 must call these guarded methods; D12 verifies cross-capability currentness. | Live issue graph. |
| D7 | Code | Adds one atomic monotonic replacement primitive distinct from operation retry. | Design lines 152-156. |
| D7 | Data | Retains old revision/operations, clears stale pointers, and installs one new pending revision. | Design lines 152-156; normative rule at `docs/qrspi-contract.md:695-708`. |
| D7 | Configuration | NoMaterialImpact: D7 chooses replacement policy, but the monotonic transition is fixed. | Design line 154. |
| D7 | Interfaces | Caller supplies the replacement event/direction; store supplies allocation and atomicity only. | Design lines 152-155. |
| D7 | ExternalEffects | Contains terminal publication failure by assigning any later publication a new logical identity; performs no Git mutation. | Design lines 154-156; `docs/qrspi-contract.md:385-391`. |
| D7 | Operations | Prevents replay ambiguity and preserves forensic history across retry/restart. | Ticket AC2 and AC5. |
| D7 | Users | Prevents a failed or superseded revision from appearing current or accepted. | Design lines 152-156. |
| D7 | NeighboringTickets | D7 owns when replacement is invoked; D5 supplies publication outcomes. | Live `.5` and `.7` scopes. |
| D8 | Code | Adds strict decoders, relational identity/hash checks, and quarantine/block paths. | Design lines 158-162 and 254-284. |
| D8 | Data | R2: the Design requires a corrupt mutable StageRevision to become `data_error`, but its exact normative state set omits that value. | Design lines 83 and 160; `docs/qrspi-contract.md:692-693`; `docs/qrspi-stage-runtime-design.md:330-333`. |
| D8 | Configuration | NoMaterialImpact: corruption disposition is mandatory and not operator-configurable. | Ticket AC4; Design lines 158-162. |
| D8 | Interfaces | Store callers receive exact typed diagnostics and must not guess repairs. | `src/qrspi/store.ts:290-339`; Design lines 158-162. |
| D8 | ExternalEffects | Clears lease/workspace authority and forbids successor effects, limiting corrupt work before external action. | Design lines 159-161. |
| D8 | Operations | R2 can make quarantine itself violate SQL/Schema state checks, leaving a corrupt revision/pointer or child operation repeatedly blocking work. | Exact-state requirement above; current operation quarantine only succeeds because `workflow_operations` includes `data_error` at `src/store/migrations.ts:444-467`. |
| D8 | Users | Corruption remains fail-closed, but the contradiction can turn an exact diagnostic into an unrecoverable stage stall. | Ticket AC4; Design lines 158-162. |
| D8 | NeighboringTickets | D7 may replace failed revisions, but its live scope does not authorize inventing a missing StageRevision corruption state or quarantine target. | Live `.7` scope; D3 owns the state model. |
| D9 | Code | Adds append-only migrations, format checks, restart loaders, and legacy-fail-closed reads. | Design lines 164-168 and 186-212. |
| D9 | Data | Preserves old rows byte-for-byte and adds only format/currentness/association data needed for safe discrimination. | Design lines 164-168 and 210-212. |
| D9 | Configuration | NoMaterialImpact: schema format is persisted per Generation, not selected from environment configuration. | Current `generation_format` is a column at `src/store/migrations.ts:610-617`. |
| D9 | Interfaces | New claimers must reject old format; restart reads must restore exact new-format authority. | Design lines 164-168. |
| D9 | ExternalEffects | NoMaterialImpact: migration and restart do not infer Git, session, publication, or checkpoint effects. | Design lines 166-168. |
| D9 | Operations | Requires offline D11 handling for dormant legacy rows and safe service restart over file-backed SQLite. | Live `.11` scope; systemd restarts on failure at `deploy/systemd/workflowd.service:17-21`. |
| D9 | Users | Existing workflows remain historical and blocked rather than silently converted; new-format work should resume. | Design lines 164-168. |
| D9 | NeighboringTickets | D11 owns classification/supersession/verification; D10 treats verified format as deployment prerequisite. | Live `.11` and `.10` scopes. |
| D10 | Code | Prevents new per-stage conditionals/workers/stores and neighboring lifecycle implementations. | Design lines 31-36. |
| D10 | Data | Forbids handoff, TargetReconcile, Provenance, readiness/capacity, and inferred legacy lifecycle records in D3 beyond narrow identity seams. | Design lines 35-38 and 170-174. |
| D10 | Configuration | NoMaterialImpact: D3 adds no new owner, worker, capacity, or status configuration. | Design lines 31-36. |
| D10 | Interfaces | Limits D3 to store records/primitives and exact hooks consumed by explicit owners. | Design lines 75 and 170-174. |
| D10 | ExternalEffects | NoMaterialImpact: producer, Git publication, owner delivery, reconciliation, and Provenance effects are expressly excluded. | Design lines 33-35. |
| D10 | Operations | Status/readiness remains outside D3, so durable diagnostics are available but current production alert latency is not established. | Design lines 35-36; current health endpoint reports only `ok` at `src/http.ts:26-28`. |
| D10 | Users | No direct status/UI behavior is added; failures surface through later owners or exact ingress/store errors. | Design lines 35-36; `src/http.ts:51-89`. |
| D10 | NeighboringTickets | Explicitly preserves D4-D12 lifecycle ownership and the related readiness work rather than duplicating it. | Live issue graph scopes and dependencies. |
| D11 | Code | Requires focused Schema/store/migration/restart tests against real SQLite. | Design lines 176-180. |
| D11 | Data | Tests inspect strictness, checks, foreign keys, indexes, rollback, retained history, and file reopen state. | Design lines 176-180 and 303-317. |
| D11 | Configuration | NoMaterialImpact: tests use deterministic fixtures rather than add production options. | Design lines 176-180. |
| D11 | Interfaces | Verification must exercise store contracts and typed stale/corruption outcomes, not mocks alone. | Design lines 176-180. |
| D11 | ExternalEffects | NoMaterialImpact: D3 tests do not claim producer, publisher, or offline-recovery behavior. | Design lines 176-180 and 317. |
| D11 | Operations | File-backed close/reopen and previous-frontier fixtures model migration and process restart boundaries. | Design lines 303-317; current patterns in Research lines 229-259. |
| D11 | Users | Gives maintainers checkable evidence that accepted history and current authority survive faults. | Ticket AC1-AC5. |
| D11 | NeighboringTickets | D12 retains integrated evidence; D3 retains capability-local verification. | Live `.12` scope. |

## Risk Register

| ID | Decisions | Surfaces | Evidence | Trigger | Failure mode | Consequence and materiality |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | D5, D6, D9 | Code, Data, Interfaces, Operations, Users, NeighboringTickets | Design lines 85-99 require initialization to start from an expected current new-format Generation while preserving WorkflowStart's legacy operation seeding. Current WorkflowStart creates `StageProduce` as `ready` (`src/qrspi/store.ts:1338-1377`; `test/qrspi/workflow-start.test.ts:1671-1674`), marks the Generation `stage_snapshots_v1` (`test/qrspi/workflow-start.test.ts:1650-1651`), and stores an input that intentionally fails the exact `StageProduceInput` Schema (`test/qrspi/workflow-start.test.ts:442-450`). | Any post-D3 WorkflowStart completes and D7/D10 attempts to initialize or claim its first stage. | The Design provides no atomic state/format transition that makes the Generation eligible for D7 initialization while keeping the malformed ready operation nonclaimable, nor a required disposition that replaces, supersedes, or safely binds that operation. Literal implementation either deadlocks behind the new-format precondition or exposes malformed work to claim/quarantine. | The first stage can fail to start for every new Generation or immediately enter data error; no later QRSPI capability can safely infer the missing authority. This violates atomic currentness, restart, and usable runtime outcomes and crosses D3/D7/D10 boundaries, so it can change Design acceptance and is material. |
| R2 | D4, D8 | Code, Data, Interfaces, Operations, Users | Design line 83 says SQL state literals and Schemas enforce local shape; line 160 requires a corrupt mutable revision to be quarantined as `data_error`; Design lines 164-166 and `docs/qrspi-stage-runtime-design.md:330-333` require exact normative states; `docs/qrspi-contract.md:692-693` lists StageRevision terminal states without `data_error`. | A mutable StageRevision has readable identity but malformed JSON, mismatched relational identity, or a hash mismatch. | The required quarantine transition has no valid StageRevision target state. Implementing `data_error` contradicts the exact state model; omitting it contradicts the quarantine requirement; redirecting it to StageRun or an operation is an unapproved change in quarantine scope and pointer/child effects. | Quarantine can fail or leave corrupt revision authority, pointers, or child operations in an indeterminate blocked state, defeating exact diagnostics and fail-closed recovery. The contradiction directly violates ticket AC4 and the core data model, so it is material. |

## Risk Characterization

| Risk | Current rating, exposure, uncertainty, and basis | Detectability and signal | Reversibility | Blast radius | Current controls | Required controls | Residual rating, assumptions, and uncertainty |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | `Significant (4) x AlmostCertain (5) = 20 / Critical` under `5x5-v1`; exposure is each new Generation after the stage runtime is enabled. Impact is significant because the first stage cannot safely become executable. Likelihood is almost certain because the current completion path deterministically creates the malformed ready input for every enabled first stage. Uncertainty `Medium`: D3/D7 implementation does not exist, but the Design forbids deriving the missing transition. | Current strict decoding produces `QrspiStoreDataError` and can persist operation `data_error`; observer is the invoking worker/ingress or a direct database operator, at claim/read time. No authoritative alert-latency evidence is available. | Operator recovery only; no designed ordinary transition repairs the bootstrap. D11 recovery applies to classified legacy work, not an unspecified fresh-Generation bootstrap. | One complete Generation and all of its configured stages; repeated for every newly started workflow after exposure. | C1 | C2 plus `Missing: define one atomic bootstrap protocol that assigns the pre-runtime format, disposes or replaces the seeded legacy operations, installs exact run/revision/operation ownership, and only then enables claiming`; `Missing: define idempotent recovery for a crash or stale result at that bootstrap boundary` | `Unknown` residual score. Assumptions: C1-C2 work as specified and the two missing Design dispositions are supplied. Impact remains `Significant`; likelihood is `Unknown` until the revised protocol defines and verifies the exposure. Uncertainty `High`. |
| R2 | Impact `Significant`; likelihood `Unknown`, so no matrix score. Exposure is each durable StageRevision read or transition after corruption. Impact is significant because the quarantine invariant can be unimplementable and block stage authority. No evidence establishes corruption frequency. Uncertainty `High` due unavailable operational occurrence evidence and the contradictory target state. | Schema/hash/identity decode failure is an exact signal to the store caller before progression; a durable diagnostic is intended. Observer ownership beyond the invoking process is not evidenced, and current `/health` does not distinguish QRSPI state. | Potential operator/database recovery only; the Design forbids guessed repair and gives no valid revision recovery transition after quarantine. | The exact revision and its run/pointers/child operations; successor stages remain blocked, while immutable history outside that run remains preserved. | None | C3, C4, C5, plus `Missing: define a valid quarantine state/record target and the exact atomic pointer, child-operation, lease, and workspace effects`; `Missing: assign the safe post-quarantine recovery or explicit terminal-stall disposition` | Impact `Significant`, likelihood `Unknown`, no score. Assumptions: C3-C5 and the missing Design dispositions are implemented. Uncertainty `High` until the state model and recovery are coherent. |

## Control Coverage

| Risk | Prevention | Detection | Containment | Recovery |
| --- | --- | --- | --- | --- |
| R1 | `Missing: exact bootstrap state/format and seeded-operation disposition before any claim` | C1 | C2, but incomplete until the bootstrap lifecycle is defined | `Missing: idempotent recovery for stranded or partially initialized fresh Generations` |
| R2 | C3 | C4 | C5, but its target state is contradictory | `Missing: safe revision/run disposition after corruption quarantine` |

## Control Ledger

| ID | Risks | Status | Kind | Obligation | Ownership class | Owner | Delivery phase | Verification target | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | R1 | Existing | Detection | Strictly decode a claimed StageProduce input and return an exact typed data error rather than execute malformed work. | CurrentTicket | `workflowd-vs3.4.3` store boundary | Implementation | V1: malformed legacy-shaped input is observed before execution | `src/qrspi/store.ts:547-597`; `test/qrspi/workflow-start.test.ts:448-450`. |
| C2 | R1 | Required | Containment | Require current Generation format, exact revision association, pointers, operation revision, and lease in every stage claim or state advance so uninitialized work cannot execute. | CurrentTicket | `workflowd-vs3.4.3` store boundary | Implementation | V1: no pre-initialization operation is claimable and stale initialization has zero effects | Design lines 100-114, 146-150, 164-168. |
| C3 | R2 | Required | Prevention | Decode each mutable operation/revision with excess rejection and verify relational identity plus canonical hashes before transition logic. | CurrentTicket | `workflowd-vs3.4.3` store boundary | Implementation | V2: every injected malformed/hash/identity case is rejected before parent or external effect | Design lines 158-162 and 254-284. |
| C4 | R2 | Required | Detection | Persist an exact bounded diagnostic tied to the readable corrupt record identity. | CurrentTicket | `workflowd-vs3.4.3` store boundary | Implementation | V2: diagnostic identifies record, reason, and expected/actual identity or hash where available | Ticket AC4; Design lines 158-162; current error shape at `src/qrspi/store.ts:290-339`. |
| C5 | R2 | Required | Containment | In the same transaction, remove the corrupt mutable work's lease/workspace authority, prevent success/successor effects, and place all affected pointers and child operations in a valid fail-closed disposition. The Design must first supply the valid StageRevision/run target state. | CurrentTicket | `workflowd-vs3.4.3` Design and store boundary | Design | V2: quarantine commits one valid terminal/blocked disposition with no remaining authority or successor effect | Design lines 158-162; contradiction with `docs/qrspi-contract.md:692-693`. |

## Verification Plan

| ID | Risks and controls | Claim and boundary | Method and rationale | Pass evidence | Owner and phase | Automation gap |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | R1; C1, C2 | From a real file-backed WorkflowStart completion through D7 initialization and the first worker claim, exactly one coherent runtime bootstrap exists; no legacy-shaped operation is claimable or quarantined, format/currentness changes are atomic, and stale/crash retries are idempotent. Boundary: store component integration with real SQLite and restart. | ComponentIntegration: this is the lowest boundary that includes WorkflowStart's persisted child operations, the new format/run/revision transaction, worker claim predicates, rollback, and file reopen. | Direct row evidence shows the defined pre-runtime format, one current StageRun/revision, exact decodable operation input and ownership, no orphan current legacy operation, and zero effects after injected rollback/stale attempts; reopening produces the same claimable identity. | `workflowd-vs3.4.3` with `workflowd-vs3.4.7` consumer contract; Design then Implementation/BeforeExposure | None; deterministic SQLite fault injection and reopen are established repository patterns. |
| V2 | R2; C3, C4, C5 | Every supported mutable operation and StageRevision corruption with readable identity is rejected before effect, produces one exact durable diagnostic, clears authority atomically, and leaves the run, pointers, and child operations in the revised valid disposition. Boundary: store component integration with real SQLite. | ComponentIntegration: Schema-only tests cannot prove the SQL state literal, pointer/child transaction, lease clearing, or rollback; a full system journey is unnecessary because no external effect should occur. | For malformed, excess, identity-mismatch, tag-mismatch, ordering, and hash-mismatch fixtures, SQL rows show the exact valid quarantine disposition and diagnostic, null lease/workspace authority, unchanged success/accepted pointers, no released successor, and complete rollback under injected transaction failure. | `workflowd-vs3.4.3`; Design then Implementation | None; deterministic row corruption and transaction-failure injection are established test techniques. |

## Residual Risk and Decisions

| Risk | Assumed controls | Residual rating and basis | Materiality | Decision status | Decision owner and evidence |
| --- | --- | --- | --- | --- | --- |
| R1 | C1, C2 and the two missing bootstrap/recovery dispositions | Impact `Significant`, likelihood `Unknown`, no score; the residual cannot be characterized until one atomic bootstrap and recovery sequence replaces the contradictory preconditions. | Material | NeedsDecision | Design revision owner for `workflowd-vs3.4.3`; current source/test evidence and Design lines 85-99 establish the contradiction. This is a required Design correction, not residual-risk acceptance. |
| R2 | C3, C4, C5 and the missing valid quarantine/recovery disposition | Impact `Significant`, likelihood `Unknown`, no score; residual depends on the revised state target and pointer/child effects. | Material | NeedsDecision | Design revision owner for `workflowd-vs3.4.3`; exact normative state evidence at `docs/qrspi-contract.md:692-693` conflicts with Design line 160. This is a required Design correction, not residual-risk acceptance. |

## Excluded Speculation

| Candidate | Why considered | Missing evidence link | Disposition |
| --- | --- | --- | --- |
| Aggregate SQLite capacity or performance loss from the new tables | The Design adds several historical tables and indexes. | No workload, row-volume, retention, latency objective, benchmark, or capacity incident connects the record count to an outcome loss; aggregate capacity is also expressly outside the ticket. | Excluded |
| Unauthorized disclosure through stored source/reference JSON | The Design persists source sets, diagnostics, and immutable references. | No evidence shows secret-bearing fields, a new read interface, changed database permissions, or an unauthorized consumer. Existing systemd `UMask=0077` is positive local evidence, but no confidentiality failure chain is established. | Excluded |
| Production alerts will miss every quarantined revision | Current health is shallow and no alert evidence was available. | No authoritative deployment monitoring contract or incident evidence establishes that operators rely solely on `/health`, nor is status/readiness owned by this ticket. The missing evidence limits detection claims but does not prove universal alert failure. | Excluded |

## Human Risk Decision

None.
