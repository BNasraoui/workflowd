# Persist and reload document runtime aggregates

**Bead:** `workflowd-vs3.4.3.1`  
**Type:** task  
**Priority:** P1  
**Status at snapshot:** in_progress

**Labels:** `cap-d3`, `qrspi`, `sqlite`, `stage-runtime`

## Description

## Description

Workflowd has durable WorkflowStart and WorkflowOperation records but no persisted StageRun aggregate that can represent document-stage history and authority without nullable or inferred state. Add the durable schema and typed storage boundary for StageRuns, common StageRevisions, the document revision variant, guarded run pointers, immutable document artifact references, and exact WorkflowOperation ownership. The result must remain inactive until later child tasks add transition and claim behavior.

This child consumes the accepted workflowd-vs3.4.3 Design and establishes the shared append-only schema used by later implementation-aggregate and transition children.

## Out of Scope

- Implementation-stage revision payloads, steps, commit references, and checkpoints.
- Runtime claims, stage progression, revision replacement, bootstrap, or quarantine.
- External owner lifecycles, status/readiness, capacity control, or legacy conversion.

## Acceptance Criteria

## Acceptance Criteria

- Append-only migrations create the complete shared stage-runtime table layout, keys, checks, indexes, Generation cursor columns, and format literals without rewriting shipped legacy rows.
- A valid document StageRun and StageRevision aggregate round-trips through strict typed store methods with exact guarded pointers, immutable artifact references, and WorkflowOperation ownership.
- SQL and Schema boundaries reject invalid tags, variant ownership, duplicate current rows, malformed JSON, invalid ordinals, identity mismatches, reordering, and hash mismatches before any transition.
- The persisted runtime remains inactive: no runtime claim, progression, bootstrap, quarantine, external-owner lifecycle, status, or capacity behavior becomes available.

## Scenarios

### Scenario: Persist a document runtime aggregate

**Given** a current Generation and an exact valid document StageRun aggregate
**When** Workflowd stores and reloads the aggregate
**Then** the run, common revision, document payload, pointers, artifact references, and operation ownership retain their exact identities and order

### Scenario: Reject contradictory tagged state

**Given** durable rows with a wrong variant, duplicate current pointer, malformed JSON, or mismatched identity
**When** Workflowd reads the aggregate
**Then** it returns an exact typed diagnostic and does not expose the rows as trusted runtime state

### Scenario: Keep the new schema inactive

**Given** the document aggregate schema has been installed
**When** an ordinary stage worker looks for claimable runtime work
**Then** no new claim path exists and existing WorkflowStart behavior remains unchanged

## Notes

Post-Structure gate result (single independent skills/structure-scope-reviewer review; no A/B producers or determinism dogfood): SplitFeature. Estimated changed lines: low 1565, likely 2300, high 3210; confidence medium. Exact decomposition: (1) Install the complete inactive shared runtime layout, 620/880/1210, must explicitly allocate both accepted identity hooks and requires its own recursive scope review; (2) Define and atomically round-trip one exact document aggregate, depends on shared layout, 580/850/1150, requires its own recursive scope review; (3) Complete contradictory-state diagnostics and inactivity proof, depends on document round trip, 365/570/850, requires its own recursive scope review. Allocation reconciles exactly to 1565/2300/3210 with no overlap, separate integration allowance, or unallocated work. Rationale: one accepted Design covers one coherent feature, so do not promote, but the independently verifiable schema, document persistence, and trusted-read outcomes plus the 3210-line high estimate make the current child too large for one reviewable diff. Per the gate contract and user instruction, no Plan or implementation was produced. Exact review: .humanlayer/tasks/workflowd-vs3.4.3.1-persist-reload-document-runtime-aggregates/04-structure-scope-review.md. Child Structure: .humanlayer/tasks/workflowd-vs3.4.3.1-persist-reload-document-runtime-aggregates/04-structure-outline-document-runtime-aggregates.md.
Structure stage iterated: .humanlayer/tasks/workflowd-vs3.4.3.1-persist-reload-document-runtime-aggregates/04-structure-outline-document-runtime-aggregates.md. The iteration re-anchors the outline on the inherited accepted ancestor Design (workflowd-vs3.4.3 revision 3, SHA-256 17c3922e7b3143717cd7eda2ab6cece974b255f97a4e7b8ae80ba1fbe6a3ef2c, locally verified byte-for-byte), updates the baseline to f8ad7ad9551d0e3513c6800ca2a83b4c49644951, corrects the previous-frontier migration runner seam (export runStoreMigrationsThrough0010 alongside existing runStoreMigrationsThrough0008), and adds the local-QRSPI compatibility Local Authority Limitation: the confirmed content-addressed local graph export (SHA-256 6550358d90c7f32355ad3943a14ba84fe41f422665da3ba1c65002fdc1073df2) is the explicitly authorized snapshot substitute; no production Provenance publication, authenticated production gate authority, production graph root, or production Structure authority is claimed. Three-phase vertical structure unchanged: (1) install the inactive shared runtime layout, (2) round-trip one exact document aggregate, (3) reject contradictory state and prove inactivity. No size estimate, scope review, child Beads, Plan, or implementation produced; the runner launches the independent post-Structure scope review separately. Bead remains in progress; no commit, push, PR, close, or Dolt remote sync performed.

## Dependencies

- `workflowd-vs3.4.3`: Add durable tagged stage runtime state (parent-child)

