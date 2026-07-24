# Design Acceptance Synthesis, Revision 3

## Outcome

`Accept`

Prepare the exact unchanged Design revision 3 package for the local QRSPI human gate.
The boundary review reports `ScopeClean`, the impact review reports `ImpactReady`, and
neither report requests a Design revision or a human risk decision. This local synthesis
does not approve the Design, accept risk, authenticate a human response, authorize
Provenance promotion, establish authoritative Provenance observation or a graph snapshot,
or release Structure.

## Local Acceptance Scope

| Field | Exact local identity |
| --- | --- |
| Mode | `local-qrispi`, compatibility runner |
| Workflow | `workflowd-workflowd-vs3.4.3:workflowd-vs3.4.3` |
| Generation | `1` |
| Repository base | `50be40c936c696c4030bd2a2cbb6c9a0bdc8f375` |
| WorkflowDefinition | SHA-256 `d29e5e6a9b478b84cb2aef90d46f57c2dace34c84dd60a6d558a50f8b4a6460a` |
| Design | `03-design-discussion-stage-runtime-state.md`, revision `3`, SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`, locally verified |
| Questions source | `01-research-questions-stage-runtime-state.md`, SHA-256 `0230c0957a44461749e9cd57598d1805601f337dc807fbaeec8de267a7e2e0dd`, locally verified |
| Research source | `02-research-stage-runtime-state.md`, SHA-256 `d3bd713578742ccdce8de5a7bf3d00cbc92af88a24db04ae69219a07abde4f98`, locally verified |
| Ordered source set | Questions, then Research; SHA-256 `7a7eea7fceb21095ede2114cfba5ad664922fb2b7e19a9af64e06bfc2585836e` |
| Design policy | `local.design-acceptance@1`, SHA-256 `d29e5e6a9b478b84cb2aef90d46f57c2dace34c84dd60a6d558a50f8b4a6460a` |
| Promotion policy | `local.provenance-promotion@1`, SHA-256 `1d927801f1eb5e32f42f48e423adb8111f12402c26317973bb857394ba9a4010` |
| Structure policy | `local.structure@1`, SHA-256 `7e3df52ceec1b52749745682f9d0dbd2a0a3c7b6640affd913b5958fb94951e6` |
| Boundary policy | `local.design-boundary@1`, SHA-256 `7e211a6e38147b47724e5d6e23198a8556ddbc32863e12ac5815a9892048e83a` |
| Impact policy | `local.impact-risk@1`, SHA-256 `fca8e7391d1a244f5121053474e5dae18ed89faad34cf8ac325ee764e888391b` |
| Binding | `03-design-acceptance-binding-r3.json`, SHA-256 `34d7b9ea9325aa1a4b2f9c9276649e5773c2cb194dfdbad52c9d7648a26a28dd`, locally verified |
| Boundary review | `03-design-boundary-review-r3.md`, SHA-256 `2d9cd8e96b485ea3e899e42632af999c4ce31ded2612444d8a8eca141823a667`, locally verified |
| Impact review | `03-design-impact-risk-review-r3.md`, SHA-256 `4a9439c9d5a333df1537d5067c0c32bf38d982c21da5026fb399082f69ea901c`, locally verified for this synthesis |

The binding pins the impact policy but does not contain an impact-report field. This
compatibility synthesis binds the exact local impact-report path and verified SHA-256
above rather than inventing a production artifact record. Any byte change to the Design,
sources, reports, binding, or any bound identity requires a new local package or review as
applicable.

## Review Synthesis

### Ownership and Boundary

The boundary review found no unresolved clarification and recommends keeping Design
revision 3 unchanged. Its complete scope ledger is preserved:

| Findings | Preserved conclusion |
| --- | --- |
| `C1-C6` | Keep strict historical StageRun and tagged StageRevision records, guarded pointers, implementation steps, exact source sets, and immutable references. |
| `C7-C9` | Keep only the narrow operation, publication-identity, and owner-crossing seams needed by named downstream owners; do not acquire their lifecycles. |
| `C10-C11` | Enforce local constraints in strict SQLite and semantic identity, hashes, transitions, leases, and pointer movement in typed transactions. |
| `C12-C18` | Keep `stage_snapshots_v1` nonclaimable, use one guarded atomic bootstrap into `stage_runtime_v1`, require exact claim ownership, apply every currentness fence, return typed stale, and roll back all dependent effects. |
| `C19-C20` | Allocate monotonic StageRevision replacements without reopening history and keep StageRevision replacement distinct from WorkflowOperation retry. |
| `C21-C25` | Strictly decode and hash-check durable data; use valid operation and aggregate quarantine paths; preserve uncertain-effect evidence and immutable terminal history; fail closed on corrupt immutable authority. |
| `C26-C28` | Use append-only migrations, infer no legacy facts, retain the minimal format fence, and recover exact runtime and diagnostic state after restart. |
| `C29-C30` | Keep all stated neighboring lifecycles out of scope; never reopen terminal history or infer accepted authority from mutable paths or latest-row queries. |
| `C31` | Keep capability-local Schema, real-SQLite, migration, transition, bootstrap, quarantine, history, and restart tests; integrated proof remains with `workflowd-vs3.4.12`. |

All six acceptance-coverage rows remain `Covered` at Design level, subject to
implementation and verification. The named owners remain unchanged:
`workflowd-vs3.4.4` owns producer/session/workspace behavior; `.5` publication; `.6`
TargetReconcile; `.7` run selection and progression; `.8` handoff delivery; `.9` Design
package and Structure release; `.10` runtime composition; `.11` offline legacy recovery;
and `.12` integrated verification.

### Impact and Risk

The `ImpactReady` verdict is preserved without treating it as risk-free. Decisions
`D1-D10`, affected surfaces, risk register `R1-R5`, controls `C1-C12`, verification
obligations `V1-V6`, uncertainty, and excluded speculation remain part of the local gate
package. The reports agree on these required outcomes:

- malformed or contradictory authority fails before use or enters the bounded quarantine path;
- stale work applies no child, pointer, reference, operation, or parent effect;
- placeholders remain nonclaimable until one exact atomic bootstrap;
- quarantine preserves uncertain-effect evidence and custody while releasing no successor or replacement;
- legacy, pre-runtime, partial, and runtime formats remain distinct, and offline legacy recovery finishes before ordinary runtime exposure.

## Ordered Control Obligations

Every control is required. Local gate presentation does not mark any control complete or
waive it.

| ID | Risks | Owner and phase | Obligation |
| --- | --- | --- | --- |
| `C1` | `R1`, `R4` | `workflowd-vs3.4.3`, Implementation | Enforce strict SQL shape, keys, states, and currentness plus strict Schema tag, identity, ordering, and canonical-hash checks before any runtime record is used. |
| `C2` | `R2` | `workflowd-vs3.4.3`, Implementation | Put every applicable Generation, format, run, revision, pointer, source, operation revision, lease, and observation predicate in the same transaction as the state change. |
| `C3` | `R3` | `workflowd-vs3.4.3`, BeforeExposure | Permit executable runtime installation only through the exact guarded `stage_snapshots_v1` bootstrap; reject placeholder authority or effect facts and caller identity mismatch. |
| `C4` | `R1`, `R4` | `workflowd-vs3.4.3`, Runtime | In one guarded transaction, write or recover one bounded diagnostic, abandon the corrupt nonterminal revision, terminate its run as `data_error`, clear pointers and authority, and release no successor or replacement. |
| `C5` | `R4` | `workflowd-vs3.4.3`, Runtime | Preserve intent, observation, commits, and workspace custody for uncertain effects while superseding only safe children and fencing further producer mutation. |
| `C6` | `R5` | `workflowd-vs3.4.3`, BeforeExposure | Classify `legacy`, `stage_snapshots_v1`, `stage_runtime_v1`, and partial or incompatible state explicitly and return exact local diagnostics at read, claim, and preflight boundaries. |
| `C7` | `R1-R4` | `workflowd-vs3.4.3`, Runtime | Return bounded typed data, stale, and incompatible diagnostics at the failing boundary and persist the revision diagnostic when readable corrupt identity exists. |
| `C8` | `R2`, `R3` | `workflowd-vs3.4.3`, Recovery | Reload exact current state after stale, crash, or lost response; retry only by exact identity and return the existing complete bootstrap when it matches. |
| `C9` | `R2`, `R3` | `workflowd-vs3.4.3`, Implementation | Roll back the full transaction when any guarded write affects zero rows or any child or parent write fails. |
| `C10` | `R5` | `workflowd-vs3.4.11`, BeforeExposure | Before ordinary runtime exposure, classify and exactly supersede only bound dormant legacy work, verify the result, then permit ordinary authenticated WorkflowStart to create a successor. |
| `C11` | `R5` | `workflowd-vs3.4.3`, BeforeExposure | Require `stage_runtime_v1` and exact relational revision or step ownership in every stage claimer so unsupported and unowned work remains nonclaimable. |
| `C12` | `R5` | `workflowd-vs3.4.3`, Implementation | Use append-only migrations, preserve shipped legacy Generations and operations byte-for-byte, and infer no run, revision, session, publication, checkpoint, or accepted pointer. |

## Verification Obligations

| ID | Controls | Required evidence |
| --- | --- | --- |
| `V1` | `C1`, `C7` | Real-SQLite metadata and invalid-write cases prove strict shape, keys, foreign keys, unique current rows, and variant association. Malformed, missing, duplicate, reordered, tag, identity, and hash fixtures return exact diagnostics before effect. |
| `V2` | `C2`, `C7-C9` | Every Generation, format, run, state, pointer, revision, source, step, operation, attempt, lease, and observation race returns typed stale, preserves before-state, performs no weaker retry, and reloads exact current state. |
| `V3` | `C3`, `C7-C9` | File-backed tests prove placeholders are unclaimable; authority-bearing placeholders and identity mismatch produce no writes; exact bootstrap installs complete ownership, pointers, and format atomically; duplicate, rollback, crash, lost-response, and reopen cases converge without duplicate history. |
| `V4` | `C4`, `C5`, `C7` | A real-SQLite corruption matrix proves one exact diagnostic, revision `abandoned`, run `data_error`, pointer clearing, safe child and gate disposition, uncertain-effect evidence and custody retention, no replacement or successor, idempotence, stale rollback, terminal immutability, and reopen recovery. |
| `V5` | `C6`, `C7`, `C11`, `C12` | Previous-frontier and current file databases prove append-only schema changes, byte-for-byte legacy preservation, exact format and partial-state diagnostics, and claimability only for complete `stage_runtime_v1` state with exact ownership. |
| `V6` | `C10` | `workflowd-vs3.4.11` system tests prove exact offline preflight, wrong-identity rejection, durable backup/apply/resolve/verify, idempotent bound supersession, unchanged history, normal startup, and authenticated successor kickoff while D3 claims remain closed until verification. |

`V1-V5` are current-ticket acceptance evidence. `V6` is a downstream before-exposure
obligation and is not assumed complete.

## Residual Risks and Dispositions

| Risk | Required controls | Preserved disposition |
| --- | --- | --- |
| `R1` malformed authority | `C1`, `C4`, `C7`; `V1`, `V4` | `NonMaterial` only after the controls pass. No matrix score because implementation-defect frequency is unknown. Corrupt authority must be rejected or contained before effect; trusted content is not reconstructed. |
| `R2` stale advancement | `C2`, `C7-C9`; `V2` | `NonMaterial` only after all-dimension compare-and-set, rollback, and exact reload pass. No matrix score because implementation-defect frequency is unknown. |
| `R3` unsafe bootstrap | `C3`, `C7-C9`; `V3` | `NonMaterial` only after unsupported placeholders remain nonclaimable and complete pre/post-bootstrap recovery is proven. No matrix score. |
| `R4` corrupt aggregate with uncertain effects | `C1`, `C4`, `C5`, `C7`; `V4` | `NonMaterial` for D3 containment only after a valid terminal stall with retained evidence and no successor authority is proven. Future business recovery is not accepted or assumed; uncertainty about its timing remains high. |
| `R5` legacy or partial-format exposure | `C6`, `C10-C12`; `V5`, `V6` | `NonMaterial` only under enforced format containment and the downstream before-exposure sequence. Likelihood remains unknown and uncertainty remains medium until current-ticket and downstream evidence pass. |

The impact report requests no human risk decision. The standing authorization for the
recommended answer therefore has no risk question to resolve and does not waive controls,
verification, uncertainty, ownership, or before-exposure conditions.

## Excluded Speculation

The impact review excludes aggregate SQLite or workspace exhaustion, lack of a QRSPI
status endpoint, malicious direct database writes, and a Provenance graph mismatch because
the evidence or ownership link is absent. These remain exclusions, not accepted risks,
controls, or implementation authority.

## Required Contract Scenarios

| Scenario | Preserved result |
| --- | --- |
| Revision 3 versus revision 2 | Revision 2 reports, decisions, responses, approvals, promotions, and snapshots remain stale and unusable for revision 3. Only the exact revision 3 local inputs above may enter this gate. |
| Uncertain promotion | Human approval alone does not release Structure. Absent, partial, conflicting, or uncertain Provenance publication keeps Structure blocked; workflowd-vs3.9 must authoritatively observe before retrying the same deterministic identities. |
| Evidence-only graph extension | Later implementation, test, type, schema, commit, monitoring, alert, or runbook evidence does not stale Structure when accepted semantic identities, versions, meaning, and authority remain unchanged. |
| Approved semantic supersession | An approved change to an in-scope requirement, rule, decision, control, residual-risk disposition, or ownership edge requires dependency-closure analysis and reevaluation of affected Structure and Plan outputs. |

## Local Gate Recommendation

Present the exact Design, boundary report, impact report, this synthesis, ordered controls,
verification obligations, and conditional residual-risk dispositions as one local package.
The recommended local answer is to approve the unchanged Design for the compatibility
workflow with every listed obligation retained. This recommendation is not itself an
approval and must not be treated as evidence that any implementation control or test has
already passed.

## Production Authority Limitation

This compatibility run uses exact local paths and SHA-256 values plus distinct OpenCode
review invocations as its disclosed evidence. It does not provide production Git-published
`ArtifactReference` identities, durable reviewer records with trusted identity/slot/session,
an authenticated durable gate transport, or canonical production package publication.
Those remain production implementation requirements; this local synthesis neither
fabricates nor substitutes for them.

No authenticated human response, Provenance promotion request or result, authoritative
observation, immutable graph snapshot, or `StructureInput` exists in this invocation.
Accordingly, Design is not authoritatively accepted or promoted and Structure remains
blocked.
