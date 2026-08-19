# Accepted Structure input package: document index result provenance

This fixture is an accepted Structure input package for the fictional repository
`acme/docindex`, a document indexing and search service. Produce the Structure artifact
from this fixture alone. Every graph ID, hash, and repository fact below is exact for this
package; do not look for another repository.

## Binding

| Field                            | Value                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- |
| WorkflowId                       | `acme/docindex:docindex-412`                                                |
| Generation                       | `1`                                                                         |
| Accepted Design revision         | `2`                                                                         |
| DesignAcceptancePackage sha256   | `3f0a91c47d2b8e5641aa07c93de1b2f8c4079ad5e6b31c2f8890ae4471d0c6b2`           |
| GateResponse sha256              | `9c2d5b7e1a4408f36de2c9017b5a44e0f8321cd6b7904e15aa3f26d8017c4e93`           |
| Promotion request                | revision `1`, `71b4e8ac03d5f29617ce4a0b8d3719fe25c6a04b93de817f0a2c5b6e94d31207` |
| Promotion result                 | `52e7c1a90bd3846f27a05e1c9b7d4f83a61e0c25b9743de8017ac5f26b0e9341`           |
| Structure policy                 | `workflowd.structure@1`, `d360ea62f9b7e1847c0da5b630af93fd28f98fb7f58e88d7b5f026be5922b85d` |
| Accepted implementation baseline | commit `7c41ab90de5326f81b04c7ae9f2d1350bb87ec44`                            |
| Approving human                  | Dana Whitfield                                                              |

The pinned graph snapshot is `snapshot://acme-docindex/412/2`, content hash
`04ae7c1b93df526a08e1c7b4d9302f5ab68c14e70d9b3a2517fc8e60ab439d15`. There is no
deviation; the snapshot was produced by the confirmed promotion result.

## Accepted graph records

### Informational and authority sources

| Logical ID    | Exact graph ID              | Name                                    |
| ------------- | --------------------------- | --------------------------------------- |
| SRC-ticket    | `dix412-d2-3f0a91-src-ticket` | docindex-412 product authority        |
| SRC-design    | `dix412-d2-3f0a91-src-design` | Accepted Design revision 2            |
| SRC-support   | `dix412-d2-3f0a91-src-support` | Support transcript on unexplained result ordering |

### Accepted requirements

| Logical ID | Exact graph ID              | Statement                                                                                              |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| AC1        | `dix412-d2-3f0a91-req-ac1`  | Every search result reports the source system it came from and when that document was last indexed.   |
| AC2        | `dix412-d2-3f0a91-req-ac2`  | The two new fields appear in the documented response shape and are proved by response-shape tests.     |

### Accepted decisions

| Logical ID | Exact graph ID             | Title                       | Accepted position                                                                                                                                  |
| ---------- | -------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1         | `dix412-d2-3f0a91-res-d1`  | Derived result provenance   | Compute `sourceSystem` and `indexedAt` inside the existing result assembler from the `source_system` and `indexed_at` columns the search query already selects, and add both to the documented response shape. |

### Accepted controls

| Logical ID | Exact graph ID              | Name                     | Statement                                                                                       |
| ---------- | --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| C1         | `dix412-d2-3f0a91-rule-c1`  | Stable response shape    | Existing response fields keep their names, types, and order; the two new fields are additive.  |
| C2         | `dix412-d2-3f0a91-rule-c2`  | No new query cost        | The change adds no query, no join, and no additional round trip to the search request path.    |

### Accepted verification obligations

| Logical ID | Exact graph ID              | Name                         | Statement                                                                                     |
| ---------- | --------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| V1         | `dix412-d2-3f0a91-rule-v1`  | Response shape proof         | Prove both fields in the existing response-shape test against a real SQLite fixture database. |
| V2         | `dix412-d2-3f0a91-rule-v2`  | Backward compatibility proof | Prove existing consumers still decode responses that contain the additional fields.           |

### Accepted residual-risk dispositions

| Logical ID | Exact graph ID             | Title                        | Accepted disposition                                                                                                    |
| ---------- | -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| R1         | `dix412-d2-3f0a91-res-r1`  | Stale index timestamp        | NonMaterial under C1 and V1. Rows written before the backfill of 2026-04 report an approximate `indexed_at`. Accountable human: Dana Whitfield. No follow-up ticket. |

### Accepted edges

Edge IDs follow `<edge_type>_<from_type>_<from_id>_to_<to_type>_<to_id>`.

| From                       | To                         | Edge                                                                                                                  |
| -------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| AC1                        | D1                         | `needs_requirement_dix412-d2-3f0a91-req-ac1_to_resolution_dix412-d2-3f0a91-res-d1`                                     |
| D1                         | AC1                        | `resolves_resolution_dix412-d2-3f0a91-res-d1_to_requirement_dix412-d2-3f0a91-req-ac1`                                  |
| AC2                        | D1                         | `needs_requirement_dix412-d2-3f0a91-req-ac2_to_resolution_dix412-d2-3f0a91-res-d1`                                     |
| D1                         | AC2                        | `resolves_resolution_dix412-d2-3f0a91-res-d1_to_requirement_dix412-d2-3f0a91-req-ac2`                                  |
| D1                         | C1                         | `produces_resolution_dix412-d2-3f0a91-res-d1_to_rule_dix412-d2-3f0a91-rule-c1`                                         |
| D1                         | C2                         | `produces_resolution_dix412-d2-3f0a91-res-d1_to_rule_dix412-d2-3f0a91-rule-c2`                                         |
| D1                         | V1                         | `produces_resolution_dix412-d2-3f0a91-res-d1_to_rule_dix412-d2-3f0a91-rule-v1`                                         |
| D1                         | V2                         | `produces_resolution_dix412-d2-3f0a91-res-d1_to_rule_dix412-d2-3f0a91-rule-v2`                                         |
| AC1                        | R1                         | `needs_requirement_dix412-d2-3f0a91-req-ac1_to_resolution_dix412-d2-3f0a91-res-r1`                                     |
| R1                         | AC1                        | `resolves_resolution_dix412-d2-3f0a91-res-r1_to_requirement_dix412-d2-3f0a91-req-ac1`                                  |

## Repository baseline inventory

These are the facts of `acme/docindex` at commit
`7c41ab90de5326f81b04c7ae9f2d1350bb87ec44`. The lists are complete for the dimensions
they name and state no conclusion.

### Present modules and exported seams

| Path                            | Exports and behaviour that exist at this baseline                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/search/assemble-result.ts` | `assembleSearchResult(row, highlights)` builds every field of the documented `SearchResult` response object. It already receives the full selected row.        |
| `src/search/query.ts`           | `runSearchQuery(client, request)` issues one SQL statement that selects `id, title, snippet, rank, source_system, indexed_at` from `documents`.                 |
| `src/search/contract.ts`        | `SearchResult` and `SearchResponse` schema declarations, and the documented response shape used by the public HTTP handler.                                     |
| `src/http/search-handler.ts`    | the HTTP route that calls `runSearchQuery` then `assembleSearchResult`, with no other transformation.                                                           |
| `db/migrations/`                | `0001_documents.sql` creates `documents` with columns `id, title, body, snippet, rank, source_system, indexed_at, tenant_id`; `0002_documents_rank_index.sql` adds an index. Both are applied in every environment. |

### Present verification patterns

| Pattern                             | Where it already exists                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| Response-shape assertions           | `test/search/response-shape.test.ts` asserts every documented field of `SearchResponse`.      |
| Real SQLite fixture database        | `test/support/fixture-db.ts` seeds `documents` rows, including `source_system` and `indexed_at`. |
| Consumer decode compatibility tests | `test/search/consumer-decode.test.ts` decodes recorded responses with the published client.   |

### Absent at this baseline

- No other module reads or writes `documents.source_system` or `documents.indexed_at`.
- No backfill job, cache, or projection of those columns exists.
- No pending or planned migration touches the `documents` table.
