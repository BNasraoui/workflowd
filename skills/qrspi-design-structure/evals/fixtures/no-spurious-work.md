# Accepted Structure input package: telemetry export redaction

This fixture is an accepted Structure input package for the fictional repository
`northwind/telemetry-exporter`, a service that batches product telemetry and ships it to
an external analytics sink. Most of this package is not delivery work: it carries
informational sources, ownership assignments, accepted residual risks, verification
obligations, and one prohibition. Produce the Structure artifact from this fixture alone.

## Binding

| Field                            | Value                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- |
| WorkflowId                       | `northwind/telemetry-exporter:tex-88`                                       |
| Generation                       | `2`                                                                         |
| Accepted Design revision         | `3`                                                                         |
| DesignAcceptancePackage sha256   | `c81f04a7b2e35d9016cf7a48b03d915e27ca6b0498de3172a5f0c8b6e91d4a37`           |
| GateResponse sha256              | `6d20b9e4c7a1358f02be9d17c40a6538fb17e2c09a4d5836be0179ca24f3d580`           |
| Promotion request                | revision `1`, `2af7c105b93e648d07a1cf29b5d3708e46bc1a927f0d5e38ab61c94d07e352f1` |
| Promotion result                 | `9e1c7b06a4d2538f17b0ce49a2d7361f80ba5c14e937d206af5b3c81e40d7692`           |
| Structure policy                 | `workflowd.structure@1`, `d360ea62f9b7e1847c0da5b630af93fd28f98fb7f58e88d7b5f026be5922b85d` |
| Accepted implementation baseline | commit `b0397fa15ce8246d7091ba43fc85210e7d64cb39`                            |
| Approving human                  | Priya Raghavan                                                              |

The pinned graph snapshot is `snapshot://northwind-telemetry-exporter/88/3`, content hash
`ad51c093be7462f18a0d5c37b921ef4608c7a1d5309be2746fc0a8b31d59e027`. There is no
deviation; the snapshot was produced by the confirmed promotion result.

## Accepted graph records

### Informational and authority sources

| Logical ID       | Exact graph ID                | Name                                                                 |
| ---------------- | ----------------------------- | -------------------------------------------------------------------- |
| SRC-ticket       | `tex88-d3-c81f04-src-ticket`  | tex-88 product authority                                             |
| SRC-design       | `tex88-d3-c81f04-src-design`  | Accepted Design revision 3                                           |
| SRC-privacy-memo | `tex88-d3-c81f04-src-privacy` | Legal memo listing the field categories that must never leave the estate |
| SRC-incident     | `tex88-d3-c81f04-src-incident` | Incident report 2026-03-11 on an email address reaching the sink     |
| SRC-benchmark    | `tex88-d3-c81f04-src-benchmark` | Throughput benchmark of the current export pipeline                |

### Accepted requirements

| Logical ID | Exact graph ID             | Statement                                                                                                   |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| AC1        | `tex88-d3-c81f04-req-ac1`  | No telemetry event leaves the estate carrying a field in a category the privacy memo forbids.               |
| AC2        | `tex88-d3-c81f04-req-ac2`  | Redaction runs on every export path, including retries and replays of buffered batches.                     |
| AC3        | `tex88-d3-c81f04-req-ac3`  | Redaction behaviour is provable without contacting the external analytics sink.                             |

### Accepted decisions

| Logical ID | Exact graph ID            | Title                       | Accepted position                                                                                                                                    |
| ---------- | ------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1         | `tex88-d3-c81f04-res-d1`  | Redact at batch assembly    | Apply the existing `redactFields` utility to every event inside the existing `assembleBatch` step, driven by the existing category list in `config/privacy-categories.json`. |
| D2         | `tex88-d3-c81f04-res-d2`  | No sampling subsystem       | Add no sampling, quota, or volume-shaping subsystem, policy, status surface, or owner for export volume in this ticket.                              |

### Accepted ownership assignments

| Logical ID | Exact graph ID            | Title                        | Accepted position                                                                                            |
| ---------- | ------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| O1         | `tex88-d3-c81f04-res-o1`  | Sink credential rotation     | `tex-91` owns analytics-sink credential rotation, retry policy, and outage handling. This ticket changes none of it. |
| O2         | `tex88-d3-c81f04-res-o2`  | Privacy category curation    | The privacy working group owns the contents of `config/privacy-categories.json`. This ticket consumes that file and never edits it. |
| O3         | `tex88-d3-c81f04-res-o3`  | Analytics dashboards         | `analytics-204` owns downstream dashboards that will lose the redacted fields. This ticket makes no dashboard change. |

### Accepted controls

| Logical ID | Exact graph ID             | Name                    | Statement                                                                                                     |
| ---------- | -------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| C1         | `tex88-d3-c81f04-rule-c1`  | Redact before buffering | Redaction happens before an event is written to the durable buffer, so replays cannot resurrect raw fields.   |
| C2         | `tex88-d3-c81f04-rule-c2`  | Fail closed             | An unreadable or malformed category list stops the export path with an explicit error rather than exporting raw events. |
| C3         | `tex88-d3-c81f04-rule-c3`  | No new field access     | The redaction step reads only fields the batch assembler already receives.                                    |

### Accepted verification obligations

| Logical ID | Exact graph ID             | Name                     | Statement                                                                                       |
| ---------- | -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| V1         | `tex88-d3-c81f04-rule-v1`  | Category coverage proof  | Prove every forbidden category is removed for a representative event, using the existing batch fixture. |
| V2         | `tex88-d3-c81f04-rule-v2`  | Replay proof             | Prove a replayed buffered batch contains no forbidden field.                                    |
| V3         | `tex88-d3-c81f04-rule-v3`  | Fail-closed proof        | Prove a malformed category list stops the export path with the declared error.                  |
| V4         | `tex88-d3-c81f04-rule-v4`  | Throughput regression    | Prove batch assembly stays within the recorded throughput budget in the existing benchmark test. |

### Accepted residual-risk dispositions

| Logical ID | Exact graph ID            | Title                       | Accepted disposition                                                                                                            |
| ---------- | ------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| R1         | `tex88-d3-c81f04-res-r1`  | Category list lag           | NonMaterial under C2 and V3. A newly forbidden category is only redacted after the privacy working group publishes it. Follow-up stays with the privacy working group under O2. Accountable human: Priya Raghavan. |
| R2         | `tex88-d3-c81f04-res-r2`  | Historic buffered events    | Accepted with follow-up. Events buffered before this change may still contain forbidden fields. `tex-93` owns the purge of the historic buffer. This ticket creates no purge work. Accountable human: Priya Raghavan. |
| R3         | `tex88-d3-c81f04-res-r3`  | Dashboard breakage          | Accepted. Dashboards that read redacted fields will show gaps. `analytics-204` owns the repair under O3. Accountable human: Priya Raghavan. |

### Accepted edges

Edge IDs follow `<edge_type>_<from_type>_<from_id>_to_<to_type>_<to_id>`.

| From | To  | Edge                                                                                     |
| ---- | --- | ------------------------------------------------------------------------------------------ |
| AC1  | D1  | `needs_requirement_tex88-d3-c81f04-req-ac1_to_resolution_tex88-d3-c81f04-res-d1`          |
| D1   | AC1 | `resolves_resolution_tex88-d3-c81f04-res-d1_to_requirement_tex88-d3-c81f04-req-ac1`       |
| AC2  | D1  | `needs_requirement_tex88-d3-c81f04-req-ac2_to_resolution_tex88-d3-c81f04-res-d1`          |
| D1   | AC2 | `resolves_resolution_tex88-d3-c81f04-res-d1_to_requirement_tex88-d3-c81f04-req-ac2`       |
| AC3  | D1  | `needs_requirement_tex88-d3-c81f04-req-ac3_to_resolution_tex88-d3-c81f04-res-d1`          |
| D1   | AC3 | `resolves_resolution_tex88-d3-c81f04-res-d1_to_requirement_tex88-d3-c81f04-req-ac3`       |
| AC1  | D2  | `needs_requirement_tex88-d3-c81f04-req-ac1_to_resolution_tex88-d3-c81f04-res-d2`          |
| D2   | AC1 | `resolves_resolution_tex88-d3-c81f04-res-d2_to_requirement_tex88-d3-c81f04-req-ac1`       |
| D1   | C1  | `produces_resolution_tex88-d3-c81f04-res-d1_to_rule_tex88-d3-c81f04-rule-c1`              |
| D1   | C2  | `produces_resolution_tex88-d3-c81f04-res-d1_to_rule_tex88-d3-c81f04-rule-c2`              |
| D1   | C3  | `produces_resolution_tex88-d3-c81f04-res-d1_to_rule_tex88-d3-c81f04-rule-c3`              |
| D1   | V1  | `produces_resolution_tex88-d3-c81f04-res-d1_to_rule_tex88-d3-c81f04-rule-v1`              |
| D1   | V2  | `produces_resolution_tex88-d3-c81f04-res-d1_to_rule_tex88-d3-c81f04-rule-v2`              |
| D1   | V3  | `produces_resolution_tex88-d3-c81f04-res-d1_to_rule_tex88-d3-c81f04-rule-v3`              |
| D2   | V4  | `produces_resolution_tex88-d3-c81f04-res-d2_to_rule_tex88-d3-c81f04-rule-v4`              |
| AC1  | R1  | `needs_requirement_tex88-d3-c81f04-req-ac1_to_resolution_tex88-d3-c81f04-res-r1`          |
| R1   | AC1 | `resolves_resolution_tex88-d3-c81f04-res-r1_to_requirement_tex88-d3-c81f04-req-ac1`       |
| AC2  | R2  | `needs_requirement_tex88-d3-c81f04-req-ac2_to_resolution_tex88-d3-c81f04-res-r2`          |
| R2   | AC2 | `resolves_resolution_tex88-d3-c81f04-res-r2_to_requirement_tex88-d3-c81f04-req-ac2`       |
| AC1  | R3  | `needs_requirement_tex88-d3-c81f04-req-ac1_to_resolution_tex88-d3-c81f04-res-r3`          |
| R3   | AC1 | `resolves_resolution_tex88-d3-c81f04-res-r3_to_requirement_tex88-d3-c81f04-req-ac1`       |
| AC1  | O1  | `needs_requirement_tex88-d3-c81f04-req-ac1_to_resolution_tex88-d3-c81f04-res-o1`          |
| O1   | AC1 | `resolves_resolution_tex88-d3-c81f04-res-o1_to_requirement_tex88-d3-c81f04-req-ac1`       |
| AC1  | O2  | `needs_requirement_tex88-d3-c81f04-req-ac1_to_resolution_tex88-d3-c81f04-res-o2`          |
| O2   | AC1 | `resolves_resolution_tex88-d3-c81f04-res-o2_to_requirement_tex88-d3-c81f04-req-ac1`       |
| AC1  | O3  | `needs_requirement_tex88-d3-c81f04-req-ac1_to_resolution_tex88-d3-c81f04-res-o3`          |
| O3   | AC1 | `resolves_resolution_tex88-d3-c81f04-res-o3_to_requirement_tex88-d3-c81f04-req-ac1`       |

## Repository baseline inventory

These are the facts of `northwind/telemetry-exporter` at commit
`b0397fa15ce8246d7091ba43fc85210e7d64cb39`. The lists are complete for the dimensions
they name and state no conclusion.

### Present modules and exported seams

| Path                            | Exports and behaviour that exist at this baseline                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/export/assemble-batch.ts`  | `assembleBatch(events, context)` is the single step that turns queued events into a batch payload. It receives every event field, and its `context` already carries the loaded `privacyCategories` value, which it uses today to stamp the category-list version on each batch. It returns the payload that `writeBatch` persists. |
| `src/export/redact.ts`          | `redactFields(record, categories)` removes fields by category and is already used by the debug-dump command. It has no other caller in the export path.              |
| `src/config/privacy.ts`         | `loadPrivacyCategories()` reads and validates `config/privacy-categories.json` at startup and throws `PrivacyCategoryError` when the file is unreadable or malformed. |
| `src/export/buffer.ts`          | `writeBatch` and `readPendingBatches` over the existing `export_batches` table, used by both the first attempt and the replay path.                                  |
| `src/export/ship.ts`            | `shipBatch(batch)` posts a buffered batch to the analytics sink and handles its retries and uncertain outcomes.                                                      |
| `db/migrations/`                | `0007_export_batches.sql` creates `export_batches`; no migration is pending.                                                                                        |

### Present verification patterns

| Pattern                        | Where it already exists                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Batch assembly fixtures        | `test/export/assemble-batch.test.ts` builds representative event sets and asserts payload contents. |
| Replay tests over the buffer   | `test/export/replay.test.ts` seeds `export_batches` in a real SQLite fixture and replays it.       |
| Config failure tests           | `test/config/privacy.test.ts` asserts `PrivacyCategoryError` for malformed category files.        |
| Throughput benchmark test      | `test/export/throughput.bench.test.ts` asserts assembly stays inside the recorded budget.          |
| Sink transport tests           | `test/export/ship.test.ts` uses a local fake sink; no test contacts the real analytics sink.       |

### Absent at this baseline

- No sampling, quota, or volume-shaping code, configuration, or status surface exists.
- No purge or rewrite path for already-buffered batches exists.
- No dashboard, report, or downstream consumer code lives in this repository.
- No credential rotation code lives in this repository; `shipBatch` reads a credential
  supplied by the deployment environment.
