# Evaluation Fixture: Clean Enabling Seam

## Source Snapshot Metadata

| Source | Revision | Completeness |
| --- | --- | --- |
| Current ticket | `reports-141@fixture-1` | Complete, including task, acceptance criteria, and out-of-scope statements |
| One-hop issue graph | `reports-141-graph@fixture-1` | Complete, including parent, dependencies, dependents or blockers, and relevant siblings |
| Accepted Questions | `reports-141-questions@fixture-1` | Complete |
| Accepted Research | `reports-141-research@fixture-1` | Complete |
| Draft Design | `reports-141-design@fixture-1` | Complete |
| Architecture references | `reports-architecture@fixture-1` | Complete for the cited export boundary |

## Current Ticket

ID: `reports-141`

Title: Export a report as an immutable CSV artifact

Task:

- Render one accepted report revision as CSV.
- Publish the bytes through an exact-old artifact update.
- Return a typed receipt that later delivery mechanisms can consume.

Acceptance criteria:

- CSV column order and escaping are deterministic.
- The artifact identity includes report revision, content hash, and repository path.
- Publication rejects a changed report revision or remote head.
- A successful result exposes an `ExportReceipt` without scheduling delivery.

Out of scope:

- Scheduled exports, retry queues, email delivery, and user notifications.

## Parent

`reports-100`: Let users export and deliver reports. The epic contains both artifact
creation and scheduled delivery; children own those capabilities separately.

## Dependencies

- `reports-140` (closed): Captures immutable accepted report revisions.

## Dependents and Blockers

- `reports-142`: Schedule and deliver report exports. It owns schedules, retries, email
  delivery, and notifications. Its input contract requires the artifact identity and
  content hash from `ExportReceipt`.

## Relevant Siblings

- `reports-143`: Add PDF rendering. It owns PDF layout and fonts, not CSV behavior.

## Accepted Questions

- What is the smallest stable output later delivery can consume without adding delivery
  behavior here?

## Accepted Research

- A receipt with artifact identity, content hash, media type, and report revision is
  sufficient for the scheduling ticket.
- Publishing a queue message would start the downstream lifecycle and is unnecessary.

## Draft Design

1. Add a deterministic CSV renderer for accepted report rows and configured columns.
2. Publish the CSV at a deterministic repository path using report-revision and exact-old
   checks.
3. Return `ExportReceipt { artifact, contentSha256, mediaType, reportRevision }` from the
   publication result so `reports-142` can consume it later. Do not enqueue, schedule,
   retry, email, or notify.

## Architecture References

- Export artifacts are immutable and exact-revision addressed.
- Delivery operations accept an export receipt rather than re-reading mutable report
  state.
- Architecture describes scheduled delivery but does not add it to child tickets.
