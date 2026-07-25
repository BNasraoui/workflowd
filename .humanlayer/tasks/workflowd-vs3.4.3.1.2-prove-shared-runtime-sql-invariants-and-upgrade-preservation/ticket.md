# Prove shared runtime SQL invariants and upgrade preservation

**Bead:** `workflowd-vs3.4.3.1.2`  
**Type:** task  
**Priority:** P1  
**Status at snapshot:** open

**Labels:** `cap-d3`, `qrspi`, `sqlite`, `stage-runtime`

## Description

## Description

Prove that the inactive shared runtime layout rejects every allocated SQL-local contradiction and that upgrading a real file database from the `0010` frontier preserves all shipped Generation and WorkflowOperation values exactly while inferring no runtime rows. This verification is mandatory for the migration release gate and is not deferred test cleanup.

This child consumes the complete schema from the preceding layout child and completes the migration-side acceptance and risk proof for workflowd-vs3.4.3.1.

## Sources

- Accepted Structure: `.humanlayer/tasks/workflowd-vs3.4.3.1-persist-reload-document-runtime-aggregates/04-structure-outline-document-runtime-aggregates.md`
- Accepted scope review: `.humanlayer/tasks/workflowd-vs3.4.3.1-persist-reload-document-runtime-aggregates/04-structure-scope-review-r1.md`

## Out of Scope

- New production schema beyond corrections required for an allocated invariant to hold.
- Typed document aggregate Schemas or store create/read behavior.
- Runtime allocation, transition, claim, progression, bootstrap, quarantine, or legacy conversion.
- Plan or Implementation before this child completes its own Structure scope review.

## Acceptance Criteria

## Acceptance Criteria

- Direct SQL tests reject invalid tags, cross-variant ownership, duplicate current runs, duplicate owner-crossing keys, duplicate physical-operation ownership, cross-run pointers, malformed JSON, malformed hashes, and invalid ordinals using the strict shared layout.
- A file database built through `0010` retains every existing Generation and WorkflowOperation identity and column value exactly after migration through a fresh layer.
- The upgrade creates zero StageRun, StageRevision, pointer, reference, diagnostic, or ownership rows and performs no inferred legacy conversion.
- Together with the preceding layout child, this child completes A1 preservation and the SQL-local rejection portion of A3 while retaining append-only history, format/cursor guards, FK/index fidelity, and sibling-schema completeness controls.

## Scenarios

### Scenario: Reject one invalid SQL shape

**Given** the complete strict runtime schema and its required parent graph
**When** direct SQL attempts one allocated invalid tag, ownership, pointer, JSON, hash, or ordinal shape
**Then** SQLite rejects the row and leaves the valid graph unchanged

### Scenario: Upgrade the previous frontier exactly

**Given** a file database built through migration `0010` with existing Generation and operation values
**When** a fresh layer applies the current migration
**Then** every old value is unchanged and all runtime tables remain empty

### Scenario: Keep migration verification in the release gate

**Given** the layout child is otherwise complete
**When** this preservation and rejection suite has not passed
**Then** the shared migration outcome is not considered releasable

## Notes

Recursive frontier T1b. Primary file: `test/store/migrations.test.ts`. Provisional changed lines: low 120, likely 210, high 300. Depends on T1a. Exact allocation and coverage: Remainder of T1: A1 preservation and SQL rejection evidence; cannot be deferred or released separately from T1a. Risks retained: SQLite reconstruction, FK/index fidelity, sibling schema completeness. This is not an implementation-ready leaf; an independent Structure scope review is mandatory before Plan.

## Dependencies

- `workflowd-vs3.4.3.1.1`: Install the strict inactive shared runtime layout (blocks)
- `workflowd-vs3.4.3.1`: Persist and reload document runtime aggregates (parent-child)

