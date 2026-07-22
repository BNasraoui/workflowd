# Design Acceptance Synthesis

## Synthesis Status

This immutable synthesis prepares one exact human gate for Design revision 4. It does not
approve or revise the Design, make the pending risk decision, or authorize Structure.

| Field | Value |
| --- | --- |
| Ticket | `workflowd-vs3.4`, “Run configurable QRSPI stages and publish their artifacts” |
| Ownership conclusion | `ScopeClean`; no blocking ownership finding and no unresolved clarification. Keep revision 4 as written for semantic-boundary purposes. |
| Impact conclusion | `NeedsRiskDecision` |
| Gate purpose | Decide exactly `PendingDecision:R9` while accepting C1-C18 as ordered package obligations |
| Design state | Unapproved unless and until the exact package receives a complete matching human response |

## Verified Acceptance Scope

All path-backed identities below were verified before synthesis. SHA-256 values are over
the exact file bytes; Design and ownership blob IDs were independently reproduced with Git.

| Scope field | Exact identity |
| --- | --- |
| WorkflowId | `BNasraoui/workflowd:workflowd-vs3.4` |
| Generation | `1` |
| Repository base | `42e129ab75ea0de39aa1bd6db4502325cd3effb1` |
| WorkflowDefinition SHA-256 | `6f7f7dcc51ce36973696247baecd645ba622a1e6ac05ca3d94d5ba6eb23da001` |
| Binding | `.humanlayer/tasks/workflowd-vs3.4-configurable-qrspi-stages/03-design-acceptance-binding-r4.json`; contract version `1`; SHA-256 `092bd8990bb83c2aac19bea5962a1fc510c64215f38540501af32a8dcd4d8998` |
| Design | Revision `4`; `.humanlayer/tasks/workflowd-vs3.4-configurable-qrspi-stages/03-design-discussion-configurable-stages-r4.md`; blob `9534cb55980aa72638a91b74816cfad04aaaedb8`; SHA-256 `444b525f15e4d1065f7c91cf532b5f2a3d92bce5a7513d4f1c262ad635cbcf43` |
| Questions source | `.humanlayer/tasks/workflowd-vs3.4-configurable-qrspi-stages/01-research-questions-configurable-stages.md`; blob `ec9ddbcbc6165087394066a2df9d6a80061ef38e`; SHA-256 `4279e73b21aa25918639d3fbfed8574367d66023a69e6f3b53b60c28c3e24876` |
| Research source | `.humanlayer/tasks/workflowd-vs3.4-configurable-qrspi-stages/02-research-configurable-stages.md`; blob `56fc1422df29da74bb81c8830eb46ba10c9f4ec4`; SHA-256 `c88f48fbdb535bff05557a4007d77b0d2c25c25e0e893412f1a67490b6208701` |
| Ordered source-set SHA-256 | `71674132945f9a0043fb230e696d6daacd12438b443600b7d8211e25c0eb599a` |
| Ownership report | `.humanlayer/tasks/workflowd-vs3.4-configurable-qrspi-stages/03-design-boundary-review-configurable-stages-r4.md`; blob `e2aa5eb4ef9ee68bbd6070472e9d84f051b02260`; SHA-256 `806f2f10b52d35c2e9d27dd920f4c50e19e949abf02e30c2e9cd44ac6eb8ecb5`; verdict `ScopeClean` |
| Impact report | `.humanlayer/tasks/workflowd-vs3.4-configurable-qrspi-stages/03-design-impact-risk-review-configurable-stages-r4.md`; SHA-256 `67d3824798ef678aa89bd894f1890802490004d3967efdf09a9960ca251dcd94`; verdict `NeedsRiskDecision` |
| Design policy | `workflowd.design-acceptance@1`; SHA-256 `30560f4776d78c0767d7a0e4f5ec71d780bc7cd0fc2edec92593e1945cbc5251` |
| Promotion policy | `workflowd.provenance-promotion@1`; SHA-256 `c49d6d0f646616efb87e13e1be4cb9f449e187796775d9f6476883584c466bbf` |
| Structure policy | `workflowd.structure@1`; SHA-256 `d360ea62f9b7e1847c0da5b630af93fd28f98fb7f58e88d7b5f026be5922b85d` |
| Normative contract checked | `docs/qrspi-contract.md`; SHA-256 `55470a92b645ccfcea8f694ec43ae64b6dd9f6f7615664539e05756b4edcfc7d` |
| Operational checklist checked | `skills/qrspi-design-structure/SKILL.md`; SHA-256 `7e3df52ceec1b52749745682f9d0dbd2a0a3c7b6640affd913b5958fb94951e6` |

The reports remain canonical and unchanged. This synthesis incorporates their conclusions
and obligations by exact identity; it does not replace their evidence or analysis.

## Risk Dispositions

R1-R8 are `NonMaterial` only under every control listed for that risk. Omitting, weakening,
or failing a listed control removes the basis for that disposition; this synthesis makes no
alternate disposition. R9 remains material and undecided.

| Risk | Required control basis | Residual disposition under that basis |
| --- | --- | --- |
| R1 | C1 | `NonMaterial`; `Minor (2)`, likelihood `Unknown`, no score. Fail-closed QRSPI configuration error only. |
| R2 | C2, C3, C4 | `NonMaterial`; `Minor (2)`, likelihood `Unknown`, no score. Malformed data is blocked or replaced before canonical use. |
| R3 | C3, C4, C5 | `NonMaterial`; `Minor (2)`, likelihood `Unknown`, no score. Stale attempts remain audit and exact work recovers. |
| R4 | C6, C7, C8 | `NonMaterial`; `Minor (2)`, likelihood `Unknown`, no score. Exact-old and preflight failures do not advance. |
| R5 | C7, C8, C9 | `NonMaterial`; `Moderate (3)`, likelihood `Unknown`, no score. An unresolved external conflict can park one Generation but cannot erase external work or advance stale state. |
| R6 | C10, C11, C12, C13 | `NonMaterial`; `Moderate (3)`, likelihood `Unknown`, no score. An owner outage can park one boundary while unrelated service continues. |
| R7 | C4, C12, C14 | `NonMaterial`; `Minor (2)`, likelihood `Unknown`, no score. Stale or mismatched owner results remain blocked. |
| R8 | C15, C16, C17 | `NonMaterial`; `Minor (2)`, likelihood `Unknown`, no score. A failed or unsupported upgrade preserves the prior database and blocks the affected workflow. |
| R9 | C18 only; C18 is not an aggregate-capacity control | `Material`; `NeedsDecision`; `Significant (4) x AlmostCertain (5) = 20 / Critical` for sustained unbounded use on a finite shared volume. The rating remains unchanged under C18. |

## Ordered Control Obligations

The gate must treat C1-C18 in this order as required obligations. Verification IDs refer
to the exact V1-V11 targets in the impact report.

| ID | Owner | Phase | Obligation | Verification target |
| --- | --- | --- | --- | --- |
| C1 | `workflowd-vs3.4` | BeforeExposure | Resolve and validate complete definitions, contracts, harnesses, policies, availability, hashes, paths, bounds, and retained active versions at every activation/restart boundary; fail QRSPI closed before claim with exact error. | V1: invalid or missing refs never create claimable work; corrected config can activate unchanged durable identity. |
| C2 | `workflowd-vs3.4` | Implementation | Decode and bound exact immutable source/request/result bytes at the selected contract, preserve authority order, and reject hash, duplicate, or path mismatch before persistence or publication. | V2: malformed, oversized, reordered, duplicate, or changed source/result cannot pass. |
| C3 | `workflowd-vs3.4` using `workflowd-vs3.2` mechanics | Implementation | Keep the trusted harness limited to task/session work; persist launch before create and session before prompt; bind attempt workspace and output to exact lease/session identity. | V3: late or invalid session output cannot transfer custody or advance. |
| C4 | `workflowd-vs3.4` | Implementation | Guard every durable transition and external intent by exact Generation/run/revision/operation/attempt/session/handoff identities; quarantine data errors and preserve stale audit. | V3 and V11: a zero-row stale or mismatch outcome never advances, and valid same identity recovers. |
| C5 | `workflowd-vs3.4` | Recovery | Fence cleanup and workspace custody; permit no replacement while cleanup is unconfirmed and no deletion while publication/effect is nonterminal or uncertain. | V3: forced cleanup uncertainty retains custody/fence; exact terminal or superseded custody releases. |
| C6 | `workflowd-vs3.4` | BeforeExposure | Verify custody, scope, diff/path/content, parent, signature/trailers, and one final SHA, then use exact-old fast-forward-only mutation. | V4: an unsafe candidate or changed old SHA causes no accepted mutation or advance. |
| C7 | `workflowd-vs3.4` | Runtime | Persist intent before mutation and authoritatively observe remote ref, parent, signature, trailers, attribution, blob, and content before completion; observe an unknown effect before retry. | V4: every crash window resolves from authoritative Git without duplicate SHA or stale parent advance. |
| C8 | `workflowd-vs3.4` | Recovery | Atomically create one publication-scoped `TargetReconcile`, save parent state, make publication unclaimable, and permit only read-only observation and exact typed resolution. | V4: conflict, rollback, stale, and unknown cases never reset refs or advance a stale parent. |
| C9 | `workflowd-vs3.4` | Runtime | Retain complete directly queryable reconciliation identity, observations, error, allowed actions, and terminal resolution exactly once across restart. | V5: pending, waiting, failed, and unclaimable records remain complete, and terminal resolution is singular. |
| C10 | `workflowd-vs3.4` | BeforeExposure | Derive mandatory owner refs and validate registrations/availability before ingress, each run/revision activation, and new effects while unrelated service remains available. | V6: removing each mandatory registration closes only QRSPI before a child effect. |
| C11 | `workflowd-vs3.4` | Recovery | Persist exact handoff diagnostics and observe/resubmit the same deterministic local receipt after failure, restart, and restoration; duplicates return the same result and mismatches remain blocked. | V7: adapter failure, restart, and restoration use one handoff/request hash and preserve the exact error. |
| C12 | `workflowd-vs3.4` | Runtime | Accept only exact typed owner results bound to current scope/package/policy/request; approval alone and partial or uncertain results cannot release Structure. | V11: a stale, partial, conflicting, or mismatched result leaves the exact parent blocked. |
| C13 | Selected named downstream owner: `workflowd-vs3.5`, `workflowd-vs3.6`, `workflowd-vs3.9`, or `workflowd-vs3.14` | BeforeExposure | Implement the idempotent owner-side lifecycle and exact result production behind the registered capability before its configured path is exposed. | V7 plus each owner contract: the adapter can submit/observe one deterministic request and return the exact result. |
| C14 | `workflowd-vs3.4` | Runtime | Pin all Design/promotion/Structure identities; require the exact `.9` result/snapshot for release; accept bounded `.14` reentry and apply only named local effects idempotently. | V11: approval-only release, stale snapshot, and broadened or duplicate directive all fail without unintended state change. |
| C15 | `workflowd-vs3.4` | BeforeExposure | Before normal startup writes, take a read/query-only snapshot and classify every current Generation/nonterminal operation into a canonical bounded manifest with exact diagnostics/actions. | V8: new, dormant, malformed, and partial fixtures receive complete pre-write classification, and incompatible work stays blocked. |
| C16 | `workflowd-vs3.4` | BeforeExposure | Verify unchanged manifest/database, fsync and verify same-filesystem DB/WAL/SHM backup, apply append-only schema transactionally, and prove rollback or restore and verify backup. | V8: each injected failure leaves proven pre-upgrade schema/rows or a verified restored backup. |
| C17 | `workflowd-vs3.4` | Recovery | Resolve only exact no-effect legacy Generation through idempotent offline supersession, verify the result, and use ordinary authenticated WorkflowStart for the successor. | V9: wrong identity/hash writes nothing; exact repeat is idempotent; fresh kickoff succeeds without direct SQL. |
| C18 | `workflowd-vs3.4` | Implementation | Enforce every configured/global payload and diff bound and release only workspace custody proven terminal or superseded; do not represent these as aggregate-capacity control. | V10: each durable boundary rejects over-limit records/diffs and cleanup never removes uncertain or nonterminal custody; evidence makes no total-capacity assertion. |

## Verification Index

| ID | Exact proof target |
| --- | --- |
| V1 | Complete config/catalog/handoff validation prevents claim at the Layer and activation boundary. |
| V2 | Exact source/result Schemas, hashes, bounds, order, and authority survive persistence and retry. |
| V3 | Session and workspace output transfer custody only under the exact current attempt and cleanup fence. |
| V4 | Publication and reconciliation preserve exact Git truth across every mutation, transaction, and restart window. |
| V5 | Reconciliation remains directly recoverable without a status product. |
| V6 | Mandatory owner capability exists before any configured crossing can create an effect. |
| V7 | An unavailable owner crossing recovers through one exact handoff and owner lifecycle. |
| V8 | Upgrade classifies before writes, never converts or invents legacy state, and restores or proves the prior database on failure. |
| V9 | Shipped recovery retires only exact dormant legacy work and creates a successor only through ordinary ingress. |
| V10 | Individual bounds and custody rules work but make no aggregate-capacity guarantee. |
| V11 | Only exact current package, response, promotion, snapshot, and directive identities can alter Design progression or reentry. |

## Pending Human Decision

**Decision ID:** `PendingDecision:R9`

**Exact question:** For Design revision 4 and material risk R9, does the accountable human
Design approver choose **(A)** accept cumulative SQLite/workspace exhaustion for this exact
Design and stated finite-volume exposure without an aggregate control, **(B)** defer Design
approval until an authorized owner and acceptance condition for capacity prevention,
detection, and recovery are established outside `workflowd-vs3.4`, or **(C)** require
deployment-specific workload, free-space, and time-to-exhaustion evidence before choosing A
or B?

**Evidence:** Design revision 4 lines 815-834 and normative contract lines 1324-1347 establish
indefinite QRSPI audit retention, nonterminal workspace custody, per-record bounds, and no
aggregate control. Sustained workflows, revisions, attempts, or long-lived uncertain
publication on a finite shared volume can therefore grow SQLite and workspace use until
SQLite or Git cannot write, affecting QRSPI and unrelated controller work. The issue graph
examined by the independent review assigns no capacity-policy owner; `workflowd-3d8` owns
status/readiness concerns, not capacity policy. C18 limits individual items and safely
releases proven custody but does not prevent, detect, contain, or recover cumulative
exhaustion. Time-to-exhaustion and actual workload/capacity remain uncertain; cumulative
growth under the stated sustained finite-volume exposure does not.

**Materiality and rating:** `Material`; `Significant (4) x AlmostCertain (5) = 20 / Critical`
under `5x5-v1`, unchanged with C18 alone. Decision owner: accountable human Design approver.

## Gate Routes

| Option | Exact route |
| --- | --- |
| A | The accountable human may approve the exact package only by explicitly accepting R9 for this exact Design and stated finite-volume exposure without aggregate prevention, detection, or recovery control. |
| B | Keep Design unapproved until an authorized capacity owner and acceptance condition for aggregate prevention, detection, and recovery are established outside `workflowd-vs3.4`. |
| C | Keep Design unapproved pending bounded deployment evidence for workload, free space, and time-to-exhaustion; after that evidence, the accountable human must choose A or B through the exact package gate. |

No route implies that human approval releases Structure. If option A yields a complete,
matching approval of the later exact package, that approval only authorizes creation and
submission of the later exact Provenance promotion request. Design remains active and
Structure remains blocked until the matching promotion result and immutable graph snapshot
are authoritatively confirmed under the exact acceptance scope. Options B and C leave the
Design unapproved and authorize neither promotion nor Structure.
