---
task: workflowd-vs3.4.2-implement-six-exact-typed-stage-contracts
step: structure-producer-b-r1
type: structure-candidate
design-revision: 4
projection: independent-b
status: authority-blocked
---

# Structure Candidate B: Six Exact Typed Stage Contracts

## Structure Verdict

`AuthorityBlocked`

This candidate classifies and projects every semantic node in the supplied exact graph
export. It does not authorize implementation and cannot satisfy Structure exit.

The supplied files do contain a confirmed local promotion result and an immutable graph
snapshot reference. They do not establish a contract-valid accepted Design package:

- The package binds `03-design-acceptance-synthesis-r4.md`, whose outcome is `Fail` and
  whose routing says not to create a Design gate, promotion, or Structure input.
- That synthesis records missing complete `DesignAcceptanceScope` artifact identities,
  missing Design and promotion policy identities, missing trusted reviewer identities,
  slots, and sessions, and unproved reviewer independence.
- `03-design-gate-response-r4.json` is a `LocalDogfoodGateOverride` with
  `simulationOnly: true`; it is not evidence of the authenticated package-bound response
  required by the normative contract.
- `03-provenance-promotion-request-r4.json` is also `simulationOnly: true`.
- The package manifest lists local paths and hashes but does not itself carry the complete
  acceptance scope, ordered obligations, ordered residual-risk decisions, its own
  `ArtifactReference`, or a declared `packageSha256`.
- The graph export has no residual-risk decision records, although selection completeness
  requires every accepted residual-risk disposition to be selected and observed.

The human's authorization to choose recommended gate answers cannot supply the missing
identity, independence, authentication, immutable package, or selection evidence. The
projection below is therefore an auditable candidate only. The authority defect must be
resolved through a conforming Design acceptance package and promotion result before any
capability can become terminal work.

## Bound Candidate Input

| Identity | Exact supplied value | Candidate finding |
| --- | --- | --- |
| Workflow | `workflowd-workflowd-vs3.4.2:workflowd-vs3.4.2` | Generation `1` |
| Design | revision `4`; SHA-256 `c89ecc6aeed1b84c93c8bf3bd47baafabcca03ef8f0860653a4bba7d5dbf06ee` | Exact local bytes, but not a complete `ArtifactReference` in the binding |
| Source set | SHA-256 `4d5be3489fc81aca45e7e34bba0d96bb7261dec4feea1a712695302782ae1ee7` | Questions then Research in the binding |
| Workflow definition | SHA-256 `d29e5e6a9b478b84cb2aef90d46f57c2dace34c84dd60a6d558a50f8b4a6460a` | Present |
| Structure policy | `local.structure@1`; SHA-256 `7e3df52ceec1b52749745682f9d0dbd2a0a3c7b6640affd913b5958fb94951e6` | Present and pinned |
| Package | SHA-256 `7b6422410f3dfcdd34bc2c1c20194f9798431285579011dd092390c1586b17f7` | Later files assert this hash; manifest is incomplete under the contract |
| Gate response | SHA-256 `566e85845f46b4386a65fd790ee8819d3d4c0d28e36cc77ffde1cab5331fcbba` | Local simulation, not authenticated contract evidence |
| Promotion request | `wvs342-d4-7b642241-promotion`; SHA-256 `1e8ac8d79e80e783ae5a9eb95c03bf368631887fd791e09e809fd3c58d7f975b` | Local simulation |
| Promotion result | status `confirmed`; observed `2026-07-23T23:43:23Z` | Confirms the supplied local request only |
| Graph snapshot | `grf1_00cc8f30f6b47b726679f46b60ff7f40d3d17e23e0135e0f752ade2ccb6fbe6a` | Immutable supplied reference exists |
| Graph repository | `git1_f61043adeee673136abf9fb6b5ae4888975bc27de7b2de18778c59b1a3d9c8fe` | Commit `275ec2d3bcdd23b589efb7b100d6bc84ef20726e` |
| Graph digest | SHA-256 `d5e903d24510b3502eed7beaaa8299ba0b8d09a15aa704377533541096af5b19` | Exact export SHA-256 `39500b8d415dca46f1203fda777abe100e749da3a348f4e1e752807b2fe5de3f` |

All node versions below mean `schema_version: 1` at this pinned graph snapshot. No
floating graph head or later state is used.

## Capability Projection

The route labels assess whether each accepted decision forms one coherent implementation
capability against the current repository. They do not grant implementation authority.
No numeric size threshold or delivery decomposition was used. No capability needs a
separate product flow, so none is `SplitFlowRequired`.

| Capability and exact coverage edge | Authorizing accepted node and graph edge | Coherent outcome | Current repository evidence | Route |
| --- | --- | --- | --- | --- |
| `CAP-B1` Six stage-local contracts; `covers:cap-b1:res-d1` | `wvs342-d4-7b642241-res-d1`; `resolves_resolution_wvs342-d4-7b642241-res-d1_to_requirement_wvs342-d4-7b642241-req-ac1` | Add six distinct stage-tagged request/result Schemas, five document projections, one typed implementation projection, and one explicit Questions-to-Implementation registration tuple. | `src/qrspi/stage-catalog.ts:34-49` already defines the generic contract shape; `:646-670` has only the placeholder Questions contract. | `ImplementationReady` |
| `CAP-B2` Exact authority-ordered source envelope; `covers:cap-b2:res-d2` | `wvs342-d4-7b642241-res-d2`; `resolves_resolution_wvs342-d4-7b642241-res-d2_to_requirement_wvs342-d4-7b642241-req-ac2` | Define Schema-backed ticket reference, ordered accepted artifact sources, scope/definition/target identity, source-set hash, task authority, and contract-local request fields. Derive membership and order from trusted snapshots and accepted pointers. | `ExactStageSources` remains an unknown record at `src/qrspi/stage-catalog.ts:21`; canonical array-preserving hashing exists at `src/qrspi/domain.ts:659-720`. | `ImplementationReady` |
| `CAP-B3` Immutable accepted-artifact reads; `covers:cap-b3:res-d3` | `wvs342-d4-7b642241-res-d3`; `resolves_resolution_wvs342-d4-7b642241-res-d3_to_requirement_wvs342-d4-7b642241-req-ac3` | Reject cross-scope or nonaccepted references before I/O, then read exact commit/path under a cap and verify observed commit, path, blob SHA, UTF-8 bytes, and content SHA-256. | `QrspiRepositoryPort` has no artifact read at `src/qrspi/ports.ts:37-66`; the adapter already follows request/observe/compare for commits at `src/qrspi/adapters.ts:343-374`. | `ImplementationReady` |
| `CAP-B4` Catalog-contained executable erasure; `covers:cap-b4:res-d4` | `wvs342-d4-7b642241-res-d4`; `resolves_resolution_wvs342-d4-7b642241-res-d4_to_requirement_wvs342-d4-7b642241-req-ac4` | Retain executable closures privately, select by exact trusted contract reference/hash, decode with selected Schemas, invoke only selected assemble/build/prepare closures, and return decoded prepared output without stage-key dispatch. | Private registrations currently retain only descriptor, Schemas, and compatibility at `src/qrspi/stage-catalog.ts:84-90`; public port exposes only describe/compatibility at `:216-258`; source-object trust already exists at `:197-213`. | `ImplementationReady` |
| `CAP-B5` Deterministic StageProduce replay; `covers:cap-b5:res-d5` | `wvs342-d4-7b642241-res-d5`; `resolves_resolution_wvs342-d4-7b642241-res-d5_to_requirement_wvs342-d4-7b642241-req-ac5` | Encode versioned exact-scope `StageProduceInput` with contract identity, complete decoded request, and request hash; read and rehash the exact ticket row; replay persisted technical bytes without tracker, latest-path, or repository rediscovery. | Ticket rows already use `(workflow_id, ticket_revision_sha256)` at `src/store/migrations.ts:397-408` and bind Generations by FK at `:502-525`; insertion exists at `src/qrspi/store.ts:619-641`; no exact reader or StageProduce decoder exists. | `ImplementationReady` |
| `CAP-B6` Layered finite bounds and diagnostics; `covers:cap-b6:res-d6` | `wvs342-d4-7b642241-res-d6`; `resolves_resolution_wvs342-d4-7b642241-res-d6_to_requirement_wvs342-d4-7b642241-req-ac6` | Enforce repository-read, per-source UTF-8, complete request, configured input, contract result, prompt/launch, and global result bounds; reject malformed, mistagged, changed, or oversized values before crossing. Keep full ticket content out of requests. | Global encoded payload checks exist at `src/agent-payload.ts:3-24`; registration declarations are bounded at `src/qrspi/stage-catalog.ts:92-149`; stage-local source and result bounds are absent. | `ImplementationReady` |
| `CAP-B7` Pure currentness expectations; `covers:cap-b7:res-d7` | `wvs342-d4-7b642241-res-d7`; `resolves_resolution_wvs342-d4-7b642241-res-d7_to_requirement_wvs342-d4-7b642241-req-ac1` | Supply pure expected/actual comparisons and typed diagnostics for Generation, snapshots, run/revision, target parent, contract, and ordered accepted pointers. Do not persist, claim, expose, or transition work. | WorkflowStart already rechecks durable identity and hashes in `src/qrspi/store.ts:957-1249` and rejects hash-invalid rows at `:1257-1289`; CAP-D2 comparison types are absent. | `ImplementationReady` |
| `CAP-B8` Contract, corruption, and extension proof; `covers:cap-b8:res-d8` | `wvs342-d4-7b642241-res-d8`; `resolves_resolution_wvs342-d4-7b642241-res-d8_to_requirement_wvs342-d4-7b642241-req-ac2` | Prove six-contract order, one registration-only seventh contract, exact boundaries, wrong-scope hash-valid corruption, immutable reads, ticket-row replay, distinct outputs, and fail-closed startup. Do not test or implement neighboring transition races or lifecycles here. | `test/qrspi/stage-catalog.test.ts:67-159` proves catalog identity and registration extension only through concrete registrations; no contract/source/replay suites exist. | `ImplementationReady` |

`CAP-B1` through `CAP-B8` are capability boundaries, not a delivery sequence. Their
accepted identities remain separate even where one capability consumes types or behavior
defined by another.

## Requirement Classification And Coverage

Every requirement is implementation-bearing. Each has terminal candidate coverage through
the exact accepted `needs` edge and the named capability coverage edge above.

| Semantic node | Classification and rationale | Exact coverage |
| --- | --- | --- |
| `wvs342-d4-7b642241-req-ac1` | Implementation-bearing requirement: exact six-contract order and distinct bounded shapes. | `needs_requirement_wvs342-d4-7b642241-req-ac1_to_resolution_wvs342-d4-7b642241-res-d1` -> `CAP-B1`; `needs_requirement_wvs342-d4-7b642241-req-ac1_to_resolution_wvs342-d4-7b642241-res-d7` -> `CAP-B7` |
| `wvs342-d4-7b642241-req-ac2` | Implementation-bearing requirement: exact request authority identities and ordered bytes/hashes. | `needs_requirement_wvs342-d4-7b642241-req-ac2_to_resolution_wvs342-d4-7b642241-res-d2` -> `CAP-B2`; `needs_requirement_wvs342-d4-7b642241-req-ac2_to_resolution_wvs342-d4-7b642241-res-d8` -> `CAP-B8` |
| `wvs342-d4-7b642241-req-ac3` | Implementation-bearing requirement: boundary rejection of changed, reordered, duplicate, malformed, missing, and oversized values. | `needs_requirement_wvs342-d4-7b642241-req-ac3_to_resolution_wvs342-d4-7b642241-res-d3` -> `CAP-B3` |
| `wvs342-d4-7b642241-req-ac4` | Implementation-bearing requirement: deterministic Ticket and accepted-artifact precedence. | `needs_requirement_wvs342-d4-7b642241-req-ac4_to_resolution_wvs342-d4-7b642241-res-d4` -> `CAP-B4` |
| `wvs342-d4-7b642241-req-ac5` | Implementation-bearing requirement: registration-only extension through the production seam. | `needs_requirement_wvs342-d4-7b642241-req-ac5_to_resolution_wvs342-d4-7b642241-res-d5` -> `CAP-B5` |
| `wvs342-d4-7b642241-req-ac6` | Implementation-bearing requirement: individual-limit evidence without aggregate capacity claims. | `needs_requirement_wvs342-d4-7b642241-req-ac6_to_resolution_wvs342-d4-7b642241-res-d6` -> `CAP-B6` |

## Decision Classification And Coverage

All eight approved resolution nodes are implementation-bearing decisions. `CAP-B1`
through `CAP-B8` provide one-to-one candidate coverage through
`covers:cap-bN:res-dN`. D8's prohibition-only clauses are constraints on `CAP-B8`, not
new work: no transition-race, execution, publication, gate, Provenance, or aggregate
capacity lifecycle may be added. D7's downstream mutation clauses are likewise authority
boundaries, not CAP-D2 implementation work.

## Control Classification And Coverage

Every rule is an accepted control. A local control constrains each affected CAP-D2
capability. An external-owner control receives explicit stable owner coverage and is not
duplicated here. The `produces` edge shown is the exact graph edge that carries the
control from its accepted decision.

| Control node | Classification, exact graph edge, and coverage |
| --- | --- |
| `wvs342-d4-7b642241-rule-c1` | Local cross-cutting control; `produces_resolution_wvs342-d4-7b642241-res-d1_to_rule_wvs342-d4-7b642241-rule-c1`; apply source authority/read checks to `CAP-B2`, `CAP-B3`, and `CAP-B8`; verify V1. |
| `wvs342-d4-7b642241-rule-c2` | Local cross-cutting control; `produces_resolution_wvs342-d4-7b642241-res-d2_to_rule_wvs342-d4-7b642241-rule-c2`; typed role/index/reason diagnostics constrain `CAP-B2`, `CAP-B3`, `CAP-B6`, and `CAP-B8`; verify V1. |
| `wvs342-d4-7b642241-rule-c3` | Local containment control; `produces_resolution_wvs342-d4-7b642241-res-d3_to_rule_wvs342-d4-7b642241-rule-c3`; no request/task before full source validation constrains `CAP-B2`-`CAP-B5`; verify V1. |
| `wvs342-d4-7b642241-rule-c4` | External-owner control; `produces_resolution_wvs342-d4-7b642241-res-d4_to_rule_wvs342-d4-7b642241-rule-c4`; existing owner `workflowd-vs3.4.7`, authority limited to guarded accepted-pointer correction/release and immutable retry; V2 after C1-C3 and before successor exposure. |
| `wvs342-d4-7b642241-rule-c5` | External-owner control; `produces_resolution_wvs342-d4-7b642241-res-d5_to_rule_wvs342-d4-7b642241-rule-c5`; existing owner `workflowd-vs3.4.3`, authority limited to atomic ready persistence after all currentness comparisons; V4 after CAP-D2 codecs and before claims. |
| `wvs342-d4-7b642241-rule-c6` | Local enabling control; `produces_resolution_wvs342-d4-7b642241-res-d6_to_rule_wvs342-d4-7b642241-rule-c6`; exact expected/actual diagnostics are terminal work in `CAP-B7`; verify V3. |
| `wvs342-d4-7b642241-rule-c7` | External-owner control; `produces_resolution_wvs342-d4-7b642241-res-d7_to_rule_wvs342-d4-7b642241-rule-c7`; existing owner `workflowd-vs3.4.3`, authority limited to atomic claim fences; verify V5. |
| `wvs342-d4-7b642241-rule-c8` | External-owner control; `produces_resolution_wvs342-d4-7b642241-res-d8_to_rule_wvs342-d4-7b642241-rule-c8`; existing owner `workflowd-vs3.4.4`, authority limited to pre-exposure/session/custody fences; V6 after C5/C7. |
| `wvs342-d4-7b642241-rule-c9` | External-owner control; `produces_resolution_wvs342-d4-7b642241-res-d1_to_rule_wvs342-d4-7b642241-rule-c9`; existing owner `workflowd-vs3.4.7`, authority limited to monotonic stale/superseded replacement and release; verify V7. |
| `wvs342-d4-7b642241-rule-c10` | Local replay control; `produces_resolution_wvs342-d4-7b642241-res-d2_to_rule_wvs342-d4-7b642241-rule-c10`; ticket FK and outer/nested/source-set identities constrain `CAP-B2` and `CAP-B5`; verify V8. |
| `wvs342-d4-7b642241-rule-c11` | Local replay detection control; `produces_resolution_wvs342-d4-7b642241-res-d3_to_rule_wvs342-d4-7b642241-rule-c11`; durable decode and rehash constrain `CAP-B5` and `CAP-B8`; verify V8. |
| `wvs342-d4-7b642241-rule-c12` | Local replay containment control; `produces_resolution_wvs342-d4-7b642241-res-d4_to_rule_wvs342-d4-7b642241-rule-c12`; no mutable rediscovery or task on bad authority constrains `CAP-B4`, `CAP-B5`, and `CAP-B8`; verify V8. |
| `wvs342-d4-7b642241-rule-c13` | External-owner control; `produces_resolution_wvs342-d4-7b642241-res-d5_to_rule_wvs342-d4-7b642241-rule-c13`; existing owner `workflowd-vs3.4.3`, authority limited to quarantine/data-error and successor Generation routing; verify V9. |
| `wvs342-d4-7b642241-rule-c14` | Local cross-cutting bound; `produces_resolution_wvs342-d4-7b642241-res-d6_to_rule_wvs342-d4-7b642241-rule-c14`; every CAP-D2 crossing in `CAP-B1`-`CAP-B6` and its tests in `CAP-B8` must enforce its owned finite bound; verify V10. |
| `wvs342-d4-7b642241-rule-c15` | Local diagnostic control; `produces_resolution_wvs342-d4-7b642241-res-d7_to_rule_wvs342-d4-7b642241-rule-c15`; preserve Schema/tag/hash/size failures through `CAP-B4`-`CAP-B6`; verify V10. |
| `wvs342-d4-7b642241-rule-c16` | Local containment control; `produces_resolution_wvs342-d4-7b642241-res-d8_to_rule_wvs342-d4-7b642241-rule-c16`; no prepared output before result decode and all bounds, implemented by `CAP-B1`, `CAP-B4`, and `CAP-B6`; verify V10. |
| `wvs342-d4-7b642241-rule-c17` | External-owner control; `produces_resolution_wvs342-d4-7b642241-res-d1_to_rule_wvs342-d4-7b642241-rule-c17`; existing owner `workflowd-vs3.4.4`, authority limited to result retry/new revision and non-advancing failed evidence; verify V11. |
| `wvs342-d4-7b642241-rule-c18` | Local dispatch prevention; `produces_resolution_wvs342-d4-7b642241-res-d2_to_rule_wvs342-d4-7b642241-rule-c18`; exact retained registration selection and private closures constrain `CAP-B4`; verify V12. |
| `wvs342-d4-7b642241-rule-c19` | Local runtime detection; `produces_resolution_wvs342-d4-7b642241-res-d3_to_rule_wvs342-d4-7b642241-rule-c19`; exact Schema decode/bounds and fresh/restart compatibility constrain `CAP-B1`, `CAP-B4`, and `CAP-B8`; verify V12. |
| `wvs342-d4-7b642241-rule-c20` | Local dispatch containment; `produces_resolution_wvs342-d4-7b642241-res-d4_to_rule_wvs342-d4-7b642241-rule-c20`; invoke only selected closures and return only decoded output in `CAP-B4`; verify V12. |
| `wvs342-d4-7b642241-rule-c21` | Local runtime recovery control; `produces_resolution_wvs342-d4-7b642241-res-d5_to_rule_wvs342-d4-7b642241-rule-c21`; active exact versions must remain installed and activation must fail closed, covered by `CAP-B4` and `CAP-B8`; verify V13. |

The external owner assignments are authority boundaries recorded in the accepted graph;
they do not authorize this Structure to create child work, alter those Beads, or claim
their verification evidence exists.

## Informational Node Classification

These source nodes preserve traceability only. None authorizes a capability or task.

| Source node | Classification |
| --- | --- |
| `wvs342-d4-7b642241-src-ticket` | Informational source: ticket artifact |
| `wvs342-d4-7b642241-src-questions` | Informational source: accepted Questions artifact |
| `wvs342-d4-7b642241-src-research` | Informational source: accepted Research artifact |
| `wvs342-d4-7b642241-src-design` | Informational source and decision citation: Design revision 4; decisions, not this source node alone, authorize capabilities |
| `wvs342-d4-7b642241-src-binding` | Informational source: local acceptance binding; records the incomplete scope evidence |
| `wvs342-d4-7b642241-src-ownership` | Informational source: ownership report; not task authority |
| `wvs342-d4-7b642241-src-impact` | Informational source: impact report and control attribution; promoted rule nodes carry controls |
| `wvs342-d4-7b642241-src-synthesis` | Informational source: failed synthesis; its `Fail` outcome is an authority blocker |
| `wvs342-d4-7b642241-src-package` | Informational source: local package manifest; not complete package authority |
| `wvs342-d4-7b642241-src-gate` | Informational source: simulation-only local gate response; not authenticated approval authority |

The exact graph has no domain, boundary, topic, question, service, or service-binding
nodes. It has no residual-risk decision nodes.

## Residual-Risk Carry

The synthesis and impact report describe R1-R5, but the graph does not provide selected,
versioned residual-risk decision nodes. This candidate cannot rewrite them as accepted or
resolved. It carries them as unresolved package constraints pending a conforming package
and complete promotion:

| Risk | Preserved disposition and conditions | Accountable owners and follow-up | Affected capability |
| --- | --- | --- | --- |
| R1 wrong-source assembly | Proposed `NonMaterial` only if C1-C4 and V1-V2 hold; residual is visible rejected/retried assembly, never substituted authority; occurrence remains unknown. | `workflowd-vs3.4.2` and existing owner `workflowd-vs3.4.7`; complete V1-V2 before exposure. | `CAP-B2`, `CAP-B3`, `CAP-B8` |
| R2 stale-authority exposure | Proposed `NonMaterial` only if C5-C9 and V3-V7 hold; residual is a stale mismatch and retry delay; uncertainty remains until downstream evidence exists. | Existing owners `workflowd-vs3.4.3`, `workflowd-vs3.4.4`, `workflowd-vs3.4.7`, with CAP-D2 supplying V3. | `CAP-B7` and every downstream consumer |
| R3 corrupt replay authority | Proposed `NonMaterial` only if C10-C13 and V8-V9 hold; residual is blocked/quarantined work or successor Generation, never substitution. | `workflowd-vs3.4.2` and existing owner `workflowd-vs3.4.3`; complete V8-V9. | `CAP-B5`, `CAP-B8` |
| R4 envelope/result escape | Proposed `NonMaterial` only if C14-C17 and V10-V11 hold; residual is bounded rejection/retry and no invalid prepared output crossing. | `workflowd-vs3.4.2` and existing owner `workflowd-vs3.4.4`; complete V10-V11. | `CAP-B1`, `CAP-B4`, `CAP-B6`, `CAP-B8` |
| R5 wrong trusted dispatch | Proposed `NonMaterial` only if C18-C21 and V12-V13 hold; residual is closed activation or failed operation before task/result escape. | `workflowd-vs3.4.2`; complete V12-V13. | `CAP-B4`, `CAP-B8` |

No monitoring, alert, or runbook duty was accepted as a graph node. The listed follow-up
verification is preserved without fabricating operational evidence.

## Cross-Cutting Constraints

- Ticket authority is first. Technical artifacts retain exact newest-to-oldest accepted
  order, and disabled predecessors may only be omitted without changing relative order.
- Stable provider-instance and repository IDs establish repository authority;
  `repositoryFullName` remains a locator and cannot substitute identity.
- Every pre-read authority mismatch must make zero repository artifact-read calls.
- Retry and restart may reload the exact content-addressed ticket row, but may not reread
  the tracker, a mutable latest path, or the technical repository.
- Canonical hashes prove byte identity, not current authority. CAP-D2 returns pure
  expectations and diagnostics only; existing owners `.3`, `.4`, and `.7` retain all
  ready, claim, exposure, custody, stale, recovery, and progression effects.
- Every source, request, prompt/launch, result, and prepared-output crossing must enforce
  its accepted finite bound and preserve typed diagnostics.
- The catalog is the sole heterogeneous execution seam. No stage-key switch, per-stage
  runner, worker, queue, or store family may be introduced.
- No agent execution, publication, review, gate, Provenance mutation, Plan execution,
  Implementation execution, arbitrary DAG, aggregate capacity, retention, cleanup, or
  readiness subsystem is authorized.

## Required Contract Scenarios

| Scenario | Candidate exercise and result |
| --- | --- |
| New Design revision | If revision 5 is published, every revision-4 report, response, package, promotion, snapshot, capability edge, and this candidate becomes stale. Revision-4 identities cannot be reused. `Pass` as a currentness rule. |
| Uncertain promotion | Human approval without an exact confirmed authoritative result keeps Structure blocked. Recovery must observe before retrying the same deterministic intent. This candidate also remains blocked because a simulation-only request/result cannot repair missing acceptance authority. `Pass` as a blocking rule. |
| Evidence-only graph extension | Later implementation, test, type, schema, commit, monitoring, alert, or runbook links do not stale these capability dependencies if the requirement, decision, control, residual disposition, ownership, meaning, and version remain unchanged. Such links cannot authorize new work. `Pass` as a dependency rule. |
| Approved semantic supersession | Superseding any requirement, D1-D8 decision, C1-C21 control, residual disposition, or ownership edge requires dependency-closure reevaluation of every affected `CAP-B*` edge and downstream Plan output. `Pass` as a reevaluation rule. |

## Exit And Routing

Graph-node classification is complete: 10 informational sources, 6 implementation-bearing
requirements, 8 implementation-bearing decisions, and 21 accepted controls are all
accounted for. Every local obligation has candidate capability coverage, every external
obligation names its existing owner and boundary, and no informational node creates work.

Structure exit is nevertheless blocked. Re-run the Design acceptance seam with complete
immutable `DesignAcceptanceScope` identities, conforming independent reviews and verdicts,
an accepting synthesis, a complete package manifest, an authenticated exact response,
and a non-simulated authoritative promotion result whose selected graph includes every
accepted residual-risk disposition. Only that exact result may release a new Structure
projection. Do not implement from this candidate and do not reinterpret the eight
`ImplementationReady` route assessments as task authority.
