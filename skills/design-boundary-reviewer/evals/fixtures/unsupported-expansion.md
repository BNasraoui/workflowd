# Evaluation Fixture: Unsupported Expansion

## Source Snapshot Metadata

| Source | Revision | Completeness |
| --- | --- | --- |
| Current ticket | `reports-410@fixture-1` | Complete, including task, acceptance criteria, and out-of-scope statements |
| One-hop issue graph | `reports-410-graph@fixture-1` | Complete, including parent, dependencies, dependents or blockers, and relevant siblings |
| Accepted Questions | `reports-410-questions@fixture-1` | Complete; the ticket records no accepted Questions |
| Accepted Research | `reports-410-research@fixture-1` | Complete |
| Draft Design | `reports-410-design@fixture-1` | Complete |
| Architecture references | `reports-preview-architecture@fixture-1` | Complete for the cited preview boundary |

## Current Ticket

ID: `reports-410`

Title: Render immutable report preview images

Task:

- Render one accepted report revision as a deterministic PNG preview.
- Publish the preview as an immutable artifact.

Acceptance criteria:

- The preview uses fixed dimensions and deterministic fonts.
- The artifact identity includes the accepted report revision and content hash.
- Rendering does not create user preferences or management APIs.

Out of scope:

- User preference storage, preview preset management, and administrative APIs.

## Parent

`reports-400`: Export accepted reports in several immutable formats. It does not include
user preference management.

## Dependencies

- `reports-409` (closed): Captures immutable accepted report revisions.

## Dependents and Blockers

- `reports-411`: Display preview artifacts in the report UI. It consumes a preview
artifact identity but does not own rendering or preference management.

## Relevant Siblings

- `reports-412`: Render immutable PDF exports. It is irrelevant to PNG behavior and does
not own user preferences.

## Accepted Questions

Confirmed absent in the complete ticket snapshot.

## Accepted Research

- A fixed renderer and exact-revision artifact path make preview output reproducible.
- No supplied issue requires saved preview presets.

## Draft Design

1. Render accepted report rows into a fixed-size PNG with bundled fonts, then publish it
   under a revision-and-content-hash artifact identity.
2. Add saved per-user preview presets and CRUD endpoints so users can choose dimensions,
   fonts, and colors for later renders.

## Architecture References

- Preview renderers consume accepted report revisions and produce immutable artifacts.
- Architecture does not define user preferences or allocate preview preset management.
