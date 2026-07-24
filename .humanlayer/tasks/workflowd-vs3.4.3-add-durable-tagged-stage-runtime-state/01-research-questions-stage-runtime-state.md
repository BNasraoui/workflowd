---
type: research-questions
---

# Research Questions

1. In `src/qrspi/workflow-start.ts`, `src/qrspi/store.ts`, and `src/store/migrations.ts`, how does WorkflowStart create or recover a workflow, replace the current Generation, preserve prior Generation and WorkflowOperation history, and seed the first stage operations in one durable transition?
2. Across `src/qrspi/domain.ts`, `src/qrspi/contracts/common.ts`, `src/qrspi/stage-catalog.ts`, `docs/qrspi-contract.md`, and `docs/qrspi-stage-runtime-design.md`, what tagged runtime identities, record variants, references, pointers, and relationships exist for workflows, Generations, stage runs, document revisions, implementation revisions, implementation steps, and shared operations?
3. How does the current `workflow_operations` lifecycle represent logical identity, monotonic revisions, current history, retry lineage, leases, external intent and observation, terminal outcomes, and gates, and which SQL and typed-store checks govern each state transition?
4. How do QrspiStore transitions atomically fence mutations against Generation identity, operation identity and revision, currentness, lease authority, and external observations, and how are zero-row updates and stale callers represented and handled today?
5. How are durable QRSPI JSON values decoded and identity-checked at read and transition boundaries, and how do malformed, missing, reordered, duplicate, or hash-mismatched records become typed diagnostics or quarantined `data_error` history without advancing work?
6. What append-only migration, strict-table, partial-index, file-backed upgrade, crash-recovery, and restart-replay patterns do `src/store/migrations.ts`, `test/store/migrations.test.ts`, `test/qrspi/workflow-start.test.ts`, and `test/qrspi/stage-replay.test.ts` currently establish for durable runtime records and immutable current pointers?
