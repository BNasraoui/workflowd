# Install the strict inactive shared runtime layout

**Bead:** `workflowd-vs3.4.3.1.1`  
**Type:** task  
**Priority:** P1  
**Status at snapshot:** open

**Labels:** `cap-d3`, `qrspi`, `sqlite`, `stage-runtime`

## Description

## Description

Create the full append-only post-`0010` migration for the inactive shared stage-runtime relational foundation. Retain a historical runner through `0010`, add the guarded Generation cursor and `stage_runtime_v1` format boundary, and install the strict run, common/tagged revision, implementation-step, immutable-reference, diagnostic, and document/step operation-ownership tables and indexes. Add structural smoke assertions for every table, column, key, foreign key, index, and literal. The schema remains inert and creates no runtime facts.

This child is the first recursive frontier outcome of workflowd-vs3.4.3.1 and supplies the shared layout required by all later frontier children and later stage-runtime siblings.

## Sources

- Accepted Structure: `.humanlayer/tasks/workflowd-vs3.4.3.1-persist-reload-document-runtime-aggregates/04-structure-outline-document-runtime-aggregates.md`
- Accepted scope review: `.humanlayer/tasks/workflowd-vs3.4.3.1-persist-reload-document-runtime-aggregates/04-structure-scope-review-r1.md`

## Out of Scope

- The direct-SQL rejection matrix and exact file-backed upgrade-preservation proof owned by the next child.
- Typed document aggregate Schemas, create/read store methods, and trusted-read diagnostics.
- Runtime allocation, transition, claim, progression, replacement, bootstrap, quarantine, or inferred legacy conversion.
- External-owner lifecycle, status/readiness, or capacity behavior.
- Plan or Implementation before this child completes its own Structure scope review.

## Acceptance Criteria

## Acceptance Criteria

- One append-only migration after `0010` creates the complete strict shared runtime table family, guarded Generation cursor columns, and exact accepted format literals without editing migrations `0001` through `0010`.
- `runStoreMigrationsThrough0010` remains available beside the existing historical runner, and structural tests prove every required table, column, composite key, foreign key, partial index, one-to-one variant boundary, owner-crossing key, publication-operation hook, ownership uniqueness rule, and strict literal/shape check.
- The layout includes all schema-only seams required by implementation and later siblings while adding no trigger, executable claim index, inferred runtime row, or runtime API.
- This child completes the production migration and structural-smoke portion of A1 and preserves the strict tagged-table, same-run-key, unique owner/operation seam, format/cursor guard, append-only history, and inactivity controls.

## Scenarios

### Scenario: Install the complete inactive layout

**Given** a database is at migration frontier `0010`
**When** Workflowd applies the next numbered migration
**Then** every shared stage-runtime table, key, index, cursor, and format rule exists and no runtime row is inferred

### Scenario: Inspect relational authority seams

**Given** the migrated database
**When** tests inspect its SQLite schema
**Then** same-run pointers, tagged payload ownership, owner-crossing identity, publication operation identity, and physical-operation uniqueness are structurally enforced

### Scenario: Keep the schema inert

**Given** the complete shared layout is installed
**When** existing runtime entry points are inspected
**Then** no claim, transition, bootstrap, quarantine, or inferred conversion path has been added

## Notes

Recursive frontier T1a. Primary files: `src/store/migrations.ts`, `test/store/migrations.test.ts`. Provisional changed lines: low 400, likely 590, high 800. Depends on: none. Exact allocation and coverage: Part of T1: all production migration work plus table/column/key/FK/index/literal shape proof; A1 layout and shared-seam controls. Risks retained: SQLite reconstruction, FK/index fidelity, sibling schema completeness. This is not an implementation-ready leaf; an independent Structure scope review is mandatory before Plan.

## Dependencies

- `workflowd-vs3.4.3.1`: Persist and reload document runtime aggregates (parent-child)

