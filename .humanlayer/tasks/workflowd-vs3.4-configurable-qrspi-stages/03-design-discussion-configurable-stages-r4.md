---
type: design-discussion
ticket: workflowd-vs3.4
title: Run configurable QRSPI stages and publish their artifacts
status: proposed
revision: 4
repository_base: 42e129ab75ea0de39aa1bd6db4502325cd3effb1
questions_sha256: 4279e73b21aa25918639d3fbfed8574367d66023a69e6f3b53b60c28c3e24876
research_sha256: c88f48fbdb535bff05557a4007d77b0d2c25c25e0e893412f1a67490b6208701
predecessor_sha256: 1af589c8d7574439985081570690a05cd6d2c1d826b4c15c819b718e6cabc9ac
boundary_review_sha256: 07ff066afa5988cc3f38a223cddc2d1dbc3e8dc255f610eeb833c36619e220d6
impact_review_sha256: 7d92c0ba364702bcbc53981b062b934226806e5a3caa083b0b319afe808f97e6
---

# Design: Configurable QRSPI stages and artifact publication

## Revision 4 response

Revision 4 preserves the implementation-ready stage runtime, publication, currentness,
handoff, Design-route, and legacy-upgrade decisions from revision 3. It removes the
capacity subsystem and operational-status product that the revision 3 boundary review
found outside this ticket.

| Boundary item | Exact revision 4 change |
|---|---|
| C21 | Removed database/workspace capacity limits, recovery reserves, enablement checks, and configuration variables. |
| C22 | Removed aggregate growth estimates, reservations, admission classes, and reserve-aware claim rules. Ordinary payload and diff bounds remain. |
| C23 | Removed the capacity-recovery procedure. Workspace custody cleanup and uncertain-effect observation remain part of ordinary operation recovery. |
| C24 | Removed capacity state and all capacity status fields. No ticket is assigned capacity policy. |
| C29 | Removed the QRSPI status HTTP endpoint and operational-status Effect port. Durable domain records remain directly queryable by their stores and offline commands. |
| C30 | Removed target-reconciliation signal publication. `TargetReconcile` retains complete durable diagnostic fields and its current-ticket lifecycle. |
| C31 | Removed handoff-unavailable signal publication. `waiting_capability` retains complete durable diagnostic fields and same-record recovery. |
| C32 | Removed migration signal publication. Preflight, apply, resolve, and verify return and persist exact diagnostics directly. |
| C33 | Removed status/readiness startup semantics and capacity-class workers. QRSPI still validates before its own activation, fails its ingress closed, and does not prevent unrelated service from running. |
| V1-V3 | Removed capacity admission, capacity signal, and capacity-recovery tests. |
| V10 | Removed the operational-status interface contract test. |
| V4-V9 | Retained their behavioral proofs, with every signal/status assertion removed. |
| R1 | Retained cumulative storage as an explicit unaccepted residual operational risk outside current-ticket authority; no capacity control or owner is invented. |

`workflowd-3d8` owns future operational-status aggregation, presentation, readiness, and
safe retry workflow. It does not own capacity policy and does not own the stage runtime,
publication reconciliation, handoff, or migration lifecycles defined here.

## Decision summary

Workflowd executes the configured linear QRSPI sequence through four trusted boundaries:

1. `StageDefinition` is server-owned serializable policy. It selects stable versioned
   `StageContractRef` and `AgentHarnessRef` values and contains no executable code.
2. `StageCatalog` contains built-in `StageContract` values. A contract owns its request
   and result Schemas, request assembly, task construction, and prepared-output projection.
3. `AgentHarness` executes a trusted task. It may create, resume, and abort a session, but
   cannot publish Git state, mutate a `StageRun`, or select a successor.
4. `WorkflowOperation` and `QrspiStore` own leases, fencing, retries, durable checkpoints,
   publication intent and observation, parent effects, publication-scoped target
   reconciliation, progression, currentness, and recovery.

One generic QRSPI operation loop claims `StageProduce`, `ArtifactPublish`, and the
publication-scoped `TargetReconcile` operations defined here. Dispatch uses operation kind
and the resolved contract, never a central switch over Questions, Research, Design,
Structure, Plan, or Implementation. Review, gate, Provenance, final verification, and
pull-request operation kinds remain with their owners.

The workflow is a fixed linear sequence, not a DAG. Explicit-disabled stages create no
run. A trusted conditional-disabled result creates an immutable skipped run with its policy
identity and reason. Only a succeeded or skipped run releases the next considered stage.
Document and implementation revisions share progression and operation mechanics but retain
different durable shapes. A producer result never advances a run; authoritative publication
and exact neighboring results do.

## Authority and ownership

The merged `docs/qrspi-contract.md` is normative. The current accepted Ticket owns product
meaning, Git owns artifact and implementation bytes, and Workflowd owns operational state
and currentness.

| Ticket | Authority used by this design | Boundary retained |
|---|---|---|
| `workflowd-vs3.1` | Supplies the merged normative contract. | No implementation lifecycle. |
| `workflowd-vs3.2` | Supplies reusable trusted harness and session mechanics. | No StageRun, catalog, or publication ownership. |
| `workflowd-vs3.3` | Supplies current Generation, ticket branch, ticket revision, definition, and cursor. | This ticket changes stage-child creation and executes later stage work. |
| `workflowd-vs3.4` | Owns catalog validation, linear runtime, StageRun/revisions, artifact publication, accepted pointers, publication reconciliation, exact local handoff delivery, Design reentry state effects, promotion-request construction, and next-stage release. | It does not own neighboring lifecycles. |
| `workflowd-vs3.5` | Owns review contributions, Design ownership/impact review, synthesis, budgets, and revision verdicts. | This ticket supplies and consumes exact immutable handoffs only. |
| `workflowd-vs3.6` | Owns gates, gate revisions, authenticated responses, Plannotator, and action delivery. | This ticket applies only an exact typed response effect. |
| `workflowd-vs3.7` | Owns session-link presentation and retention policy. | Session identity here is execution/currentness data. |
| `workflowd-vs3.8` | Owns private artifact presentation. | This ticket creates immutable references but serves no content. |
| `workflowd-vs3.9` | Exclusively owns Provenance mutation, retry, observation, conflict handling, validation, and graph snapshots. | This ticket builds one deterministic request and consumes one confirmed result. |
| `workflowd-vs3.14` | Owns specialized Design route policy, sequencing, semantic classification, closure, affected-output selection, and reentry triggering. | This ticket validates route outputs and applies exact local stage-state effects. |
| `workflowd-3d8` | Owns general operational status, liveness/readiness distinction, terminal-failure presentation, and safe retry workflow. | It does not own the durable QRSPI domain states or any capacity policy. |

## Trusted definitions and catalogs

### StageDefinition

New definitions use stable semantic names; versions remain data:

```ts
type StageContractRef = { readonly name: string; readonly contractVersion: number }
type AgentHarnessRef = { readonly name: string; readonly version: number }

type StageDefinition = {
  readonly key: string
  readonly kind: "document" | "implementation"
  readonly contract: StageContractRef
  readonly activation:
    | { readonly mode: "enabled" | "disabled" }
    | {
        readonly mode: "conditional"
        readonly policyId: string
        readonly policyVersion: number
        readonly decision: "enabled" | "disabled"
        readonly reason: string
      }
  readonly definitionVersion: number
  readonly maxEncodedInputBytes: number
  readonly producer: {
    readonly harness: AgentHarnessRef
    readonly agent: string
    readonly model: string
    readonly timeoutMs: number
    readonly retry: { readonly maxAttempts: number; readonly backoffMs: number }
  }
  readonly outputPolicy:
    | { readonly _tag: "Artifact"; readonly pathTemplate: string; readonly mediaType: string }
    | {
        readonly _tag: "ImplementationCheckpoint"
        readonly contractId: string
        readonly contractVersion: number
      }
  readonly reviewPolicy: StageReviewPolicy
  readonly humanGatePolicy: StageHumanGatePolicy
  readonly designPolicy?: PolicyReference
  readonly promotionPolicy?: PolicyReference
  readonly structurePolicy?: PolicyReference
}
```

The complete normalized stage, including refs, activation result, payload bounds, output
and producer policy, and specialized policy refs, has a `stageDefinitionSha256` under the
same versioned RFC 8785/NFC rules as `workflowDefinitionSha256`. Declaration order remains
in the workflow hash. New definitions contain no `initialOperations`; the runner derives
the producer, blocked publication, and typed parent effects.

One `validateWorkflowDefinition` function performs Schema, cross-field, catalog,
availability, and handoff-capability checks at configuration load, service construction,
Generation creation, restart preflight, and stage activation. It rejects duplicate or
unknown refs and hashes, kind/output incompatibility, unsupported policies or bounds,
unsafe paths, unavailable agent/model selections, invalid activation prerequisites, no
considered stage, skippable Design, and Structure without an earlier non-skippable Design.

Startup resolves every contract and harness referenced by a current new-format Generation.
Registrations remain installed while nonterminal durable work references them. Removing an
active version prevents QRSPI activation before a claim. Preserved legacy rows are not
executable active-version references.

### StageCatalog and AgentHarness

```ts
type StageContract<Request, RequestEncoded, Result, ResultEncoded> = {
  readonly ref: StageContractRef
  readonly kind: "document" | "implementation"
  readonly requestSchema: Schema.Schema<Request, RequestEncoded>
  readonly resultSchema: Schema.Schema<Result, ResultEncoded>
  readonly maxRequestBytes: number
  readonly maxResultBytes: number
  readonly compatibility: (definition: StageDefinition) => void
  readonly assembleRequest: (sources: ExactStageSources) => RequestEncoded
  readonly buildTask: (request: Request) => AgentTask<Result, ResultEncoded>
  readonly prepareOutput: (
    result: Result,
    context: StageExecutionContext,
  ) => PreparedDocumentOutput | PreparedImplementationStepOutput
}
```

`StageCatalog.resolve` is the only erased seam. It decodes generic durable input, resolves
the exact trusted registration, decodes and bounds the nested request, invokes only that
registration's closures, validates the structured result with the same Schema, and returns
a bounded prepared output. Construction rejects bad metadata, generated Schemas, duplicate
refs, substituted object identity, and registration-hash mismatch. Contracts are plain
values in one Effect Layer; no stage gets a Context tag, queue, worker, store family, or
orchestrator branch.

The stage contract builds `AgentTask`; `StageDefinition` supplies harness, agent, model,
timeout, and retry selection. The trusted harness validates availability and executes. It
receives no store, publisher, progression, gate, or repository credential. Existing
`opencode.pr-review@1` and `opencode.pr-fix@1` registrations remain for their durable work;
stage execution uses `opencode@1` without changing PR semantics.

## Built-in contracts and exact inputs

| Stage | Contract ref | Kind | Publication output |
|---|---|---|---|
| Questions | `qrspi.questions@1` | document | Questions artifact |
| Research | `qrspi.research@1` | document | Research artifact |
| Design | `qrspi.design@1` | document | Design artifact and pinned policy identities |
| Structure | `qrspi.structure@1` | document | Coverage artifact bound to accepted package and graph snapshot |
| Plan | `qrspi.plan@1` | document | Plan artifact |
| Implementation | `qrspi.implementation@1` | implementation | Ordered commits and final checkpoint |

Each contract has a distinct request/result Schema and a common source envelope:

```ts
type ExactStageSources = {
  readonly workflowId: string
  readonly generation: number
  readonly stageKey: string
  readonly runOrdinal: number
  readonly stageRevision: number
  readonly stageDefinitionSha256: string
  readonly workflowDefinitionSha256: string
  readonly ticketRevision: TicketRevision
  readonly ticketRevisionSha256: string
  readonly sources: ReadonlyArray<{
    readonly role: "questions" | "research" | "design" | "structure" | "plan"
    readonly artifact: ArtifactReference
    readonly content: string
  }>
  readonly sourceSetSha256: string
  readonly target: {
    readonly repository: RepositoryReference
    readonly headRef: string
    readonly expectedParentSha: string
  }
  readonly revisionReason?: RevisionRequest
}
```

Revision creation reads exact bytes from referenced commit/path, verifies blob and content
hashes, enforces per-source and total encoded bounds, rejects duplicates, orders only
accepted upstream revisions, and persists the complete typed request. The Ticket is first
and is always the highest product authority. Technical context is newest to oldest: Plan,
Structure, Design, Research, Questions. Retry never discovers a mutable latest path or
recomputes its source set.

Questions and Research return bounded stage-specific findings. Design returns decisions,
alternatives, ownership, impacts, controls, residual risks, and citations and pins Design,
promotion, and Structure policies before publication. Structure accepts one matching
package/response/promotion-result/snapshot scope and returns complete authority-backed
coverage. Plan returns bounded authority-linked execution and verification entries.
Implementation returns a non-final prepared commit or a final prepared commit with bounded
ticket-scenario evidence. None contains pull-request identity.

## Durable model

### Identity

```text
StageRunId      = workflowId + generation + stageKey + runOrdinal
StageRevisionId = workflowId + generation + stageKey + stageRevision
StageProduce    = StageRevisionId + optional implementation position + StageProduce
ArtifactPublish = StageRevisionId + optional implementation position + ArtifactPublish
TargetReconcile = workflowId + generation + publication logical ID + publication revision
```

`runOrdinal` starts at 1 and increases only for specialized Design reentry.
`stageRevision` is monotonic per Generation/stage across run ordinals. Operation retry keeps
the logical ID, increments operation revision, and records `retry_of`. A terminal
publication failure creates a new stage revision and publication identity; terminal rows
never reopen.

### Records

Append strict SQLite tables through the existing Effect SQL migration path:

```text
qrspi_stage_definitions
  stage_definition_sha256 PK, workflow_definition_sha256 FK, stage_key,
  sequence_position, definition_json, contract ref and registration hash

qrspi_stage_runs
  workflow_id, generation, stage_key, run_ordinal PK, stage_definition_sha256 FK,
  state, is_current, activation policy, skip reason,
  published_revision, pending_revision, accepted_revision, terminal reason, timestamps

qrspi_stage_revisions
  workflow_id, generation, stage_key, stage_revision PK, run_ordinal FK,
  kind, state, source_set_json, source_set_sha256, timestamps

qrspi_document_stage_revisions
  stage revision PK/FK, produce/publish operation FKs, prepared result,
  artifact reference, review subject

qrspi_implementation_stage_revisions
  stage revision PK/FK, prepared evidence and hash, checkpoint, review subject

qrspi_implementation_steps
  stage revision FK, contiguous position PK, produce/publish operation FKs,
  prepared result, implementation commit reference, final

workflow_operation_agent_executions
  operation ID/revision/attempt PK, launch intent, session reference, structured result,
  state, cleanup state, cleanup diagnostics, timestamps

qrspi_artifact_references / qrspi_implementation_commit_references /
qrspi_implementation_checkpoints
  exact immutable repository, Generation, stage/revision, Git, path, content,
  changed-path, evidence, and checkpoint identities

qrspi_stage_handoffs
  handoff_id PK, workflow/generation/run/revision, capability ref, policy hash,
  subject/request JSON and hashes, state, delivery attempts, last exact error,
  response reference/hash, last observation, required capability, timestamps

qrspi_target_reconciliations
  target operation PK/FK, publication logical ID/revision, workflow/generation/run/revision,
  repository/head ref, expected old, final SHA, observed SHA/evidence, observation hash/time,
  saved parent state, reason, state, resolution identity/result, last exact error, timestamps

qrspi_design_stage_integration / qrspi_design_reentry_applications
  exact acceptance scope, package, response, promotion request, confirmed result/snapshot,
  StructureInput, directive identity/hash, and application receipt only

qrspi_upgrade_manifests
  manifest hash PK, controller/database identity, source schema and migration set,
  complete row classifications and evidence hash, allowed actions, offending identities,
  backup identity/hash, applied schema, verification result, exact error, timestamps
```

The reconciliation, handoff, and upgrade records are queryable domain records. Their
diagnostic fields are required for exact recovery and future consumers, but this ticket
does not aggregate, present, publish, or turn them into readiness. `workflowd-3d8` may later
project them without changing their ownership or lifecycle.

JSON is Effect-Schema decoded on every read and write. SQL checks enforce object/array JSON,
positive ordinals, state literals, hashes, kind-specific nullability, one current run per
stage, one pending revision per run, and operation/reference uniqueness. Cross-record
currentness stays in guarded store transactions, not triggers.

`qrspi_generations` gains nullable `current_stage_key`, `current_stage_run_ordinal`, and
`saved_state_before_reconciliation`. `current_head_sha` remains the sole mutable publication
cursor. StageRun and StageRevision states are exactly the normative contract states.
Historical terminal records remain immutable except explicit audit/currentness fields.

Design integration rows are not review, gate, Provenance, graph, or route lifecycle tables.
Handoff rows are local idempotent delivery receipts, not owner queues. Reentry receipts
contain no graph contents, semantic classification, dependency edges, or route status.

### Operation Schemas

```ts
type StageProduceInput = {
  readonly contractVersion: 1
  readonly scope: GenerationStageRevisionScope
  readonly stageContract: StageContractRef
  readonly stageDefinitionSha256: string
  readonly harness: AgentHarnessSelection
  readonly request: unknown
  readonly requestSha256: string
}

type StageProduceOutput = {
  readonly sessionReference: SessionReference
  readonly prepared: PreparedDocumentOutput | PreparedImplementationStepOutput
  readonly workspaceHandoff: WorkspaceHandoffReference
}

type ArtifactPublishInput = {
  readonly contractVersion: 1
  readonly scope: GenerationStageRevisionScope
  readonly publicationKind: "document" | "implementation_commit"
  readonly candidateCommitSha: string
  readonly expectedParentSha: string
  readonly expectedHeadRef: string
  readonly workspaceHandoff: WorkspaceHandoffReference
  readonly trustedRuntimeAttribution: TrustedRuntimeAttribution
}
```

`GenerationStageRevisionScope` repeats WorkflowId, Generation, target, stage, run,
revision, optional implementation position, definition hashes, ticket hash, and source-set
hash. Prepared output is contract-decoded bounded data before generic persistence. Parent
effects are runner-generated typed values. No terminal child may leave its parent without
claimable work, a durable owner handoff, a reconciliation operation, an operation gate, or
an explicit terminal effect.

## Stage creation and execution

### Generation initialization

After WorkflowStart's final currentness checks, one transaction stores executable stage
snapshots, inserts no run for explicit-disabled stages, inserts terminal skipped runs for
conditional-disabled stages, and inserts blocked runs for all other considered stages in
declaration order. It activates only the first non-skipped run, reserves revision 1,
assembles its exact request, and creates ready `StageProduce` plus blocked
`ArtifactPublish`. Leading skipped stages are walked in order. All skipped takes the
configured terminal path. WorkflowStart succeeds in the same transaction.

Before this transaction, ingress passes definition, catalog, harness, and complete
mandatory-handoff availability guards. Later activation repeats those guards before
creating claimable work. A failed guard leaves the run blocked and creates no producer
session or external intent.

### Producer lifecycle

The generic loop claims a producer under the existing random lease token. It checks exact
Generation, target, run, revision, operation revision, input hash, stage/harness
registration, and branch cursor, then:

1. Prepares an attempt-specific workspace at the expected parent.
2. Decodes the request and persists a bounded launch intent.
3. Creates a native session and persists `SessionReference` before prompting.
4. Resumes only that session and validates the structured result with the contract Schema.
5. Verifies candidate parent, authorized diff, paths, and prepared output locally.
6. In one currentness transaction, stores the result, binds immutable workspace custody
   and candidate SHA to blocked publication, succeeds production, moves the revision to
   publishing, makes publication ready, and fences producer workspace access.

Rollback leaves production incomplete and publication blocked. Retryable local/agent
errors reschedule under policy. Expired attempts get a new token and workspace. Late output
is audit only. Unconfirmed session cleanup prevents replacement. Ordinary cleanup releases
only workspace custody proven terminal or superseded; it never deletes required audit
records or discards a workspace with nonterminal publication or uncertain external state.
The harness never receives publication credentials.

### Artifact publication

`QrspiArtifactPublisher`, separate from `Workspace.publishFix`, provides final-commit
construction, exact-old ref update, and authoritative observation. Before mutation it
verifies custody, exact operation revision, one candidate parent equal to the Generation
cursor, complete authorized diff, no symlink/gitlink/submodule/traversal or `.git` path,
no-follow writes, exact blob/content/media type, removable candidate provenance, and
current scope.

Workflowd builds a final commit from the verified candidate tree with sole parent
`expectedParentSha`, removes candidate provenance trailers, appends trusted trailers in
normative order, and signs with the configured controller key. It persists one final SHA,
signature evidence, exact old SHA, and idempotency identity before remote mutation. A
second SHA is a reconciliation conflict.

The adapter performs exact compare-and-set, fast-forward-only update. Ordinary refspec push
does not qualify. Authoritative observation verifies remote ref, parent, signature,
trailers, operation attribution, blob, and content. The completion transaction rechecks all
currentness, stores observation, advances `current_head_sha`, inserts the immutable
reference, completes publication, updates revision/run pointers, and applies the typed
effect.

For a non-Design document with no review or gate, publication sets published and accepted
pointers, accepts the revision, succeeds the run, and releases the next run. A configured
review or gate sets only its permitted publication/wait state and creates one exact
handoff. Design publication sets only `publishedRevision`, creates its exact acceptance
scope, and remains active.

| Observation after final intent | Publication effect |
|---|---|
| Head is matching `finalSha` | Complete if current; otherwise record stale effect and reconcile. |
| Head is `expectedOld` | Return the same bound publication to ready if current and retry remains. |
| Head is another SHA or final evidence differs | Create/reuse exact `TargetReconcile`; do not advance parent. |
| State is unreadable within budget | Remain `waiting_external`; exhaustion opens the operation-resolution seam. |
| Transport/mutation result is unknown | Observe before any repeated mutation. |

### Implementation and revisions

Implementation uses the same producer/publisher. Confirming a non-final step appends its
contiguous commit reference, advances the cursor, completes its operations, and creates the
next ready producer plus blocked publication rooted at that commit. No next producer exists
before authoritative confirmation. The final step validates bounded scenario evidence,
creates the immutable checkpoint with base/final SHA, ordered commit refs, unioned changed
paths, stable ID, and evidence hash, and forbids another step. Review/finalization consumes
the checkpoint, never a mutable head or PR identity.

A matching review/gate change request or recoverable terminal publication failure abandons
the old pending revision, supersedes its nonterminal work, clears pending/accepted pointers,
reserves the next monotonic revision, reuses exact accepted upstream sources plus the
bounded request, and creates new producer/publication work. A terminal publication is never
replaced in place.

Successful final implementation enters `finalizing`; this ticket creates no finalization
or PR operation. A plan-only configured workflow completes when all considered runs finish.

## Target reconciliation

This ticket owns only reconciliation caused by its artifact publication. It does not claim
generic PR reconciliation or other tickets' external operations.

```ts
type TargetReconcileInput = {
  readonly contractVersion: 1
  readonly workflowId: string
  readonly generation: number
  readonly repository: RepositoryReference
  readonly headRef: string
  readonly publicationLogicalId: string
  readonly publicationRevision: number
  readonly stageRun: StageRunId
  readonly stageRevision: number
  readonly expectedOldSha: string
  readonly finalSha: string
  readonly observedSha: string | null
  readonly observedEvidenceSha256: string
  readonly reason:
    | "conflicting_head"
    | "conflicting_final_evidence"
    | "stale_post_effect"
    | "rollback"
}
```

Conflict/stale detection and creation of one current `TargetReconcile` are atomic. For a
current Generation the transaction stores its prior state, moves it to `reconciling`, keeps
publication nonterminal but unclaimable, and gives reconciliation these parent effects:
restore exact prior state and resume bound publication; supersede and schedule exact
successor WorkflowStart; fail Generation; or audit only for a stale terminal parent. A
workflow-scoped stale-effect reconciliation may reference a superseded Generation but can
never make it current or change its terminal result.

The generic QRSPI loop claims `TargetReconcile`. It performs authoritative read-only
branch/final-evidence observation. It never force-pushes, resets, deletes a ref, chooses a
different final SHA, or weakens a currentness predicate:

| Exact observation/resolution | Atomic result |
|---|---|
| Matching final is head and original publication remains current | Complete bound publication through its original guarded completion; succeed reconciliation and restore prior Generation state. |
| Expected old is head and publication remains current | Succeed reconciliation, restore prior state, and return the same final-SHA publication to ready. |
| A newer current Generation includes matching final in trusted history | Record stale effect as reconciled audit only; old parent remains unchanged. |
| Another head/evidence remains | Persist complete observation and wait for exact `TargetReconcileResolution`; no mutation or parent advance. |
| Observation is unavailable | Retain the same queryable operation and diagnostics; after budget, wait on the same operation-resolution identity. |

The typed resolution is `ObserveAgain`, `ExternalStateRestored(expectedObservedSha)`,
`AcceptChangedTarget(expectedObservedSha)`, or `FailGeneration(reason)`. It binds action ID,
target operation logical ID/revision, all input hashes, and latest observation hash.
`ExternalStateRestored` authorizes observation only, not reset. `AcceptChangedTarget`
reobserves exact head, supersedes the affected current Generation, and creates or schedules
the existing WorkflowStart path to recheck ticket, definition, base, PR absence, and
accepted branch history before a successor. `FailGeneration` is allowed only for a current
nonterminal Generation. Duplicate actions return the same result; stale or mismatched
actions do nothing.

Restart decodes the same operation and observation, then observes before resolution or
publication retry. Pending, waiting, failed, and unclaimable records retain workflow,
Generation, run/revision, publication and reconciliation IDs/revisions, expected old/final/
observed SHAs, observation hash/evidence, reason, state, last error, allowed resolutions,
and timestamps. No row is silently abandoned. This queryability is not a status product.

## Mandatory owner handoffs

`QrspiHandoffCatalog` is a trusted Effect service of local adapters keyed by stable data:

```ts
type OwnerCapabilityRef = {
  readonly owner:
    | "workflowd-vs3.5"
    | "workflowd-vs3.6"
    | "workflowd-vs3.9"
    | "workflowd-vs3.14"
  readonly name: string
  readonly version: number
}
```

Registrations expose `validateAvailability`, idempotent `submit(request)`, and exact
`observe(handoffId)` only. They expose no owner store and do not let this ticket claim owner
work. Definition validation derives the mandatory set:

| Configured path | Mandatory capability refs |
|---|---|
| Automated non-Design review | `.5/qrspi-stage-review@1` |
| Human gate | `.6/qrspi-gate@1` |
| Any Design | `.14/qrspi-design-route@1`, `.5/qrspi-design-review@1`, `.6/qrspi-design-package-gate@1`, `.9/qrspi-provenance-promotion@1` |

Artifact presentation (`.8`) and session presentation (`.7`) are not progression
capabilities and do not gate execution. Reentry is accepted only through the trusted `.14`
route registration; absent reentry delivery cannot invent or trigger local reentry.

Before QRSPI ingress or its operation loop activates, runtime validates mandatory refs for
the configured definition and every current new-format Generation. Missing capability
keeps QRSPI start closed and creates no WorkflowStart/Generation. It does not stop the
general listener or unrelated workers. Before activating each run or creating any new
producer/publication revision, the store repeats the guard. Capability loss therefore
stops new stage effects before the unavailable boundary. Exact already-created handoff
delivery, authoritative observation, reconciliation, and cleanup may continue. These are
QRSPI activation rules, not controller readiness or operational-status semantics.

Crossing a boundary first inserts one `qrspi_stage_handoffs` row with deterministic ID,
capability/policy ref, exact subject/request bytes and hashes, and `pending_delivery`.
Submission uses that ID as idempotency identity. Owner acknowledgement changes only local
delivery state; owner lifecycle results arrive as immutable exact references through the
same handoff. Unavailability moves the row to `waiting_capability` without changing identity
or parent. Restart or restoration resubmits or observes the same row. It never rebuilds a
source set, package, policy, promotion request, directive, or subject. Duplicate result is
idempotent; a mismatch stays blocked.

The row remains queryable with workflow/Generation/run/revision, owner and capability ref,
policy, handoff ID, subject/request hashes, state, attempt and last-observation data, exact
last error, expected result identity, and timestamps. This ticket does not publish or
aggregate that state.

## Review, gate, Design, and Provenance effects

For non-Design review, this ticket supplies exact Generation/run/revision/source/policy and
immutable artifact or checkpoint subject to `.5`. It accepts only a matching typed outcome:
Accept sets accepted and succeeds/releases; Revise creates the next revision; AskHuman
creates exact `.6` handoff; Fail applies stored parent policy. Reviewer slots, blindness,
deadlines, synthesis, and budgets remain `.5`.

For a configured gate, this ticket supplies exact subject, scope, and response policy to
`.6`. It consumes only an authenticated idempotent response matching gate revision, subject,
package where applicable, and scope, then applies the typed local stage effect. It creates
no gate lifecycle, waiting surface, Plannotator process, or response transport and holds no
lease while waiting.

Design never takes generic skip, review acceptance, or gate acceptance. On authoritative
Design publication this ticket pins one `DesignAcceptanceScope` and exposes it to `.14`.
It validates and retains only route-returned ownership report, impact report, synthesis,
and complete package references. It does not order reviews, synthesize, classify, or build
the package.

An exact package-bound approval from `.6` atomically stores the response, sets that Design
revision as `acceptedRevision`, and constructs one deterministic complete
`ProvenancePromotionRequest`. Request changes enters ordinary exact revision creation. The
request accounts for every package semantic item with a selected record intent or typed
exclusion and exact attribution. This ticket submits it through `.9` handoff but does not
mutate, retry, observe, validate, or resolve Provenance.

Only `.9`'s authoritatively confirmed result and graph snapshot matching request, package,
response, scope, completeness, and policy identities let this ticket construct
`StructureInput`, succeed Design, and release the next configured stage. Partial,
conflicting, absent, or uncertain owner outcomes leave Design active and Structure blocked
on the same handoff.

For reentry, `.14` alone observes semantic changes, classifies causes, computes closure,
selects affected outputs, and triggers a bounded `DesignReentryDirective`. This ticket
checks trusted issuer/version/hash, current workflow/Generation/definition/accepted Design,
authority, bounded duplicate-free identities, and named current or historical Structure/
Plan outputs. One idempotent transaction preserves old terminal history, stales only named
outputs, supersedes matching nonterminal work, creates named blocked replacement runs,
creates the next active Design run and monotonic revision from prior accepted inputs plus
the finding, and rewinds the cursor. It neither broadens the set nor repeats semantic
analysis.

## Currentness, failure, and restart

Every durable advance and external intent checks in one SQL transaction: WorkflowId;
current Generation and exact repository/base/head/ticket/definition; allowed Generation
state; run ordinal/state; pending revision/kind/stage/source hashes; implementation
position; operation ID/revision/attempt/unexpired lease token; contract/harness registration;
exact session identity; handoff capability/policy/subject/result identity; and expected old
or bound final remote SHA. Zero affected rows records stale audit or creates reconciliation;
no code retries with a weaker predicate.

Schema/hash/invariant failures with readable identity quarantine the operation/revision as
`data_error`, clear leases, and apply typed failure effect without crashing unrelated
claims. Retryable pre-effect errors reschedule within budget. Unknown external state stays
observable or waits for exact operation resolution. Loss of currentness before effect
supersedes without mutation; loss after effect records stale evidence and reconciles without
parent advance. Duplicate events are audit-only only while authoritative state still
preserves the completed result.

Restart resolves current definitions, contracts, harnesses, and required handoff refs,
decodes every claimed record, and resumes the same durable identity. It observes uncertain
Git state before retry, resumes the same unavailable handoff after capability restoration,
and never claims a legacy child as new-format work. Terminal history never reopens.

## Effect composition and deployment

`makeLiveLayer` adds one trusted `StageCatalog`, the existing harness catalog, one
`QrspiHandoffCatalog`, one `QrspiStageService`, one `QrspiArtifactPublisher`, and expanded
`QrspiStoreLive`. It adds no second DI framework, per-stage service/store family, capacity
port, or operational-status port.

Startup applies schema, validates the configured definition/catalog/harness/handoff set and
current new-format references, then starts the one QRSPI operation loop through the existing
runtime supervision model. QRSPI validation failure prevents QRSPI ingress and new QRSPI
claims with an exact local error; it does not define controller readiness or prevent the
listener and unrelated workers from serving. No status endpoint, signal publication,
status-owned logging contract, or special capacity-class worker is part of this design.

QRSPI configuration remains server-owned. It requires the complete definition, signing
key, stage/harness selections, and owner capability registrations. OpenCode project config
remains disabled. Repository files cannot register prompts, Schemas, agents, models,
contracts, or handoff adapters. Lease validation covers execution timeout plus cancellation
and durable completion. No stage code invokes a pull-request API.

## Migration and offline recovery

Current-base `StageProduce` and `ArtifactPublish` rows have never had an executor, agent
checkpoint, workspace handoff, final-SHA intent, or publication observation. Converting
them into active StageRuns would guess facts. Therefore:

- historical definitions, ticket revisions, WorkflowStart operations, Generations, and
  child operations remain byte-for-byte unchanged;
- no active legacy row receives a StageRun, StageRevision, contract ref, session, handoff,
  publication, accepted pointer, Design integration record, or inferred policy;
- the new claimer requires a new-format StageRevision FK and never claims a legacy row; and
- a legacy current Generation is `legacy_dormant` until exactly superseded. New work begins
  only in a successor Generation created from a fully validated new definition.

The shipped noninteractive operator boundary runs before normal Layer/listener startup:

```text
workflowd qrspi-upgrade preflight --database <path> --output <manifest>
workflowd qrspi-upgrade apply --database <path> --manifest <path> --expected-sha256 <sha>
workflowd qrspi-upgrade resolve --database <path> --manifest <path>
  --workflow-id <id> --expected-generation <n>
  --expected-definition-sha256 <sha> --action supersede
workflowd qrspi-upgrade verify --database <path> --manifest <path>
```

Preflight opens SQLite read-only/query-only, takes a consistent snapshot, and lists every
current Generation plus every current/nonterminal operation. Each row is `new_format`,
`legacy_dormant`, or `incompatible`. `legacy_dormant` requires exact base schema, only
base-created stage inputs, no agent execution/workspace/final intent or observation, and
matching workflow/Generation/definition identities. Unknown kind, malformed readable
payload, partial new-format state, or any claimed external fact is `incompatible`.

The canonical JSON manifest includes controller/database identity, schema and migration
set, every row primary key and input hash, classification and evidence, offending identity,
allowed exact action, and manifest SHA-256. Command output returns the same complete bounded
diagnostics, including exact error and permitted next command. The durable manifest is
queryable, but no status signal or readiness projection is created.

Apply rejects a changed database or manifest. It creates and fsyncs a same-filesystem backup
of database, WAL, and SHM state, verifies the backup opens and matches manifest row hashes,
then performs only append-only table/index/column creation and manifest insertion in one
migration transaction. It performs no legacy conversion. On failure it rolls back and
proves schema/migration IDs and row hashes equal preflight; if SQLite cannot prove that, it
restores and verifies the backup before returning failure. The prior binary can open the
preserved database because existing rows/tables were not rewritten.

An incompatible or dormant workflow blocks only that workflow's QRSPI activation. Offline
`resolve --action supersede` verifies manifest, backup, workflow, Generation, definition,
currentness, and absence of unaccounted external effect. In one transaction it marks only
that Generation and its nonterminal legacy children superseded, clears currentness/leases,
and records the idempotent resolution. It neither deletes history nor creates stage state.
Repetition returns prior result; identity change fails without writes. Normal authenticated
WorkflowStart then rechecks ticket, target, branch, PR absence, and new definition and may
create a successor. No direct SQL, fuzzy mapping, route-state import, or inferred Git/
Provenance state is permitted.

## Verification obligations

The removed V1-V3 and V10 identifiers are intentionally absent. V4-V9 retain their prior
identity so review evidence remains unambiguous:

| ID | Required proof |
|---|---|
| V4 | Real bare/source Git plus file SQLite covers exact-old success, absent, conflict, rollback, stale post-effect, every typed resolution, transaction failure, and restart; no stale parent advances and no weaker or ref-reset mutation occurs. |
| V5 | Forced pending, waiting, failed, and unclaimable reconciliation proves the durable row is directly queryable with workflow, Generation, publication/reconciliation IDs and revisions, expected old/final/observed SHA, evidence hash, reason, exact error, allowed resolution, and timestamps; terminal resolution is recorded exactly once. |
| V6 | Layer/activation tests remove each mandatory `.5/.6/.9/.14` registration in turn; QRSPI ingress/activation fails before child claim/effect, while the complete set starts and unrelated service remains available. |
| V7 | A replaceable owner adapter fails after durable handoff creation, restarts, then restores; the same handoff/request hashes submit once, duplicates are idempotent, mismatch stays blocked, and queryable diagnostics preserve exact identity and error. |
| V8 | Versioned file-database fixtures cover new, dormant legacy, malformed, partial, and injected migration failures; complete manifest and command diagnostics precede writes, no legacy conversion occurs, and failure leaves verified pre-upgrade schema/rows or restored backup. |
| V9 | Recovery drill uses only shipped offline commands; wrong identity/hash fails, exact supersession is idempotent, verification passes, ordinary service starts, and fresh kickoff creates a successor without direct SQL. |

Tests also prove:

- all six built-ins register and resolve; duplicate, unknown, malformed, unavailable,
  incompatible, kind/output/bound/policy/order mismatches fail; hashes are sensitive and
  active new-format versions remain available across restart;
- adding a test built-in needs contract and registration only, with no queue, loop, store
  family, Context tag, or stage switch;
- explicit-disabled creates no run, conditional-disabled creates a reasoned skipped run,
  declaration order is strict, and successor input contains accepted revisions only;
- exact source bytes, order, duplicate rejection, per-record bounds, Ticket authority,
  technical precedence, and complete Structure identity;
- launch before session, session before prompt, result before publication, retry, timeout,
  crash, lease expiry, cleanup fencing, rollback, and stale Generation/run/revision/attempt/
  token/session/source/registration fences;
- real Git sole-parent/diff/path/content checks, trailer rewrite/order, signature, artifact
  identity, one final SHA, exact-old update, crash windows, duplicate and uncertain
  observation, workspace custody cleanup, and immutable later document revisions;
- immediate non-Design acceptance, exact review/gate handoffs and outcomes, accepted-only
  release, cancellation, and newer-Generation supersession;
- Design cannot generic-accept or skip; approval alone cannot release Structure; exact
  package/response creates one promotion request; only exact confirmed result/snapshot
  releases; later revision invalidates prior integration refs;
- `.14` directive fixtures prove bounded reentry effects and idempotency without
  implementing observation, classification, closure, selection, or triggering; and
- every implementation commit is observed before the next producer, final checkpoint has
  exact scenario evidence and no PR identity, and no stage test observes a PR create/update
  call.

Use real SQLite migrations/transactions, custom trusted registrations, full Layer
resolution, and real bare/source Git repositories. Replace only network adapters and clocks
needed to force exact races and uncertainty.

## Acceptance-criterion coverage

| Ticket criterion | Design coverage |
|---|---|
| Validate server-owned ordered definition, refs, policy, and hashes before use | Unified catalog-aware validation, handoff guard, executable snapshots, complete hashes |
| Six built-ins, deterministic order, disabled creates no run | Built-in table and atomic ordered initialization/progression |
| Extend with contract/registration only | One erased catalog seam, one QRSPI loop/store family, no stage switch/tag |
| Stable semantic names; versions as data | Stable refs/types/tables with version fields in hashes |
| Unknown/duplicate/unavailable/incompatible fail early; active versions survive restart | Catalog/capability preflight, activation guard, durable refs, registration retention; dormant legacy is never claimed |
| Bounded Schema-decoded exact input with authority precedence | Distinct Schemas, exact persisted source bytes/refs, source hash, per-record bounds, and authority order |
| Harness executes without stage/Git authority | Task/harness split and store/publisher-owned progression |
| Signed exact-parent publication, exact-old update, uncertain recovery | Dedicated publisher, intent/observation matrix, complete publication-scoped TargetReconcile lifecycle |
| Accepted-only successors and stale-outcome fencing | Run pointers, guarded predicates, exact owner handoffs, revision invalidation, reconciliation, and Design effects |
| No PR during stages | Branch-only publisher, no stage PR capability/operation, negative tests |
| Full test matrix | Catalog, V4-V9, skip, success, retry, restart, stale, version, publication, revision, and checkpoint tests |

## Alternatives rejected

- Eagerly convert active legacy rows: the base never executed those kinds; preservation and
  exact supersession do not invent runtime facts.
- Leave publication conflict for a future general reconciler: exact publication recovery is
  this ticket's acceptance obligation.
- Force-reset a conflicting branch: reconciliation observes and applies explicit exact
  state transitions; it never erases external work.
- Emit mandatory owner handoffs before adapters exist: a durable but unreachable crossing
  deterministically stalls Design and reviewed/gated stages.
- Implement neighboring queues here: capability adapters and exact local receipts suffice;
  owner lifecycles remain `.5`, `.6`, `.9`, and `.14`.
- Add aggregate capacity control to answer cumulative storage risk: the ticket does not
  authorize limits, reserves, reservations, admission classes, recovery policy, or capacity
  status, so revision 4 records the unaccepted risk without inventing a subsystem.
- Add QRSPI operational status here: durable diagnostics are required for recovery, while
  their aggregation, presentation, readiness, and safe retry workflow belong to
  `workflowd-3d8`.
- Per-stage queues/tags/switches, repository plugins/prompts/Schemas, a whole-workflow generic
  type chain, one false revision shape, agent push, ordinary refspec publication, API-success
  completion, mutable-path advancement, approval-only Structure release, local semantic
  route inference, and stage pull requests remain rejected.

## Residual operational risk

The revision 2 impact report's R1 concern remains explicit and unaccepted. Exact source
bytes and audit/revision/execution records accumulate in SQLite, while a workspace remains
in custody while publication or its external effect is nonterminal. Every individual input,
result, diff, diagnostic, and durable JSON record has a configured or global bound, but
those bounds do not cap cumulative database or workspace use. The normative v1 retention
contract performs no automatic deletion of QRSPI audit records. Sustained workflows,
revisions, attempts, or long-lived uncertain publication can therefore exhaust shared
storage and prevent SQLite or Git writes, potentially affecting unrelated controller work.

This ticket has no authority for an aggregate capacity policy. This design adds no limit,
reserve, reservation, admission class, capacity recovery process, status field, deletion
rule, implementation control, or supposed owner. It also does not claim that
`workflowd-3d8` owns capacity policy. Existing per-record bounds and custody rules are facts,
not acceptance of the cumulative risk.

The next independent impact review must decide from this exact revision whether R1 is
material, nonmaterial, or requires a human risk decision. Until then it remains an
unaccepted residual operational risk; no current human decision resolves it.

## Scope and completeness

This design covers every target acceptance criterion and the normative document and
implementation stage, publication, accepted-revision, Design acceptance, currentness,
recovery, retention, and ownership rules. It defines the current-ticket publication
reconciliation, handoff-availability, same-record recovery, and offline-upgrade seams needed
to execute the runtime without taking neighboring lifecycle ownership.

It does not define an arbitrary DAG; repository plugin loader; repository-controlled
prompt, Schema, harness, agent, or model; per-stage worker/tag/store; review or synthesis
lifecycle; gate lifecycle or presentation; specialized Design route policy or sequencing;
semantic graph observation, classification, closure, or affected-output selection;
Provenance mutation or observation; artifact/session presentation; operational-status HTTP
or Effect products; liveness/readiness policy; terminal-work inspect/retry workflow;
capacity policy; audit garbage collection; final verification; PR publication;
Structure/Plan decomposition; Beads mutation; Provenance mutation; or task creation.

No product or implementation choice inside current-ticket authority remains open.
Environment-specific cumulative storage materiality is deliberately not decided here and
remains the unaccepted residual risk above.
