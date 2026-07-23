---
type: research-questions
---

# Research Questions

1. How does the current `StageContract` and `TrustedStageCatalog` flow work end to end, from registration metadata and Schema hashing through definition validation, erased descriptor resolution, trusted concrete-type restoration, and the existing production and test call sites for contract methods?
2. How are configured stages ordered, normalized, converted into executable snapshots, persisted with contract and harness identities, and revalidated during restart, including the current handling of disabled or custom stages, duplicate identities, reordered snapshots, and registration changes?
3. How are ticket and other source references represented, validated, and resolved today across `domain.ts`, `source-resolver.ts`, repository ports, and adapters, and what identity, byte-reading, precedence, and immutability guarantees does each current source path provide?
4. What request, result, and generic agent-payload Schemas and size limits exist today, where are encoded UTF-8 bounds enforced, and how do Schema, catalog, adapter, and persistence boundaries classify malformed, non-JSON, oversized, missing, or mismatched values?
5. How does the current `WorkflowStart` and `QrspiStore` path construct and persist workflow, Generation, stage-snapshot, and initial `StageProduce` identities, and which exact persisted fields and hashes govern same-input replay, changed-input replacement, transaction completion, and recovery after restart?
6. What distinct document and implementation data shapes already exist in the QRSPI domain, contract documentation, and related tagged-union models, and how are their artifact, checkpoint, revision, repository-target, and revision-intent fields represented and validated today?
7. How do current tests demonstrate catalog extension without stage-specific orchestration, deterministic registration and stage order, typed Schema restoration, durable corruption detection, source resolution, and restart behavior, and which production seams do those tests exercise directly versus only through fixtures?
