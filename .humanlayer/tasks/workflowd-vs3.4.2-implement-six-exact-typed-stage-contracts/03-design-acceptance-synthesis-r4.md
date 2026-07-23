# Design Acceptance Synthesis

## Outcome

`Fail`

This is a non-retryable contract/evidence failure for this synthesis input, not a
Design approval and not a finding that Design revision 4 must change. The Design may be
resubmitted under a complete `DesignAcceptanceScope` with conforming, independently
produced reports. No acceptance package, gate approval, Provenance promotion authority,
promotion result, or graph snapshot is created or inferred here.

## Bound Subject

| Field | Bound value | Synthesis finding |
| --- | --- | --- |
| Workflow | `workflowd-workflowd-vs3.4.2:workflowd-vs3.4.2` | Generation 1 |
| Repository base | `c5a18e27c709facd9bd21c991fccea720a410229` | Local base only; not an `ArtifactReference` |
| Workflow definition | SHA-256 `d29e5e6a9b478b84cb2aef90d46f57c2dace34c84dd60a6d558a50f8b4a6460a` | Present |
| Design | `03-design-discussion-exact-stage-contracts.md`, revision 4, SHA-256 `c89ecc6aeed1b84c93c8bf3bd47baafabcca03ef8f0860653a4bba7d5dbf06ee` | Bound local bytes match |
| Ordered source set | Questions SHA-256 `0852b4845f4d278e1b586899295ef9e7def177651eb1ab7d0c11e097e61b02f2`; Research SHA-256 `935fda4fc687a454c2c1c1120b144877d0706fd6922ea65b2be0b6b6b1f163ce` | Binding declares source-set SHA-256 `4d5be3489fc81aca45e7e34bba0d96bb7261dec4feea1a712695302782ae1ee7` |
| Boundary report | `03-design-boundary-review-r4.md`, SHA-256 `8b1a6db52040851d1eeed6c3952c7bb6e5c6ec768854256881ed2fa9546df4b7` | Bound local bytes match |
| Impact report | `03-design-impact-risk-review-r4.md`, SHA-256 `f5618943015bdbd98c380cdbaee2ce01c1e2a94e78e6eb545afd13e6d87f417b` | Examined; not named by the supplied binding |
| Binding | `03-design-acceptance-binding-r4.json`, SHA-256 `c248e455334ba80374d43b964d057f43c455062abb46d8f2338cf657f91b7449` | Examined as supplied local envelope |
| Review policies | `local.design-boundary@1` / `7e211a6e38147b47724e5d6e23198a8556ddbc32863e12ac5815a9892048e83a`; `local.impact-risk@1` / `fca8e7391d1a244f5121053474e5dae18ed89faad34cf8ac325ee764e888391b` | Present as local review-policy identities |
| Structure policy | `local.structure@1` / `7e3df52ceec1b52749745682f9d0dbd2a0a3c7b6640affd913b5958fb94951e6` | Present and must remain pinned |

## Acceptance Contract Failures

1. The binding does not carry a complete `DesignAcceptanceScope`. Its Design and source
   entries are local paths and SHA-256 values, not complete `ArtifactReference` values
   with repository, Workflow, Generation, stage, revision, commit, path, blob, content,
   and media-type identity.
2. The binding does not name the required Design policy revision/hash and promotion
   policy revision/hash. The local boundary-review and impact-review policy identities
   cannot be reinterpreted as those missing policy identities. The Structure policy is
   present but is not sufficient by itself.
3. Neither report records the trusted reviewer identity, reviewer slot, or session needed
   to prove separation from the producer and from the other reviewer.
4. The boundary report returns `ScopeClean`, not the required semantic-ownership verdict
   `OwnershipReady` or `ReviseDesign`. This synthesis cannot translate verdict enums.
5. The impact report says it examined the ownership report and consumed its `ScopeClean`
   verdict as an entry condition. That verdict is an ownership-review conclusion, so the
   required blind impact review cannot be established from the supplied evidence.
6. The supplied binding predates and does not bind the impact report or this synthesis as
   immutable Git artifacts. Therefore no complete immutable
   `DesignAcceptancePackage` manifest or `packageSha256` can be produced.

These are acceptance-evidence defects. They do not negate the substantive controls below
and do not authorize an in-place patch to an accepted package. A conforming rerun must
bind the same Design revision or a newer exact revision according to currentness rules.

## Review Synthesis

### Preserved Consensus

- Design revision 4 remains within CAP-D2: six exact typed stage contracts, exact source
  assembly, bounded tasks and results, trusted-catalog dispatch, replay codecs, pure
  currentness comparisons, and typed diagnostics.
- Ready persistence, claim and task-exposure fencing, stale/superseded effects, and
  transition-race tests remain owned by `workflowd-vs3.4.3`,
  `workflowd-vs3.4.4`, and `workflowd-vs3.4.7` as assigned.
- The boundary report found all six ticket acceptance criteria covered and reported no
  unresolved scope clarification.
- The impact report found five material pre-control risks: wrong-source assembly,
  stale-authority exposure, corrupt replay authority, envelope/result boundary escape,
  and wrong trusted-contract dispatch.
- The reports support fail-closed controls for those risks. `ImpactReady` means the
  controls and residual risks are explicit; it does not mean risk is absent.
- No supplied evidence authorizes Provenance mutation or asserts an authoritative graph
  snapshot. Structure remains blocked.

### Contested Or Unproven Claims

- Semantic ownership readiness is not established under the required verdict contract,
  despite the boundary report's substantive `ScopeClean` conclusion.
- Reviewer independence is not established because trusted identities, slots, and
  sessions are absent and the impact report consumed the boundary verdict.
- Package identity, gate eligibility, and promotion eligibility are unproven because the
  complete acceptance scope and immutable report/package references are absent.

### Unsupported Speculation Preserved As Excluded

- No credential or private-content leak path is established by the proposed read-only
  artifact operation.
- No evidence shows that missing historical Git objects permanently deadlock active work.
- Repository rename does not substitute authority when stable provider/repository IDs are
  checked.
- No Provenance graph contents or Structure authority may be inferred from the typed
  future graph-reference seam.
- Per-record bounds do not establish aggregate SQLite or workspace capacity.

## Ordered Control Obligations

All controls remain mandatory recommendations. Their presence here does not record human
acceptance or downstream delivery.

| ID | Risk | Owner | Phase | Preserved obligation | Verification |
| --- | --- | --- | --- | --- | --- |
| C1 | R1 | `workflowd-vs3.4.2` | Implementation | Derive predecessor membership/order from trusted snapshots and accepted pointers; check repository, Workflow, Generation, role/stage, accepted revision, and complete final artifact before reads; verify observed commit/path/blob/content after capped reads. | V1 |
| C2 | R1 | `workflowd-vs3.4.2` | Implementation | Return bounded typed source role/index and stable reasons for authority, observation, order, duplicate, malformed, and size failures. | V1 |
| C3 | R1 | `workflowd-vs3.4.2` | Before exposure | Return no encoded input or task until every expected source validates and the ordered reference-array source hash recomputes. | V1 |
| C4 | R1 | `workflowd-vs3.4.7` | Recovery | Correct/release accepted pointers only through guarded progression; retry immutable assembly without redirecting old references. | V2; ship after C1-C3 and before successor exposure |
| C5 | R2 | `workflowd-vs3.4.3` | Before exposure | In the ready transition, atomically compare Generation, snapshots, run/revision, target parent, and all ordered accepted-pointer expectations. | V4; ship after CAP-D2 codecs and before claims |
| C6 | R2 | `workflowd-vs3.4.2` | Structure | Supply pure expected/actual comparisons and typed diagnostics for every currentness predicate. | V3 |
| C7 | R2 | `workflowd-vs3.4.3` | Before exposure | Repeat Generation, operation revision, lease, and current-pointer predicates atomically at claim. | V5 |
| C8 | R2 | `workflowd-vs3.4.4` | Before exposure | Revalidate Workflow, Generation, run/revision, operation, lease, contract, source, and session authority immediately before first task exposure and custody transfer. | V6; ship after C5/C7 |
| C9 | R2 | `workflowd-vs3.4.7` | Recovery | Persist stale/superseded disposition and permit only monotonic current replacement/release. | V7 |
| C10 | R3 | `workflowd-vs3.4.2` | Implementation | Retain ticket revisions by Workflow/hash with Generation foreign-key binding and canonical outer, nested, and source-set hashes. | V8 |
| C11 | R3 | `workflowd-vs3.4.2` | Implementation | On every durable read, decode and recompute outer input, nested request, ordered source set, and ticket semantic identity with exact typed errors. | V8 |
| C12 | R3 | `workflowd-vs3.4.2` | Before exposure | Fail before task/manifest return on missing, corrupt, or cross-scope authority; never reread tracker, latest path, or technical repository on replay. | V8 |
| C13 | R3 | `workflowd-vs3.4.3` | Recovery | Quarantine/data-error corrupt work and route corrected ticket content through a new hash and successor Generation without mutating old work. | V9 |
| C14 | R4 | `workflowd-vs3.4.2` | Implementation | Enforce finite stage-local Schemas and repository-read, source UTF-8, complete-request, configured-input, result, prompt/launch, and global-result bounds; keep the full ticket out of the request. | V10 |
| C15 | R4 | `workflowd-vs3.4.2` | Implementation | Preserve typed Schema, tag, hash, and size diagnostics through catalog and result decoding. | V10 |
| C16 | R4 | `workflowd-vs3.4.2` | Before exposure | Return no prepared Document or ImplementationStep until the selected result Schema and every bound pass. | V10 |
| C17 | R4 | `workflowd-vs3.4.4` | Recovery | Permit retry/new revision only with newly valid bounded output; retain failed output as non-advancing evidence. | V11 |
| C18 | R5 | `workflowd-vs3.4.2` | Implementation | Select one retained trusted registration by exact contract ref/hash; keep closures private; reject lookalikes and stage-key dispatch. | V12 |
| C19 | R5 | `workflowd-vs3.4.2` | Runtime | Decode and bound with the selected registration's exact Schemas and repeat compatibility checks on fresh/restart activation. | V12 |
| C20 | R5 | `workflowd-vs3.4.2` | Before exposure | Invoke only selected assemble/build/prepare closures and return only Schema-decoded prepared output. | V12 |
| C21 | R5 | `workflowd-vs3.4.2` | Runtime | Keep referenced active versions installed and fail closed until the exact registration is restored. | V13 |

## Verification Obligations

| ID | Owner | Required pass evidence |
| --- | --- | --- |
| V1 | `workflowd-vs3.4.2` | Every source membership, order, cross-field, observation, UTF-8, and size failure returns the exact role/index reason; pre-read failures make zero repository calls; valid ordered sources produce the expected hash and request. |
| V2 | `workflowd-vs3.4.7` | Stale, pending, and merely published pointers stay blocked; one corrected accepted pointer produces one matching input; old references never redirect. |
| V3 | `workflowd-vs3.4.2` | One-field, hash-valid wrong-scope fixtures return exact expected/actual reasons for Generation, snapshot, run/revision, parent, and pointer changes; equal inputs pass. |
| V4 | `workflowd-vs3.4.3` | File-SQLite races show every post-assembly predicate change causes zero ready insertion/state change; unchanged input commits once. |
| V5 | `workflowd-vs3.4.3` | A change between ready persistence and claim yields no lease/claim and no claimable stale row; current authority claims once. |
| V6 | `workflowd-vs3.4.4` | A post-claim authority change causes zero prompt calls and zero custody transfer; unchanged current authority proceeds once. |
| V7 | `workflowd-vs3.4.7` | Stale work cannot reopen or advance; only one current monotonic replacement releases one successor after required effects. |
| V8 | `workflowd-vs3.4.2` | Valid restart reproduces request/task authority exactly; each outer, nested, source, or ticket corruption returns its exact error with no tracker/repository read and no task. |
| V9 | `workflowd-vs3.4.3` | Poison data remains immutable and nonclaimable; a new ticket hash creates a distinct current Generation; old work cannot resume. |
| V10 | `workflowd-vs3.4.2` | Exact UTF-8/encoded maxima pass; over-limit, malformed, mistagged, changed-hash, wrong-result, and non-JSON cases fail with stable boundary diagnostics; no invalid prepared output returns. |
| V11 | `workflowd-vs3.4.4` | Invalid output remains non-advancing evidence; one corrected output under current authority transfers custody and releases publication once. |
| V12 | `workflowd-vs3.4.2` | Six-contract order is exact; lookalike/ref/hash/Schema/policy mismatches fail; a seventh registration traverses production assemble/build/prepare with no central dispatch change; only selected closures run. |
| V13 | `workflowd-vs3.4.2` | Missing/changed registration closes activation before claim; exact restoration passes preflight without changing durable snapshots. |

## Residual Risks

These dispositions assume every named control ships and passes its verification. They are
not claims that the risks are absent.

| Risk | Assumed controls | Preserved residual disposition | Owner/follow-up |
| --- | --- | --- | --- |
| R1 wrong-source assembly | C1-C4 | Impact `Minor (2)`, likelihood `Unknown`, no score; residual is visible rejected/retried assembly, not substituted authority. Consequence uncertainty is Low; occurrence uncertainty is Medium. | CAP-D2 and `workflowd-vs3.4.7`; complete V1-V2 before exposure |
| R2 stale-authority exposure | C5-C9 | Impact `Minor (2)`, likelihood `Unknown`, no score; residual is a stale zero-row/mismatch and retry delay. Uncertainty remains Medium until downstream evidence exists. | `workflowd-vs3.4.3`, `.4`, `.7`; complete V3-V7 before exposure/recovery |
| R3 corrupt replay authority | C10-C13 | Impact `Minor (2)`, likelihood `Unknown`, no score; residual is blocked/quarantined work needing retry or successor Generation, never substitution. Fail-closed consequence uncertainty is Low. | CAP-D2 and `workflowd-vs3.4.3`; complete V8-V9 |
| R4 envelope/result escape | C14-C17 | Impact `Minor (2)`, likelihood `Unknown`, no score; residual is bounded rejection/retry and no invalid prepared-output crossing. Blast-radius uncertainty is Low; malformed-output frequency uncertainty is Medium. | CAP-D2 and `workflowd-vs3.4.4`; complete V10-V11 |
| R5 wrong trusted dispatch | C18-C21 | Impact `Minor (2)`, likelihood `Unknown`, no score; residual is closed activation or failed operation before task/result escape. Consequence uncertainty after controls is Low. | CAP-D2; complete V12-V13 |

The impact report classifies all five residual dispositions as `NonMaterial` only under
the listed controls and assumptions. No material residual-risk acceptance was requested.

## Human Decisions

The boundary report requests no clarification, and the impact report's **Human Risk
Decision** is `None`. The authorized recommended future gate answers are:

1. Keep C1-C21 mandatory; do not waive or weaken any control.
2. Accept each R1-R5 `NonMaterial` disposition only if its assumed controls and ordered
   verification obligations remain part of the exact package.
3. Request changes if any control, owner, sequencing condition, verification target,
   residual assumption, or exact identity differs.

These are recommendations for a future complete gate. The current invocation supplies no
authenticated human identity, exact gate revision, complete package hash, or typed
`GateResponse`; therefore the authorization to use recommended answers is not itself an
approval and is not recorded as one.

## Required Contract Scenarios

| Scenario | Result |
| --- | --- |
| Revision 3 versus revision 2 | Pass as a rule: a newer Design revision invalidates all earlier reports, decisions, responses, approval, promotion, and snapshots even when the path is unchanged. This synthesis binds revision 4 only and cannot be reused by revision 5. |
| Uncertain publication recovery | Pass as a rule: approval alone would leave Structure blocked; absent, partial, conflicting, or uncertain publication requires authoritative observation before retry of the same deterministic intents. No promotion evidence exists here. |
| Evidence-only graph extension | Pass as a rule: later implementation, test, type, schema, commit, monitoring, alert, or runbook links do not stale Structure when accepted semantic identities, versions, meaning, and authority are unchanged. No graph state is inferred here. |
| Approved semantic supersession | Pass as a rule: approved change to a requirement, rule, decision, control, residual-risk disposition, or ownership edge requires dependency-closure reevaluation of affected Structure and Plan outputs. |

## Routing

Do not route to Structure, a Design gate, or Provenance promotion from this artifact.
Recreate the acceptance scope with complete immutable identities and all three required
policy identities, then obtain a conforming semantic-ownership report and a blind impact
report with trusted distinct producer/reviewer identities, slots, and sessions. Synthesis
may then run again against that one exact scope. No Design semantic revision is requested
by the substantive findings in the current reports.
