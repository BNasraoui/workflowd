# Evaluation Fixture: Unavailable Authority

## Current Ticket

ID: `reports-300`

Title: Render an accepted report revision as JSON

Task:

- Render one accepted report revision as deterministic JSON.

Acceptance criteria:

- Object keys follow the configured field order.
- The result identifies the exact accepted report revision.

Out of scope:

- Delivery and scheduling.

## Issue Graph Snapshot

The snapshot contains parent `reports-200`, but tracker access failed before dependencies,
dependents or blockers, and siblings could be enumerated. The snapshot does not claim to
be complete.

## Accepted Questions

- Which report revision and field order are authoritative inputs?

## Accepted Research

Unavailable. The artifact path is known, but its content and accepted revision could not
be read.

## Draft Design

1. Render configured report fields in deterministic order and return the exact accepted
   report-revision identity with the JSON bytes.

## Architecture References

- Renderers consume accepted report revisions and return exact source identity.
- Architecture describes later export delivery but does not add it to renderer tickets.
