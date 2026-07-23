# Implement six exact typed stage contracts

**Bead:** `workflowd-vs3.4.2`  
**Type:** task  
**Priority:** P1  
**Status at snapshot:** in_progress

**Labels:** `cap-d2`, `qrspi`, `stage-runtime`

## Description

## Context

CAP-D2 implements accepted decision D2 after the trusted catalog exists. The runtime needs distinct bounded request/result contracts for Questions, Research, Design, Structure, Plan, and Implementation rather than one stringly typed stage shape.

## Scope

Define the six built-in StageContract implementations, their Effect Schemas, exact authority-ordered source envelope, task construction, prepared-output projection, compatibility checks, and deterministic registration. Read artifact sources by exact commit/path/blob identity, verify bytes and hashes, enforce individual and total request bounds, reject duplicates or reordering, and persist exact typed request identity for replay. Preserve distinct document and implementation shapes.

## Out of Scope

Agent execution; publication; review or gate lifecycles; Provenance mutation; Plan execution; Implementation execution; mutable latest-path discovery; aggregate capacity guarantees.

## Design

Use StageCatalog as the single heterogeneous resolution seam. Restore each concrete request/result type with its local Schema. Reuse the existing source resolver and repository adapter patterns, extending them to immutable Git artifact references. Keep common envelopes shared without forcing the six contracts through one false payload shape.

## Acceptance Criteria

- All six built-in contracts resolve in deterministic order and decode distinct bounded request/result shapes.
- Requests bind WorkflowId, Generation, stage identity, exact ordered source bytes/hashes, repository target, and revision intent where applicable.
- Changed, reordered, duplicate, malformed, missing, or oversized sources and results are rejected at Schema or persistence boundaries.
- Ticket and accepted-artifact precedence is deterministic and covered by tests.
- A test contract proves extension without stage-specific orchestrator changes.
- Individual limits are tested without claiming aggregate storage capacity.

## Notes

Authority: CAP-D2 / wvs34-d4-bac9e02e-res-d2. Depends on CAP-D1. Likely surfaces: src/qrspi/contracts/, src/qrspi/stage-catalog.ts, src/qrspi/source-assembly.ts, src/qrspi/source-resolver.ts, src/qrspi/store.ts, src/store/migrations.ts, test/qrspi/contracts.test.ts, test/qrspi/source-assembly.test.ts. Design discussion accepted through explicit human auto-approval: .humanlayer/tasks/workflowd-vs3.4.2-implement-six-exact-typed-stage-contracts/03-design-discussion-exact-stage-contracts.md (SHA-256 5bdedf4f16c47cd8dd9bc3c62410b58c2124c36b3e87c47df67244fa7fb64ae1). It resolves six stage-tagged local Schemas over one ordered exact-source envelope, immutable commit/path/blob/content reads, catalog-contained executable erasure, canonical StageProduce request replay identity, layered per-record bounds, explicit built-in registration order, and registration-only extension tests. Bead intentionally remains in progress; no implementation, commit, push, PR, close, or Dolt remote sync performed.

## Dependencies

- `workflowd-vs3.4.1`: Build trusted stage definitions and catalog (blocks)
- `workflowd-vs3.4`: Run configurable QRSPI stages and publish their artifacts (parent-child)

