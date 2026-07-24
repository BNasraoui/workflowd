# Add durable tagged stage runtime state

**Bead:** `workflowd-vs3.4.3`  
**Type:** task  
**Priority:** P1  
**Status at snapshot:** in_progress

**Labels:** `cap-d3`, `qrspi`, `sqlite`, `stage-runtime`

## Description

## Context

CAP-D3 implements accepted decision D3. WorkflowStart provides the shared workflow operation and Generation foundation, but stage runs, revisions, implementation steps, references, handoffs, reconciliation, and guarded pointers do not yet exist.

## Scope

Add strict tagged domain models and append-only SQLite migrations for StageRun, distinct document and implementation StageRevision records, steps, immutable references, current pointers, diagnostics, and the shared operation relationships required by later capabilities. Extend QrspiStore with Schema-decoded atomic transitions, lease/currentness fencing, stale zero-row detection, quarantine, restart recovery, and immutable terminal history.

## Out of Scope

Stage-specific workers; external owner stores; generic PR reconciliation; status/readiness projection; inferred legacy facts; aggregate capacity control.

## Design

Extend rather than replace WorkflowStart operation patterns. Keep document and implementation records distinct while sharing StageRun and WorkflowOperation identity. Put invariants in both SQL constraints and typed store methods; treat malformed durable JSON as data_error and never advance stale rows.

## Acceptance Criteria

- File-backed migration tests create every required stage runtime record without rewriting shipped legacy rows.
- Domain and SQL constraints enforce one current run/revision where required, immutable history, monotonic replacement, and valid tagged transitions.
- Every state-changing store method rechecks Generation, operation revision, lease, and current pointers atomically.
- Malformed durable data is quarantined with exact diagnostics rather than guessed or advanced.
- Restart tests prove leases, pointers, diagnostics, and uncertain external intent remain recoverable.
- No owner lifecycle, status, or capacity state is introduced.

## Notes

Authority: CAP-D3 / wvs34-d4-bac9e02e-res-d3. Depends on CAP-D1/D2. Likely surfaces: src/qrspi/domain.ts, src/qrspi/store.ts, src/store/migrations.ts, test/qrspi/store.test.ts, test/store/migrations.test.ts. Research-question stage completed: .humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/01-research-questions-stage-runtime-state.md. The query plan covers WorkflowStart/Generation transitions, tagged stage-runtime identities, WorkflowOperation lifecycle and history, atomic fencing and stale detection, durable decoding/quarantine diagnostics, and append-only migration/restart patterns. Bead intentionally remains in progress; Research and later stages were not started. No commit, push, PR, close, or Dolt remote sync performed.
Research stage completed: .humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/02-research-stage-runtime-state.md. The artifact maps WorkflowStart/Generation atomic replacement and recovery, live versus documented stage-runtime identities, workflow_operations history and fencing, durable JSON diagnostics/quarantine, and migration/restart patterns. Independent review found and corrected the distinction between caller-supplied and persisted external observations and narrowed migration-test coverage claims. No open research questions remain. Bead remains in progress; no commit, push, PR, close, or Dolt remote sync performed.
Design discussion accepted through explicit human auto-approval: .humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md (SHA-256 0e4c6a28d4ed01fb066ce507c3b3a1935ea1716dc5dcad4a88eba2bc6790092f). It resolves tagged StageRun/common revision/document/implementation/step boundaries, guarded pointer ownership, shared WorkflowOperation relationships, atomic stale fencing, monotonic replacement, quarantine, append-only migration, legacy-dormant recovery, neighboring ownership seams, and file-backed verification. Bead intentionally remains in progress; no implementation, commit, push, PR, close, or Dolt remote sync performed.
Design discussion revised after boundary review and accepted through explicit human auto-approval: .humanlayer/tasks/workflowd-vs3.4.3-add-durable-tagged-stage-runtime-state/03-design-discussion-stage-runtime-state.md (SHA-256 665887ff21f56b79a8fc28b6c3328175b02e2c21932542e4f49653b108e53cf2). Revision removes CAP-D7 StageRun initialization/progression behavior, limits CAP-D11 legacy handling to D3's fail-closed format seam, and narrows CAP-D6/CAP-D8 integration to publication and owner-crossing identity hooks. All design questions remain resolved. Bead remains in progress; no implementation, commit, push, PR, close, or Dolt remote sync performed.

## Dependencies

- `workflowd-vs3.4`: Run configurable QRSPI stages and publish their artifacts (parent-child)
- `workflowd-vs3.4.1`: Build trusted stage definitions and catalog (blocks)
- `workflowd-vs3.4.2`: Implement six exact typed stage contracts (blocks)

