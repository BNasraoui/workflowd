# Accepted Structure input package: workflowd-vs3.4 configurable QRSPI stages

This fixture is the accepted Structure input package for the real `workflowd-vs3.4`
ticket, reduced to the records, edges, and repository facts a Structure producer needs.
It reproduces the accepted package that four independent producers used in the recorded
determinism experiment. Every graph ID, hash, and repository fact below is exact. Produce
the Structure artifact from this fixture alone; do not read the current repository, and do
not look for the recorded experiment reports.

## Binding

| Field                            | Value                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- |
| WorkflowId                       | `BNasraoui/workflowd:workflowd-vs3.4`                                       |
| Generation                       | `1`                                                                         |
| Accepted Design revision         | `4`                                                                         |
| DesignAcceptancePackage sha256   | `bac9e02e7016aa3135b5cd0913003b6fe10d2ed8ece8f9c39a695e6e3d13da43`           |
| GateResponse sha256              | `8b1c1716b4fdb20adfb5d6f574a552b8371c9bb4229ea380ef4553a895987ea3`           |
| Promotion request                | revision `2`, `05ae3095720d80c5e8c0ffb637faae94a842dac77678bcd50dc81100768354a7` |
| Promotion result                 | `24992360d99435017746cb55d661817e3b8d0ea27c4c1b0a1ede734ef3f3dfe5`           |
| Structure policy                 | `workflowd.structure@1`, `d360ea62f9b7e1847c0da5b630af93fd28f98fb7f58e88d7b5f026be5922b85d` |
| Accepted implementation baseline | commit `42e129ab75ea0de39aa1bd6db4502325cd3effb1`                            |
| Approving human                  | Ben Nasraoui                                                                |

**Deviation.** The immutable Provenance graph snapshot and version identity are
unavailable for this package. Ben Nasraoui manually authorized Structure projection from
the content-addressed graph export whose verified byte SHA-256 is
`f8bd728183d02da4b79db6448cf8dbd3403a0e79e2bf39008d1d20efd4133977`. The authorization
binds the artifact to that exact export. It relaxes no semantic coverage, ownership,
authority, or routing obligation.

## Accepted graph records

### Informational and authority sources

| Logical ID | Exact graph ID | Name |
| --- | --- | --- |
| SRC-binding | `wvs34-d4-bac9e02e-src-binding` | Design acceptance binding revision 4 |
| SRC-design | `wvs34-d4-bac9e02e-src-design` | Accepted Design revision 4 |
| SRC-gate | `wvs34-d4-bac9e02e-src-gate` | Human approval gate response revision 4 |
| SRC-impact | `wvs34-d4-bac9e02e-src-impact` | NeedsRiskDecision impact report |
| SRC-ownership | `wvs34-d4-bac9e02e-src-ownership` | ScopeClean ownership report |
| SRC-package | `wvs34-d4-bac9e02e-src-package` | Design acceptance package revision 4 |
| SRC-questions | `wvs34-d4-bac9e02e-src-questions` | Accepted Questions |
| SRC-research | `wvs34-d4-bac9e02e-src-research` | Accepted Research |
| SRC-synthesis | `wvs34-d4-bac9e02e-src-synthesis` | Design acceptance synthesis revision 4 |
| SRC-ticket | `wvs34-d4-bac9e02e-src-ticket` | workflowd-vs3.4 product authority |

### Accepted requirements

| Logical ID | Exact graph ID | Statement |
| --- | --- | --- |
| AC1 | `wvs34-d4-bac9e02e-req-ac1` | Validate the server-owned ordered WorkflowDefinition and every StageDefinition, contract reference, harness reference, policy, and hash before use. |
| AC2 | `wvs34-d4-bac9e02e-req-ac2` | Register Questions, Research, Design, Structure, Plan, and Implementation in deterministic order; an explicitly disabled stage creates no run. |
| AC3 | `wvs34-d4-bac9e02e-req-ac3` | Permit a built-in stage to be added through a contract and registration only, without a per-stage queue, worker, store family, Context tag, or central stage switch. |
| AC4 | `wvs34-d4-bac9e02e-req-ac4` | Use stable semantic type names and represent versions only as data. |
| AC5 | `wvs34-d4-bac9e02e-req-ac5` | Reject unknown, duplicate, unavailable, or incompatible versions before claim and retain versions referenced by active work across restart. |
| AC6 | `wvs34-d4-bac9e02e-req-ac6` | Provide bounded Schema-decoded exact accepted source input while preserving ticket authority and technical-artifact precedence. |
| AC7 | `wvs34-d4-bac9e02e-req-ac7` | Execute through the selected AgentHarness without giving the harness authority to advance StageRun or publish Git state. |
| AC8 | `wvs34-d4-bac9e02e-req-ac8` | Publish signed exact-parent document artifacts with exact-old branch updates and authoritative duplicate or uncertain-effect recovery. |
| AC9 | `wvs34-d4-bac9e02e-req-ac9` | Release successors from accepted revisions only and prevent stale Generation, revision, session, review, handoff, publication, promotion, or reentry outcomes from advancing work. |
| AC10 | `wvs34-d4-bac9e02e-req-ac10` | Create or update no pull request during QRSPI stage work. |
| AC11 | `wvs34-d4-bac9e02e-req-ac11` | Prove registration, extension, skip, success, retry, restart, stale Generation, version recovery, uncertain publication, document revision, and implementation checkpoint handoff behavior. |

### Accepted decisions

| Logical ID | Exact graph ID | Title | Accepted position |
| --- | --- | --- | --- |
| D1 | `wvs34-d4-bac9e02e-res-d1` | Trusted definitions and catalog | Use server-owned hashed definitions, trusted versioned contracts and harnesses, one validator, and one erased catalog seam. |
| D2 | `wvs34-d4-bac9e02e-res-d2` | Six exact typed stage contracts | Use six distinct typed contracts with bounded immutable authority-ordered source sets and persisted exact request hashes. |
| D3 | `wvs34-d4-bac9e02e-res-d3` | Durable tagged runtime model | Use strict tagged records and one generic operation lifecycle for leases, state, revision pointers, diagnostics, currentness, and restart. |
| D4 | `wvs34-d4-bac9e02e-res-d4` | Linear production and custody handoff | Use linear initialization, session checkpoints, attempt workspaces, result validation, atomic custody transfer, and cleanup fencing. |
| D5 | `wvs34-d4-bac9e02e-res-d5` | Exact artifact publication | Verify exact scope, tree, and content; create one signed sole-parent commit; persist intent; update exact-old fast-forward-only; observe authoritatively. |
| D6 | `wvs34-d4-bac9e02e-res-d6` | Publication-scoped reconciliation | Route publication conflicts, stale effects, rollback, and ambiguous observations to one durable read-only reconciliation with exact typed resolutions. |
| D7 | `wvs34-d4-bac9e02e-res-d7` | Accepted-only progression | Use accepted-only linear progression, distinct document and implementation shapes, observed contiguous commits, monotonic replacement revisions, and no stage pull request. |
| D8 | `wvs34-d4-bac9e02e-res-d8` | Mandatory owner handoffs | Validate required owner capabilities before exposure and persist exact idempotent local receipts that recover on the same identity. |
| D9 | `wvs34-d4-bac9e02e-res-d9` | Exact Design owner effects | Apply only exact typed owner results; require confirmed Provenance result and snapshot before Structure; accept reentry selection only from workflowd-vs3.14. |
| D10 | `wvs34-d4-bac9e02e-res-d10` | Single runtime composition | Add one catalog, store, service, publisher, and loop; fail only QRSPI closed; retain local diagnostics without a status or readiness product. |
| D11 | `wvs34-d4-bac9e02e-res-d11` | Legacy migration and offline recovery | Preserve legacy rows, never infer facts, and require preflight manifest, verified backup, append-only apply or rollback, exact offline supersession, verification, then ordinary successor kickoff. |
| D12 | `wvs34-d4-bac9e02e-res-d12` | Lowest-boundary behavioral verification | Use real SQLite and Git plus fault injection to prove reconciliation, diagnostics, owner availability and recovery, upgrade recovery, and the full stage matrix. |
| D13 | `wvs34-d4-bac9e02e-res-d13` | No aggregate capacity subsystem | Retain v1 audit records and nonterminal custody with individual bounds, but add no aggregate capacity policy, status, recovery, deletion, or invented owner. |

### Accepted ownership assignments

| Logical ID | Exact graph ID | Title | Accepted position |
| --- | --- | --- | --- |
| O1 | `wvs34-d4-bac9e02e-res-o1` | workflowd-vs3.1 ownership boundary | workflowd-vs3.1 supplies the merged normative contract and owns no implementation lifecycle. |
| O2 | `wvs34-d4-bac9e02e-res-o2` | workflowd-vs3.2 ownership boundary | workflowd-vs3.2 supplies reusable trusted harness and session mechanics, not StageRun, catalog, or publication ownership. |
| O3 | `wvs34-d4-bac9e02e-res-o3` | workflowd-vs3.3 ownership boundary | workflowd-vs3.3 owns ticket ingress, branch establishment, WorkflowStart, Generation kickoff, and ordinary successor kickoff. |
| O4 | `wvs34-d4-bac9e02e-res-o4` | workflowd-vs3.4 ownership boundary | workflowd-vs3.4 owns the catalog-aware linear runtime, StageRun and revisions, publication and reconciliation, local handoffs, Design state effects, deterministic promotion request, and next-stage release. |
| O5 | `wvs34-d4-bac9e02e-res-o5` | workflowd-vs3.5 ownership boundary | workflowd-vs3.5 owns review contributions, Design ownership and impact review, synthesis, budgets, and revision verdicts. |
| O6 | `wvs34-d4-bac9e02e-res-o6` | workflowd-vs3.6 ownership boundary | workflowd-vs3.6 owns durable gates, gate revisions, authenticated responses, Plannotator, and action delivery. |
| O7 | `wvs34-d4-bac9e02e-res-o7` | workflowd-vs3.7 ownership boundary | workflowd-vs3.7 owns session-link presentation and retention policy; session identity here is execution and currentness data only. |
| O8 | `wvs34-d4-bac9e02e-res-o8` | workflowd-vs3.8 ownership boundary | workflowd-vs3.8 owns private artifact presentation; workflowd-vs3.4 creates immutable references but serves no content. |
| O9 | `wvs34-d4-bac9e02e-res-o9` | workflowd-vs3.9 ownership boundary | workflowd-vs3.9 exclusively owns Provenance mutation, retry, authoritative observation, conflict handling, validation, and graph snapshots. |
| O10 | `wvs34-d4-bac9e02e-res-o10` | workflowd-vs3.14 ownership boundary | workflowd-vs3.14 owns specialized Design route policy, sequencing, semantic classification, closure, affected-output selection, and reentry triggering. |
| O11 | `wvs34-d4-bac9e02e-res-o11` | workflowd-3d8 ownership boundary | workflowd-3d8 owns operational-status aggregation, presentation, readiness, and safe retry workflow, but not capacity policy or QRSPI runtime lifecycles. |

### Accepted residual-risk dispositions

| Logical ID | Exact graph ID | Title | Accepted disposition |
| --- | --- | --- | --- |
| R1 | `wvs34-d4-bac9e02e-res-r1` | Residual risk R1 disposition | NonMaterial under C1. |
| R2 | `wvs34-d4-bac9e02e-res-r2` | Residual risk R2 disposition | NonMaterial under C2, C3, and C4. |
| R3 | `wvs34-d4-bac9e02e-res-r3` | Residual risk R3 disposition | NonMaterial under C3, C4, and C5. |
| R4 | `wvs34-d4-bac9e02e-res-r4` | Residual risk R4 disposition | NonMaterial under C6, C7, and C8. |
| R5 | `wvs34-d4-bac9e02e-res-r5` | Residual risk R5 disposition | NonMaterial under C7, C8, and C9. |
| R6 | `wvs34-d4-bac9e02e-res-r6` | Residual risk R6 disposition | NonMaterial under C10, C11, C12, and C13. |
| R7 | `wvs34-d4-bac9e02e-res-r7` | Residual risk R7 disposition | NonMaterial under C4, C12, and C14. |
| R8 | `wvs34-d4-bac9e02e-res-r8` | Residual risk R8 disposition | NonMaterial under C15, C16, and C17. |
| R9 | `wvs34-d4-bac9e02e-res-r9` | Residual risk R9 accepted with follow-up | Accept the exact finite-volume cumulative SQLite and workspace exhaustion exposure for Design revision 4 without an aggregate capacity control. |

### Accepted controls

| Logical ID | Exact graph ID | Name | Statement |
| --- | --- | --- | --- |
| C1 | `wvs34-d4-bac9e02e-rule-c1` | Validate complete activation inputs | Resolve and validate complete definitions, contracts, harnesses, policies, availability, hashes, paths, bounds, and retained active versions at every activation and restart boundary; fail QRSPI closed before claim with exact error. |
| C2 | `wvs34-d4-bac9e02e-rule-c2` | Bound exact semantic inputs | Decode and bound exact immutable source, request, and result bytes at the selected contract, preserve authority order, and reject hash, duplicate, or path mismatch before persistence or publication. |
| C3 | `wvs34-d4-bac9e02e-rule-c3` | Fence harness execution | Keep the trusted harness limited to task and session work; persist launch before create and session before prompt; bind attempt workspace and output to exact lease and session identity. |
| C4 | `wvs34-d4-bac9e02e-rule-c4` | Guard every transition | Guard every durable transition and external intent by exact Generation, run, revision, operation, attempt, session, and handoff identities; quarantine data errors and preserve stale audit. |
| C5 | `wvs34-d4-bac9e02e-rule-c5` | Fence cleanup and custody | Fence cleanup and workspace custody; permit no replacement while cleanup is unconfirmed and no deletion while publication or effect is nonterminal or uncertain. |
| C6 | `wvs34-d4-bac9e02e-rule-c6` | Verify exact publication candidate | Verify custody, scope, diff, path, content, parent, signature and trailers, and one final SHA, then use exact-old fast-forward-only mutation. |
| C7 | `wvs34-d4-bac9e02e-rule-c7` | Observe publication authoritatively | Persist intent before mutation and authoritatively observe remote ref, parent, signature, trailers, attribution, blob, and content before completion; observe an unknown effect before retry. |
| C8 | `wvs34-d4-bac9e02e-rule-c8` | Reconcile without destructive mutation | Atomically create one publication-scoped TargetReconcile, save parent state, make publication unclaimable, and permit only read-only observation and exact typed resolution. |
| C9 | `wvs34-d4-bac9e02e-rule-c9` | Retain reconciliation evidence | Retain complete directly queryable reconciliation identity, observations, error, allowed actions, and terminal resolution exactly once across restart. |
| C10 | `wvs34-d4-bac9e02e-rule-c10` | Validate mandatory owner capabilities | Derive mandatory owner references and validate registrations and availability before ingress, each activation, and new effects while unrelated service remains available. |
| C11 | `wvs34-d4-bac9e02e-rule-c11` | Recover the same handoff | Persist exact handoff diagnostics and observe or resubmit the same deterministic local receipt after failure, restart, and restoration; duplicates return the same result and mismatches remain blocked. |
| C12 | `wvs34-d4-bac9e02e-rule-c12` | Accept exact owner results only | Accept only exact typed owner results bound to current scope, package, policy, and request; approval alone and partial or uncertain results cannot release Structure. |
| C13 | `wvs34-d4-bac9e02e-rule-c13` | Require owner-side exact lifecycle | The selected named downstream owner must implement an idempotent owner-side lifecycle and exact result production behind the registered capability before its path is exposed. |
| C14 | `wvs34-d4-bac9e02e-rule-c14` | Pin Design and reentry identities | Pin all Design, promotion, and Structure identities; require the exact workflowd-vs3.9 result and snapshot for release; accept bounded workflowd-vs3.14 reentry and apply only named local effects idempotently. |
| C15 | `wvs34-d4-bac9e02e-rule-c15` | Classify legacy state before writes | Before normal startup writes, take a read-only snapshot and classify every current Generation and nonterminal operation into a canonical bounded manifest with exact diagnostics and actions. |
| C16 | `wvs34-d4-bac9e02e-rule-c16` | Back up and apply append-only | Verify unchanged manifest and database, fsync and verify same-filesystem database, WAL, and SHM backup, apply append-only schema transactionally, and prove rollback or restore and verify backup. |
| C17 | `wvs34-d4-bac9e02e-rule-c17` | Supersede exact no-effect legacy work | Resolve only exact no-effect legacy Generation through idempotent offline supersession, verify the result, and use ordinary authenticated WorkflowStart for the successor. |
| C18 | `wvs34-d4-bac9e02e-rule-c18` | Bound individual items without capacity claim | Enforce every configured and global payload and diff bound and release only workspace custody proven terminal or superseded; do not represent these as aggregate-capacity control. |

### Accepted verification obligations

| Logical ID | Exact graph ID | Name | Statement |
| --- | --- | --- | --- |
| V1 | `wvs34-d4-bac9e02e-rule-v1` | Verify activation validation | Prove complete config, catalog, and handoff validation prevents claim at the Layer and activation boundary. |
| V2 | `wvs34-d4-bac9e02e-rule-v2` | Verify exact bounded data | Prove exact source and result Schemas, hashes, bounds, order, and authority survive persistence and retry. |
| V3 | `wvs34-d4-bac9e02e-rule-v3` | Verify attempt and custody fencing | Prove session and workspace output transfer custody only under the exact current attempt and cleanup fence. |
| V4 | `wvs34-d4-bac9e02e-rule-v4` | Verify exact Git reconciliation | Prove publication and reconciliation preserve exact Git truth across every mutation, transaction, and restart window. |
| V5 | `wvs34-d4-bac9e02e-rule-v5` | Verify direct reconciliation recovery | Prove reconciliation remains directly recoverable without a status product. |
| V6 | `wvs34-d4-bac9e02e-rule-v6` | Verify capability availability | Prove mandatory owner capability exists before any configured crossing can create an effect. |
| V7 | `wvs34-d4-bac9e02e-rule-v7` | Verify same-handoff recovery | Prove an unavailable owner crossing recovers through one exact handoff and owner lifecycle. |
| V8 | `wvs34-d4-bac9e02e-rule-v8` | Verify upgrade safety | Prove upgrade classifies before writes, never converts or invents legacy state, and restores or proves the prior database on failure. |
| V9 | `wvs34-d4-bac9e02e-rule-v9` | Verify exact legacy retirement | Prove shipped recovery retires only exact dormant legacy work and creates a successor only through ordinary ingress. |
| V10 | `wvs34-d4-bac9e02e-rule-v10` | Verify individual bounds without capacity claim | Prove individual bounds and custody rules work while making no aggregate-capacity guarantee. |
| V11 | `wvs34-d4-bac9e02e-rule-v11` | Verify exact Design progression identities | Prove only exact current package, response, promotion, snapshot, and directive identities can alter Design progression or reentry. |

### Accepted edges

| Requirement | Decision, assignment, or disposition | needs edge | resolves edge | produces |
| --- | --- | --- | --- | --- |
| AC1 | D1 | `needs_requirement_wvs34-d4-bac9e02e-req-ac1_to_resolution_wvs34-d4-bac9e02e-res-d1` | `resolves_resolution_wvs34-d4-bac9e02e-res-d1_to_requirement_wvs34-d4-bac9e02e-req-ac1` | C1 |
| AC2 | D2 | `needs_requirement_wvs34-d4-bac9e02e-req-ac2_to_resolution_wvs34-d4-bac9e02e-res-d2` | `resolves_resolution_wvs34-d4-bac9e02e-res-d2_to_requirement_wvs34-d4-bac9e02e-req-ac2` | C2 |
| AC9 | D3 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-d3` | `resolves_resolution_wvs34-d4-bac9e02e-res-d3_to_requirement_wvs34-d4-bac9e02e-req-ac9` | C4 |
| AC7 | D4 | `needs_requirement_wvs34-d4-bac9e02e-req-ac7_to_resolution_wvs34-d4-bac9e02e-res-d4` | `resolves_resolution_wvs34-d4-bac9e02e-res-d4_to_requirement_wvs34-d4-bac9e02e-req-ac7` | C3, C5 |
| AC8 | D5 | `needs_requirement_wvs34-d4-bac9e02e-req-ac8_to_resolution_wvs34-d4-bac9e02e-res-d5` | `resolves_resolution_wvs34-d4-bac9e02e-res-d5_to_requirement_wvs34-d4-bac9e02e-req-ac8` | C6, C7 |
| AC8 | D6 | `needs_requirement_wvs34-d4-bac9e02e-req-ac8_to_resolution_wvs34-d4-bac9e02e-res-d6` | `resolves_resolution_wvs34-d4-bac9e02e-res-d6_to_requirement_wvs34-d4-bac9e02e-req-ac8` | C8, C9 |
| AC9 | D7 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-d7` | `resolves_resolution_wvs34-d4-bac9e02e-res-d7_to_requirement_wvs34-d4-bac9e02e-req-ac9` | none |
| AC9 | D8 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-d8` | `resolves_resolution_wvs34-d4-bac9e02e-res-d8_to_requirement_wvs34-d4-bac9e02e-req-ac9` | C10, C11, C13 |
| AC9 | D9 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-d9` | `resolves_resolution_wvs34-d4-bac9e02e-res-d9_to_requirement_wvs34-d4-bac9e02e-req-ac9` | C12, C14 |
| AC3 | D10 | `needs_requirement_wvs34-d4-bac9e02e-req-ac3_to_resolution_wvs34-d4-bac9e02e-res-d10` | `resolves_resolution_wvs34-d4-bac9e02e-res-d10_to_requirement_wvs34-d4-bac9e02e-req-ac3` | none |
| AC5 | D11 | `needs_requirement_wvs34-d4-bac9e02e-req-ac5_to_resolution_wvs34-d4-bac9e02e-res-d11` | `resolves_resolution_wvs34-d4-bac9e02e-res-d11_to_requirement_wvs34-d4-bac9e02e-req-ac5` | C15, C16, C17 |
| AC11 | D12 | `needs_requirement_wvs34-d4-bac9e02e-req-ac11_to_resolution_wvs34-d4-bac9e02e-res-d12` | `resolves_resolution_wvs34-d4-bac9e02e-res-d12_to_requirement_wvs34-d4-bac9e02e-req-ac11` | V1, V10, V11, V2, V3, V4, V5, V6, V7, V8, V9 |
| AC9 | D13 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-d13` | `resolves_resolution_wvs34-d4-bac9e02e-res-d13_to_requirement_wvs34-d4-bac9e02e-req-ac9` | none |
| AC1 | O1 | `needs_requirement_wvs34-d4-bac9e02e-req-ac1_to_resolution_wvs34-d4-bac9e02e-res-o1` | `resolves_resolution_wvs34-d4-bac9e02e-res-o1_to_requirement_wvs34-d4-bac9e02e-req-ac1` | none |
| AC7 | O2 | `needs_requirement_wvs34-d4-bac9e02e-req-ac7_to_resolution_wvs34-d4-bac9e02e-res-o2` | `resolves_resolution_wvs34-d4-bac9e02e-res-o2_to_requirement_wvs34-d4-bac9e02e-req-ac7` | C3 |
| AC5 | O3 | `needs_requirement_wvs34-d4-bac9e02e-req-ac5_to_resolution_wvs34-d4-bac9e02e-res-o3` | `resolves_resolution_wvs34-d4-bac9e02e-res-o3_to_requirement_wvs34-d4-bac9e02e-req-ac5` | C17 |
| AC9 | O4 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-o4` | `resolves_resolution_wvs34-d4-bac9e02e-res-o4_to_requirement_wvs34-d4-bac9e02e-req-ac9` | C1, C10, C11, C12, C14, C15, C16, C17, C18, C2, C3, C4, C5, C6, C7, C8, C9 |
| AC9 | O5 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-o5` | `resolves_resolution_wvs34-d4-bac9e02e-res-o5_to_requirement_wvs34-d4-bac9e02e-req-ac9` | C13 |
| AC9 | O6 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-o6` | `resolves_resolution_wvs34-d4-bac9e02e-res-o6_to_requirement_wvs34-d4-bac9e02e-req-ac9` | C13 |
| AC7 | O7 | `needs_requirement_wvs34-d4-bac9e02e-req-ac7_to_resolution_wvs34-d4-bac9e02e-res-o7` | `resolves_resolution_wvs34-d4-bac9e02e-res-o7_to_requirement_wvs34-d4-bac9e02e-req-ac7` | none |
| AC8 | O8 | `needs_requirement_wvs34-d4-bac9e02e-req-ac8_to_resolution_wvs34-d4-bac9e02e-res-o8` | `resolves_resolution_wvs34-d4-bac9e02e-res-o8_to_requirement_wvs34-d4-bac9e02e-req-ac8` | none |
| AC9 | O9 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-o9` | `resolves_resolution_wvs34-d4-bac9e02e-res-o9_to_requirement_wvs34-d4-bac9e02e-req-ac9` | C13, C14 |
| AC9 | O10 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-o10` | `resolves_resolution_wvs34-d4-bac9e02e-res-o10_to_requirement_wvs34-d4-bac9e02e-req-ac9` | C13, C14 |
| AC9 | O11 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-o11` | `resolves_resolution_wvs34-d4-bac9e02e-res-o11_to_requirement_wvs34-d4-bac9e02e-req-ac9` | none |
| AC1 | R1 | `needs_requirement_wvs34-d4-bac9e02e-req-ac1_to_resolution_wvs34-d4-bac9e02e-res-r1` | `resolves_resolution_wvs34-d4-bac9e02e-res-r1_to_requirement_wvs34-d4-bac9e02e-req-ac1` | C1 |
| AC6 | R2 | `needs_requirement_wvs34-d4-bac9e02e-req-ac6_to_resolution_wvs34-d4-bac9e02e-res-r2` | `resolves_resolution_wvs34-d4-bac9e02e-res-r2_to_requirement_wvs34-d4-bac9e02e-req-ac6` | C2, C3, C4 |
| AC9 | R3 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-r3` | `resolves_resolution_wvs34-d4-bac9e02e-res-r3_to_requirement_wvs34-d4-bac9e02e-req-ac9` | C3, C4, C5 |
| AC8 | R4 | `needs_requirement_wvs34-d4-bac9e02e-req-ac8_to_resolution_wvs34-d4-bac9e02e-res-r4` | `resolves_resolution_wvs34-d4-bac9e02e-res-r4_to_requirement_wvs34-d4-bac9e02e-req-ac8` | C6, C7, C8 |
| AC8 | R5 | `needs_requirement_wvs34-d4-bac9e02e-req-ac8_to_resolution_wvs34-d4-bac9e02e-res-r5` | `resolves_resolution_wvs34-d4-bac9e02e-res-r5_to_requirement_wvs34-d4-bac9e02e-req-ac8` | C7, C8, C9 |
| AC9 | R6 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-r6` | `resolves_resolution_wvs34-d4-bac9e02e-res-r6_to_requirement_wvs34-d4-bac9e02e-req-ac9` | C10, C11, C12, C13 |
| AC9 | R7 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-r7` | `resolves_resolution_wvs34-d4-bac9e02e-res-r7_to_requirement_wvs34-d4-bac9e02e-req-ac9` | C12, C14, C4 |
| AC5 | R8 | `needs_requirement_wvs34-d4-bac9e02e-req-ac5_to_resolution_wvs34-d4-bac9e02e-res-r8` | `resolves_resolution_wvs34-d4-bac9e02e-res-r8_to_requirement_wvs34-d4-bac9e02e-req-ac5` | C15, C16, C17 |
| AC9 | R9 | `needs_requirement_wvs34-d4-bac9e02e-req-ac9_to_resolution_wvs34-d4-bac9e02e-res-r9` | `resolves_resolution_wvs34-d4-bac9e02e-res-r9_to_requirement_wvs34-d4-bac9e02e-req-ac9` | C18 |

### Residual-risk conditions and follow-up

| Logical ID | Conditions and follow-up |
| --- | --- |
| R1 | Fail-closed QRSPI configuration error only; C1 and V1 are mandatory conditions of this disposition. Enforcement: carry the accepted disposition unchanged Accountable human: Ben Nasraoui. |
| R2 | Malformed data is blocked or replaced before canonical use; V2 and V3 remain mandatory. Enforcement: carry the accepted disposition unchanged Accountable human: Ben Nasraoui. |
| R3 | Stale attempts remain audit and exact work recovers; V3 remains mandatory. Enforcement: carry the accepted disposition unchanged Accountable human: Ben Nasraoui. |
| R4 | Exact-old and preflight failures do not advance; V4 remains mandatory. Enforcement: carry the accepted disposition unchanged Accountable human: Ben Nasraoui. |
| R5 | An unresolved conflict can park one Generation but cannot erase external work or advance stale state; V4 and V5 remain mandatory. Enforcement: carry the accepted disposition unchanged Accountable human: Ben Nasraoui. |
| R6 | An owner outage can park one boundary while unrelated service continues; V6 and V7 remain mandatory. Enforcement: carry the accepted disposition unchanged Accountable human: Ben Nasraoui. |
| R7 | Stale or mismatched owner results remain blocked; V11 remains mandatory. Enforcement: carry the accepted disposition unchanged Accountable human: Ben Nasraoui. |
| R8 | A failed or unsupported upgrade preserves the prior database and blocks the affected workflow; V8 and V9 remain mandatory. Enforcement: carry the accepted disposition unchanged Accountable human: Ben Nasraoui. |
| R9 | Aggregate durable-storage capacity management is outside workflowd-vs3.4. Track prevention, detection, containment, and recovery separately in workflowd-8bg; C18 remains required and is not an aggregate-capacity control. Enforcement: Carry accepted residual risk, conditions, accountable human, and follow-up workflowd-8bg without rewriting the risk as resolved. Accountable human: Ben Nasraoui. |

## Repository baseline inventory

These are the facts of `BNasraoui/workflowd` at commit
`42e129ab75ea0de39aa1bd6db4502325cd3effb1`. The lists are complete for the dimensions
they name. They state what exists and what does not; they state no conclusion.

### Present modules and exported seams

| Path                         | Exports and behaviour that exist at this baseline                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/qrspi/domain.ts`        | `Ticket`, `ReadyTicket`, `TicketRevision`, `TicketCheck`, `WorkflowStartRequest`, `StageInputContract`, `StageProducerDefinition`, `StageOutputContract`, `StageReviewPolicy`, `StageHumanGatePolicy`, `StageActivationPolicy`, `WorkflowStageDefinition`, `WorkflowDefinition`, `SourceResolver`, `workflowDefinitionSha256`, `normalizeWorkflowDefinition` (descriptor-shape validation only, at line 251), `workflowIdFor`, `checkTicket`, `canonicalSha256` |
| `src/qrspi/ports.ts`         | `TicketSourcePort`, `TicketSource`, `QrspiRepositoryPort`, `QrspiRepository`, `RepositoryInspection`, `AcceptedBranchObservation`, and their error types                                                    |
| `src/qrspi/store.ts`         | `QrspiStorePort`, `QrspiStore`, `QrspiStoreLive`, `StartRecord`, `PrepareStartInput`, `CompleteStartInput`, `WorkflowStartTerminalRetryPolicy`, and store error types. Its transactions cover workflow start only. |
| `src/qrspi/workflow-start.ts` | `WorkflowStart`, `WorkflowStartLive`, `makeWorkflowStart`, and the typed start error set                                                                                                                   |
| `src/qrspi/adapters.ts`      | `BeadsCliTicketSource`, `GitHubQrspiRepository`, `openPullRequestQuery`                                                                                                                                    |
| `src/qrspi/source-resolver.ts` | `makeWorkspaceSourceResolver`                                                                                                                                                                            |
| `src/agent-harness.ts`       | `AgentHarness`, `AgentHarnessPort`, `OpenCodeAgentHarness`, `AgentHarnessRef`, `AgentHarnessDefinition`, `TrustedAgentHarnessCatalog`, `AgentExecutionScope`, `SessionReference`, `AgentLaunchIntent`, `PreparedAgentWork`, session launch, resume, abort, and output bounds |
| `src/layers.ts`              | `makeLiveLayer`, which composes the existing store, GitHub, OpenCode, webhook, worker, and workspace services                                                                                              |
| `src/workspace/fix.ts`       | fix-work publication at line 38, whose push at line 101 is an ordinary `git push`                                                                                                                          |
| `src/store/migrations.ts`    | tables `webhook_deliveries`, `pull_requests`, `publications`, `jobs`, `commands`, `reconciliations`, `agent_executions`, `qrspi_workflows`, `qrspi_ticket_revisions`, `qrspi_workflow_definitions` (definition JSON only, line 411), `workflow_operations` (line 423, with `TargetReconcile` as an allowed kind at line 430), `workflow_operation_gates`, `qrspi_generations` (line 502) |

### Present verification patterns

| Pattern                                    | Where it already exists                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Real SQLite database per test              | `test/store/harness.ts`, `test/store/migrations.test.ts`, `test/store/workflows.test.ts`     |
| Fake port implementations built in-test    | `test/qrspi/workflow-start.test.ts`, `test/qrspi/adapters.test.ts`                          |
| Schema decode and boundary tests           | `test/domain/domain-schema.test.ts`, `test/qrspi/ticket.test.ts`                             |
| Lease, currentness, and transaction tests  | `test/store/lease-authority.test.ts`, `test/store/lease-bounds.test.ts`, `test/store/fix-currentness.test.ts`, `test/store/transaction-policy.test.ts` |
| Agent session mechanics tests              | `test/agent-harness.test.ts`, `test/opencode/structured-session.test.ts`                    |

### Absent at this baseline

None of the following exists anywhere in the repository at this commit:

- a stage catalog, trusted stage registration, or contract and harness resolution seam;
- built-in per-stage request and result contracts for Questions, Research, Design,
  Structure, Plan, or Implementation, and any exact source-set assembly or persisted
  request-hash record;
- durable records or migrations for stage runs, stage revisions, implementation steps,
  commit references, custody bindings, artifact references, handoff receipts, or
  reconciliation evidence;
- a QRSPI producer, custody transfer, or cleanup-fencing service;
- a QRSPI artifact publisher, exact-old compare-and-set branch update, publication-intent
  record, or authoritative publication observation;
- a QRSPI reconciliation implementation, typed reconciliation input, or resolution record;
- owner-handoff capability validation or idempotent local receipts;
- any Provenance promotion request construction, result validation, or snapshot handling;
- legacy migration preflight, manifest, verified backup, append-only apply, rollback, or
  offline supersession tooling;
- a fault-injection fixture that coordinates SQLite, Git, workspaces, and OpenCode
  sessions across restart windows;
- service tags, ports, or composition entries in `makeLiveLayer` for a catalog, stage
  service, publisher, or stage loop.
