---
task: workflowd-vs3.4.3.1.6-diagnose-document-aggregate-shape-and-identity-contradictions
type: structure-outline
repo: BNasraoui/workflowd
branch: opencode/workflowd-20260725T155332Z-e962fa8e
sha: 5fd5420
---

# Diagnose Document Aggregate Shape and Identity Contradictions

Extend the exact document-aggregate reader completed by `.1.5` with one bounded adversarial slice:
missing required payload/reference/ownership rows, malformed or excess durable JSON, wrong
revision/payload tags, wrong ownership roles or referenced operation kinds, and relational or nested
stage/run/revision identity disagreements. Each real-SQLite fixture begins with the same valid
aggregate, introduces exactly one fault, and receives one exact first `QrspiStoreDataError`; the
reader returns no aggregate or fragment.

This Structure inherits accepted ancestor Design revision 3 at
`.humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md`
(SHA-256 `17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c`),
the accepted parent Structure and split reviews, and the `.1.5` accepted Structure/Plan. It is
anchored to implementation `5fd5420` and changes only the trusted read and its existing
migration-backed SQLite tests.

## Desired End State

- Root rows are selected separately enough to distinguish a missing common revision from a missing
  document payload and to expose a common revision whose `run_ordinal` or tag contradicts the exact
  selector. No current/latest inference is introduced.
- Document and common ownership rows are decoded as separate facts before their identities, owner
  kinds, roles, operation IDs, and role/kind pairings are reconciled. A broken join cannot collapse a
  wrong role or identity into an ambiguous missing aggregate.
- Durable JSON for the activation policy, source projection, prepared Document, and both referenced
  operation envelopes/inputs is parsed and decoded with excess-property rejection. Syntax, shape,
  null-pair, and excess failures retain their owning aggregate or operation record identity.
- Common/document tags, ownership roles, physical operation kinds, common-revision run identity,
  owner identity, artifact identity, operation Generation scope, and exact operation stage scope are
  compared explicitly when an unchanged exact key or surviving exact association reaches the row.
  Those known-but-wrong tags, roles, kinds, and identities are `identity_mismatch`, not generic
  `malformed` errors; loss of every exact association is `missing`.
- A non-null `published_revision` that names the selected revision requires exactly the singular
  artifact row for that revision. When the selected revision is not the published pointer, or the
  pointer is null, zero artifact rows remains valid. This narrow durable fact lets a deleted required
  reference be diagnosed without making the currently optional artifact universally mandatory or
  introducing an artifact list.
- Every failure is returned through `Effect.either` as one `Left`; no row DTO, partially assembled
  candidate, or partially decoded aggregate is exposed. This child does not add before/after row
  snapshots or claim complete non-mutation proof, which remains allocated to `.1.8`.

## Scope Decision and Estimate

`FeatureFit` — the diagnostic classifier, exact loading order, and one-fault real-SQLite matrix are
one reviewable extension of one public reader. Splitting production classification from its evidence
would leave an unproved error contract; broadening it would cross the already allocated sibling
boundaries.

| Human-authored implementation surface | Low | Likely | High |
| --- | ---: | ---: | ---: |
| `src/qrspi/store.ts`: exact root/owner loading seams, explicit classifiers, and stable first-failure order | 95 | 145 | 200 |
| `test/qrspi/store.test.ts`: reusable corrupt-one fixture and missing/malformed/tag-role-kind/identity groups | 155 | 245 | 350 |
| **Total** | **250** | **390** | **550** |

The totals reconcile exactly to the bead's **250 / 390 / 550** allocation. Confidence is medium:
`5fd5420` already supplies the transaction, exact selector, row Schemas, aggregate/operation error
helpers, validators, valid fixture, and final all-or-error decoder. Variance is concentrated in
making broken ownership joins observable without duplicating query logic. This Structure artifact,
generated files, lockfiles, formatting-only churn, and unrelated existing work count as zero.

## Allocation Boundaries

### Owned here

- `missing`: required common revision or document payload, conditionally required published artifact
  reference, document/common ownership row, referenced WorkflowOperation, or any required row moved
  outside every surviving exact association.
- `malformed`: unreadable, wrong-shaped, null-pair, or excess durable JSON/row data at the aggregate or
  referenced-operation boundary.
- `identity_mismatch`: wrong common/document tag, document/common role or owner kind, referenced
  physical operation kind, an exactly discoverable relational run/owner/artifact identity, or nested
  operation scope. A moved row is exactly discoverable only through an unchanged exact key or an exact
  association already loaded from the selected aggregate.
- Exact deterministic precedence among those classes and a `Left`-only no-partial-return assertion in
  every allocated case.

### Preserved for `.1.7`

- No duplicate child/owner/payload cases, no reorder/noncontiguous-ordinal cases, and no new
  `duplicate` or `reordered` classifier.
- Do not sort or normalize source or owner records. Preserve `.1.5`'s source array order and explicit
  produce-before-publish owner order so `.1.7` can test that order directly.
- Do not add or alter canonical source-set, prepared-result, artifact, or operation-input hash
  diagnostics. Fixtures that mutate nested operation identities reserialize and recompute existing
  operation/request hashes so the single intended identity fault reaches this child's classifier.

### Preserved for `.1.8`

- No before/after snapshots, quarantine spy, byte-for-byte non-mutation matrix, WorkflowStart
  regression, public-port inventory, migration/index inactivity inspection, or final combined gate.
- The reader remains select-only and must not call `readStageProduceInput` or `quarantine`, but the
  comprehensive proof of that property remains `.1.8`'s outcome.
- No claim, transition, progression, replacement, bootstrap, quarantine, repair, diagnostic-row
  persistence, external-owner lifecycle, status/readiness, capacity, or legacy behavior.

## Exact Diagnostic Contract

All aggregate failures use `record: "document_stage_revision_aggregate"`, the complete
`workflow/generation/stage/run/revision` `recordId`, and the complete expected identity where an
actual identity is readable. Referenced physical-operation failures use
`record: "workflow_operation"` and that operation ID. Messages remain bounded by the existing
2,000-character `dataError` helper.

Diagnostic discovery never widens aggregate selection. `identity_mismatch` is available only when the
contradictory row remains reachable through an unchanged exact key or a surviving exact association
already authorized by the caller-selected aggregate. If moving a row removes every such association,
the exact lookup sees an absent required row and the result is `missing`. No global, role/history,
nested-scope, path, identifier-proximity, current, maximum, nearest, or latest search may rediscover
it. A contradictory row read through a surviving exact association is diagnostic evidence only and
never contributes to final aggregate assembly.

| Fault | Reason | Stable diagnostic meaning |
| --- | --- | --- |
| Missing common revision | `missing` | `common document revision not found` |
| Missing document payload | `missing` | `document revision payload not found` |
| Missing artifact while `published_revision` names the selected revision | `missing` | `published document artifact reference not found` |
| Missing document/common owner | `missing` | `produce owner not found`, `publish owner not found`, or `common operation owner not found` |
| Document-owner revision key or artifact revision key moved outside every surviving exact association | `missing` | Names the exact required owner role or conditionally required published artifact that was not found; the moved row is not searched for |
| Missing physical operation | `missing` | Existing `aggregate operation not found` on the operation record |
| Malformed/excess aggregate JSON or row | `malformed` | Names activation policy, source projection, prepared result/pair, artifact, or owner boundary |
| Malformed/excess operation scope/input | `malformed` | Existing operation-boundary diagnostic on the operation record |
| Wrong revision/payload tag | `identity_mismatch` | Expected `document`, preserving the readable actual tag in the message |
| Wrong role, owner kind, or operation kind | `identity_mismatch` | Names expected produce/publish pairing and readable actual value |
| Exactly discoverable relational or nested identity disagreement | `identity_mismatch` | Common-revision run ordinal through its unchanged revision key, artifact repository identity through its unchanged revision key, common-owner contradiction through an exact operation ID already loaded from the exact document owner, or operation scope; supplies `expectedIdentity` and `actualIdentity` and never supplies assembly authority; SHA-only definition disagreements retain existing expected/actual SHA fields |

Do not add a new public error class or durable diagnostic row. Small local constructors may stabilize
the messages and expected/actual details while continuing to return `QrspiStoreDataError`.

## Deterministic First-Diagnostic Ordering

The reader must validate in this exact sequence. The one-fault matrix proves each slot independently;
one focused two-fault sentinel may assert precedence only if implementation review needs protection
against query refactoring, and does not expand the contradiction matrix.

1. Strict caller `StageRevisionIdentity` decode before SQL.
2. Exact StageRun cardinality and row shape.
3. Exact common StageRevision cardinality, row shape, requested `run_ordinal`, and `document` tag.
4. Exact document payload cardinality, row shape, and `document` tag.
5. Exact document ownership cardinality in fixed `produce`, then `publish` order. A row whose revision
   key moved outside that sole exact association is missing; do not search for it by role, history, or
   nested operation scope.
6. For each role in that order, common-owner presence followed by document/common identity, owner-kind,
   role, operation-ID, and role/kind agreement.
7. Producer physical operation presence, row shape, persisted Generation scope, kind, strict input,
   and nested exact stage scope; then the same sequence for publication.
8. Producer request source presence, strict source shape, and nested aggregate identity; then strict
   stored source-projection JSON shape. Equality/order/hash checks remain `.1.7`.
9. Strict activation-policy JSON.
10. Prepared-result null pairing and strict Document JSON.
11. When the selected revision equals non-null `published_revision`, exact-key artifact required
    presence, artifact row shape, and relational/repository identity. A moved revision key is missing;
    repository disagreement remains `identity_mismatch` when the unchanged revision key finds the row.
12. Guarded pointer identity and final `decodeDocumentStageRevisionAggregate`; this remains the sole
    successful return path.

The SQL follows the same sequence and uses explicit `ORDER BY CASE operation_role WHEN 'produce'
THEN 0 WHEN 'publish' THEN 1 ELSE 2 END, operation_id`. No identifier ordering, map iteration, query
planner order, `is_current`, maximum, or latest row decides the first diagnostic.

## Implementation Overview

- [ ] Phase 1: Classify Shape and Identity Contradictions Exactly

---

## Phase 1: Classify Shape and Identity Contradictions Exactly

### File Changes

- **`src/qrspi/store.ts`**
  - Replace the root three-table inner join with narrow named selects for the exact StageRun, exact
    common revision, and exact document payload inside the existing transaction. Select the revision
    by caller workflow/Generation/stage/revision, retain its readable `run_ordinal`, and compare it to
    the requested run. This distinguishes missing payload from relational mismatch without a weak or
    latest-row lookup.
  - Decode tag/role/kind columns as bounded strings first, then compare expected literals explicitly.
    Structural unreadability remains `malformed`; a readable wrong literal becomes
    `identity_mismatch`.
  - Load exact document-owner rows in produce/publish order, then load each common owner by exact
    operation ID independently. Reconcile both layers explicitly instead of placing role/owner-kind
    equality in an inner join that erases contradictory rows. The common-owner operation ID is
    authorized only because the exact document-owner row supplied it. If a document-owner revision key
    is moved, no independent association survives: classify the exact role as `missing` and do not scan
    by role, operation history, or nested operation scope.
  - Reuse `loadAggregateOperation`, `validateAggregateProducer`, and
    `validateAggregatePublication`. Keep producer-before-publication evaluation and the internal
    non-mutating path. Add only narrow identity extraction/classification needed before a semantic
    Schema filter would otherwise turn a readable scope disagreement into `malformed`.
  - Keep strict source projection, activation policy, and prepared Document decoders; route each
    failure through a named aggregate diagnostic. Require exactly the singular artifact row only when
    non-null `published_revision` names the selected revision; allow zero rows when the selected
    revision is unpublished. Select the artifact by the exact revision key: a moved revision key is
    `missing`, while repository disagreement is `identity_mismatch` when the unchanged key still finds
    the row. Never search globally, by candidate, nearest, current, or latest artifact.
  - Preserve final aggregate preflight as the sole success return. Do not add mutation, a second
    decoder, migration/Schema changes, or hash/order behavior.

- **`test/qrspi/store.test.ts`**
  - Extend `aggregateFixture` with one helper that creates the valid aggregate, applies exactly one
    SQL mutation, invokes the public reader through `Effect.either`, and asserts exact `_tag`, record,
    record ID, reason, message fragment, and expected/actual details. Each invocation gets a fresh
    file-backed SQLite database.
  - Enable `PRAGMA foreign_keys = OFF` only for the individual corruption write that must violate a
    relationship, and restore it before reading. Use `PRAGMA ignore_check_constraints = ON` only for
    the individual malformed/tag/role write that SQLite correctly rejects on ordinary writes, and
    restore it immediately. Never disable constraints for fixture creation or the read itself.
  - Keep every case one-fault-at-a-time. When operation JSON changes, update only the intended JSON
    field and recompute request/input hashes as necessary so `.1.7` hash checks cannot become the
    first fault.

### Real-SQLite Evidence Groups

1. **Missing required records**
   - Delete the common revision and, independently, the document payload with foreign keys disabled.
     Assert the promised exact common-revision and document-payload diagnostics respectively.
   - Starting from a valid aggregate whose `published_revision` names itself, delete its singular
     artifact reference.
   - Table-drive deletion of the document `produce` owner, document `publish` owner, one matching
      common owner, and one referenced physical operation. Assert the exact owning record and role.
   - With foreign keys disabled for only the corruption write, move one document-owner revision key
     and, independently, the required artifact revision key outside every surviving exact association.
     Assert `missing` from the original exact selector; do not rediscover either row by scanning.
2. **Malformed or excess durable data**
   - Corrupt one JSON boundary at a time: activation policy syntax and excess field; source projection
     syntax and excess child field; prepared Document syntax, excess field, and JSON/hash null-pair;
     producer scope/input excess; publication scope/input excess.
   - Add one malformed scalar row representative (for example an unreadable StageRun currentness or
     artifact field) to prove row-Schema failure remains distinct from readable identity mismatch.
3. **Wrong tag, role, or kind**
   - Change common revision kind and document payload kind independently to a readable wrong tag.
   - Change document-owner role and common-owner role/owner kind independently while retaining the
     same operation ID, then change producer and publication physical operation kinds independently.
   - Assert `identity_mismatch`, expected role/tag/kind, and readable actual value; never accept the
     old inner-join `missing` collapse.
4. **Relational and nested identity contradictions**
   - Move the common revision's `run_ordinal` away from the requested run while retaining its exact
      revision key.
   - Change the artifact repository coordinate while retaining its exact revision key. Change one
     common-owner identity/role/kind coordinate while retaining the exact operation ID previously
     loaded from its exact document-owner relation. These surviving exact associations permit
     `identity_mismatch` details but the contradictory rows remain diagnostic evidence only and never
     enter final assembly.
   - Table-drive producer/publication persisted Generation scope and exact input scope disagreements
      for `workflowId`, `generation`, `stageKey`, `runOrdinal`, and `stageRevision`, rehashing after the
      mutation. Assert exact expected/actual identities.
5. **No partial return (local assertion only)**
   - Every case asserts the public result is exactly `Left` before inspecting its error. No test gains
     access to a candidate aggregate or row DTO. Durable before/after snapshots and quarantine-call
     proof remain `.1.8`.

### Validation

#### Automated Verification

- [ ] `bun test test/qrspi/store.test.ts`
- [ ] `bun test test/qrspi/contracts.test.ts test/qrspi/stage-replay.test.ts test/store/migrations.test.ts`
- [ ] `bun run typecheck`
- [ ] `bun run effect:check`
- [ ] `bun run check`

These are the later Plan/implementation verification commands. This Structure-producing run does not
execute them and does not run A/B or determinism dogfood.

#### Manual Verification

- [ ] Trace the reader in the numbered first-diagnostic order and confirm all queries remain inside
  one exact-selector transaction with no current/latest inference.
- [ ] Confirm known wrong tags/roles/kinds and readable identities are classified explicitly rather
  than erased by joins or reported as malformed.
- [ ] Confirm a moved document-owner or artifact revision key is `missing` when no exact association
  survives, and `identity_mismatch` is emitted only for a row reached through an unchanged exact key or
  an exact association already loaded from the selected aggregate. Confirm no diagnostic row is used
  in final assembly and no global/latest/nearest search exists.
- [ ] Confirm source and owner order are preserved, and no duplicate/reordered/hash mechanism allocated
  to `.1.7` was added.
- [ ] Confirm no mutation proof, WorkflowStart/inactivity proof, quarantine inspection, or combined
  gate allocated to `.1.8` was added.
- [ ] Confirm the only implementation-bearing files are `src/qrspi/store.ts` and
  `test/qrspi/store.test.ts` and the estimate remains **250 / 390 / 550**.

## Resolved Review Decisions

1. **Published artifact presence.** The accepted normative contract at
   `docs/qrspi-contract.md:659-704` defines a `DocumentStageRevision` as having its final
   `ArtifactReference` “when published” and defines publication as the event that sets
   `publishedRevision`. Migration `0011` at `src/store/migrations.ts:932-961` makes that reference
   singular through the artifact table's revision primary key. Therefore exactly the selected
   revision named by non-null `published_revision` requires one artifact row. A selected revision that
   is not that pointer, or a null pointer, may have zero artifact rows.
2. **Moved-row diagnosis.** A moved row is `identity_mismatch` only when an unchanged exact key or a
   surviving exact association already loaded from the caller-selected aggregate still reaches it.
   Thus the common revision's moved run ordinal, artifact repository identity, exact-operation-ID
   common-owner contradiction, and nested operation scopes remain mismatch cases. Moving a document
   owner's revision key or an artifact's revision key destroys its sole aggregate association and is
   `missing`. No role/history, nested-scope, path, identifier-proximity, global, current, maximum,
   nearest, or latest search may guess the moved row as authority; diagnostic evidence never enters
   final assembly.

## Revision Note for Independent r2

- **r1.1:** Desired End State, artifact implementation text, and Resolved Review Decision 1 now cite
  the accepted “when published” contract and migration `0011` singular primary key, and distinguish
  the selected published revision from an unpublished selected revision.
- **r1.2-r1.3:** Allocation Boundaries, owner/artifact implementation text, Evidence Groups 1 and 4,
  and Resolved Review Decision 2 now make moved document-owner/artifact revision keys `missing` while
  retaining only exactly discoverable mismatch cases; the speculative moved-owner operation-ID lookup
  is removed.
- **r1.4:** Exact Diagnostic Contract and precedence slots 5 and 11 now state the surviving-association
  rule, prohibit global/latest/nearest candidate search, and bar contradictory diagnostic rows from
  final assembly.
- **r1.5:** Evidence Group 1 now includes the promised one-fault missing-common-revision fixture.
- **r1.6:** The unchanged surface allocation remains exactly **95/145/200 production + 155/245/350
  test = 250/390/550 total**, with no migration or additional implementation file.
- **r1.7:** Allocation Boundaries, fixture isolation instructions, and Validation retain the `.1.7`
  duplicate/reorder/hash and `.1.8` non-mutation/quarantine/final-gate exclusions, prohibit sorting or
  normalization, require rehashing only to isolate the intended fault, and prohibit mutation,
  lifecycle, repair, or inferred-authority expansion.

The revised Structure is ready for independent r2 Structure scope review. It is not a Plan and makes
no implementation-readiness claim beyond requesting that independent gate.

## Local Authority Limitation

This local Structure inherits the parent outline's confirmed content-addressed compatibility
authority. It does not claim production Provenance publication, authenticated production gate
authority, a production graph root, or production Structure authority. It creates no scope review,
Plan, implementation, commit, or Git push.
