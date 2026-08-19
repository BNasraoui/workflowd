# Accepted Structure input package: Atlas Desk support console

This file is a complete accepted Structure input package for evaluation. It stands alone,
so a Structure producer applies the contract to the text below without opening the
fictional repository. The repository is `atlas/atlas-web`, the React and TypeScript
front end for the Atlas Desk support console. It contains no server code. The accepted
implementation baseline commit is `7c3e19a05b8f42d6e13097ca5b2d4f8e6017b39d`. Everything
under "Repository baseline inventory" is factual repository state at that commit.

## Binding

| Field | Value |
| --- | --- |
| workflowId | `wf_atlas_atlas-web_ATLAS-1170` |
| generation | `2` |
| accepted Design revision | `03-design.md` revision `2`, commit `e208d417a95c6b3f01de74b8925fac0361d7e4aa` |
| acceptance package sha256 | `2b7d94e105c3a6f8d19b427c6ea05f31b84c7d023f16e9a5c507b2d498e1a63f` |
| gate response sha256 | `d40a6c197e25b8f3a6c103d72f94b5e018d76ca4b3e05f926a41d8c705f2b93e` |
| promotion request sha256 | `8e15f0b7c2a94d63370bd8e195f26a4ce0b73d184c8a1f5692d5b0e71a63c48f` |
| promotion result sha256 | `5c93a2e61f087b4db6e40d9528a7c1f374d29b60af35e8c103b7d6a9e42f0158` |
| pinned graph snapshot identity | `atlas-desk-graph@snapshot-2026-05-02T14:07:51Z-0021` |
| snapshot content hash | `a71e5d3c04b96f28d3170ea56c8b429df5093a172e6d84cbb09c5e3178a4f602` |
| Structure policy | `structure-coverage-policy`, revision `2.3.0`, sha256 `3d70b8a2e5194cf682b0d7431ac96e58b47e0d296f83a105d2c7b94e50a318f6` |
| deviation | none; the snapshot is pinned by the confirmed promotion result |

## Accepted graph records

### Informational sources

| Logical ID | Graph ID | Statement |
| --- | --- | --- |
| S1 | `atlasweb-d2-7c3e19-src-s1` | Support console usability study, March 2026, sessions 4 through 11. |
| S2 | `atlasweb-d2-7c3e19-src-s2` | Escalation handling policy `docs/policy/escalations.md`, version 3. |
| S3 | `atlasweb-d2-7c3e19-src-s3` | Platform API document `openapi/platform.yaml` at tag `platform-api-2026.04`. |
| S4 | `atlasweb-d2-7c3e19-src-s4` | Accessibility audit AUD-118 covering the tickets list. |

### Accepted requirements

| Logical ID | Graph ID | Statement |
| --- | --- | --- |
| R1 | `atlasweb-d2-7c3e19-req-r1` | An agent reading the tickets list can see, per ticket, how long ago the last response went out, and can sort by it. |
| R2 | `atlasweb-d2-7c3e19-req-r2` | An agent can see every open escalation for their queues in one place, kept current while the screen stays open. |
| R3 | `atlasweb-d2-7c3e19-req-r3` | Ticket severity appears with the same label, colour, and text alternative wherever a ticket is shown. |
| R4 | `atlasweb-d2-7c3e19-req-r4` | Every sortable list column states its current sort state to assistive technology. |
| R5 | `atlasweb-d2-7c3e19-req-r5` | Ticket content never reaches browser storage. |

### Accepted decisions and resolutions

| Logical ID | Graph ID | Position |
| --- | --- | --- |
| D1 | `atlasweb-d2-7c3e19-res-d1` | Show the last response age as one more column in the existing tickets list, using the field the existing list query already returns and the existing column definition. Authorizes work in this repository. |
| D2 | `atlasweb-d2-7c3e19-res-d2` | Add an escalations screen at its own route with its own navigation entry, which refreshes itself while open and tells the agent when the shown data is stale or the refresh failed. Authorizes work in this repository. |
| D3 | `atlasweb-d2-7c3e19-res-d3` | Introduce one shared severity badge used by the tickets list, the ticket detail screen, and the escalations screen, fed by a client-side taxonomy fetch and cache that other screens can read. Authorizes work in this repository. |
| D4 | `atlasweb-d2-7c3e19-res-d4` | No ticket identifier, subject, or body may be written to local storage, session storage, or IndexedDB, and no offline cache may be added to this application. Authorizes no work; forbids a surface. |
| D5 | `atlasweb-d2-7c3e19-res-d5` | The severity taxonomy and its `GET /severities` endpoint are owned by the platform configuration service under ticket `PLATCFG-881`. atlas-web defines, stores, and versions no taxonomy of its own. |

### Accepted controls and rules

| Logical ID | Graph ID | Statement |
| --- | --- | --- |
| C1 | `atlasweb-d2-7c3e19-rul-c1` | Every list column declares its accessible header name and sort state through the shared column definition. |
| C2 | `atlasweb-d2-7c3e19-rul-c2` | Colour never carries meaning alone; every colour-coded value also has a text label. |
| C3 | `atlasweb-d2-7c3e19-rul-c3` | Every timestamp shown to an agent uses the shared relative time formatter with the agent's locale. |
| C4 | `atlasweb-d2-7c3e19-rul-c4` | No screen renders ticket data fetched outside the shared API client. |
| C5 | `atlasweb-d2-7c3e19-rul-c5` | Any screen that refreshes on its own tells the agent when the shown data is stale. |

### Accepted verification obligations

| Logical ID | Graph ID | Obligation |
| --- | --- | --- |
| V1 | `atlasweb-d2-7c3e19-ver-v1` | Prove the tickets list renders the last response value and reports its sort state to assistive technology. |
| V2 | `atlasweb-d2-7c3e19-ver-v2` | Prove the escalations screen shows its fresh, stale, and failed refresh states. |
| V3 | `atlasweb-d2-7c3e19-ver-v3` | Prove the severity badge renders the same label and text alternative in all three placements. |
| V4 | `atlasweb-d2-7c3e19-ver-v4` | Prove no code path writes ticket data to browser storage. |

### Accepted residual risk dispositions

| Logical ID | Graph ID | Disposition |
| --- | --- | --- |
| X1 | `atlasweb-d2-7c3e19-rsk-x1` | The chosen refresh interval is an estimate until escalation volume is observed. Accepted. Owner: Support operations lead, R. Nkemelu. Condition: the interval stays build-configurable. Follow-up: review after 30 days, ticket `SUPP-640`. |
| X2 | `atlasweb-d2-7c3e19-rsk-x2` | The severity taxonomy can change without a front end release. Accepted. Owner: Platform configuration lead, J. Sato. Condition: taxonomy responses carry a version field. Follow-up: contract test under `PLATCFG-881`. |
| X3 | `atlasweb-d2-7c3e19-rsk-x3` | Severity colours are not yet measured against the dark theme contrast floor. Accepted. Owner: Design systems, P. Halvorsen. Condition: released behind the existing theme switch. Follow-up: contrast pass, ticket `DS-209`. |

## Accepted edges

Edge IDs follow `<edge_type>_<from_type>_<from_id>_to_<to_type>_<to_id>`, where the type
segments are `src`, `req`, `res`, `rul`, `ver`, and `rsk`, and the IDs are the exact graph
IDs above. The accepted graph records no dependency edge between D1, D2, and D3.

| Edge ID | Reads as |
| --- | --- |
| `needs_req_atlasweb-d2-7c3e19-req-r1_to_src_atlasweb-d2-7c3e19-src-s1` | R1 cites the usability study. |
| `needs_req_atlasweb-d2-7c3e19-req-r2_to_src_atlasweb-d2-7c3e19-src-s2` | R2 cites the escalation policy. |
| `needs_req_atlasweb-d2-7c3e19-req-r3_to_src_atlasweb-d2-7c3e19-src-s3` | R3 cites the platform API document. |
| `needs_req_atlasweb-d2-7c3e19-req-r4_to_src_atlasweb-d2-7c3e19-src-s4` | R4 cites accessibility audit AUD-118. |
| `resolves_res_atlasweb-d2-7c3e19-res-d1_to_req_atlasweb-d2-7c3e19-req-r1` | D1 resolves R1. |
| `resolves_res_atlasweb-d2-7c3e19-res-d1_to_req_atlasweb-d2-7c3e19-req-r4` | D1 resolves R4 for the tickets list. |
| `resolves_res_atlasweb-d2-7c3e19-res-d2_to_req_atlasweb-d2-7c3e19-req-r2` | D2 resolves R2. |
| `resolves_res_atlasweb-d2-7c3e19-res-d3_to_req_atlasweb-d2-7c3e19-req-r3` | D3 resolves R3. |
| `produces_res_atlasweb-d2-7c3e19-res-d1_to_rul_atlasweb-d2-7c3e19-rul-c1` | D1 produces C1, which also binds D2. |
| `produces_res_atlasweb-d2-7c3e19-res-d1_to_rul_atlasweb-d2-7c3e19-rul-c3` | D1 produces C3, which also binds D2. |
| `produces_res_atlasweb-d2-7c3e19-res-d3_to_rul_atlasweb-d2-7c3e19-rul-c2` | D3 produces C2. |
| `produces_res_atlasweb-d2-7c3e19-res-d2_to_rul_atlasweb-d2-7c3e19-rul-c4` | D2 produces C4, which also binds D1 and D3. |
| `produces_res_atlasweb-d2-7c3e19-res-d2_to_rul_atlasweb-d2-7c3e19-rul-c5` | D2 produces C5. |
| `needs_ver_atlasweb-d2-7c3e19-ver-v1_to_res_atlasweb-d2-7c3e19-res-d1` | V1 attaches to D1. |
| `needs_ver_atlasweb-d2-7c3e19-ver-v2_to_res_atlasweb-d2-7c3e19-res-d2` | V2 attaches to D2. |
| `needs_ver_atlasweb-d2-7c3e19-ver-v3_to_res_atlasweb-d2-7c3e19-res-d3` | V3 attaches to D3. |
| `needs_ver_atlasweb-d2-7c3e19-ver-v4_to_res_atlasweb-d2-7c3e19-res-d4` | V4 attaches to the prohibition D4 and is owed by every screen. |
| `needs_rsk_atlasweb-d2-7c3e19-rsk-x1_to_res_atlasweb-d2-7c3e19-res-d2` | X1 attaches to D2. |
| `needs_rsk_atlasweb-d2-7c3e19-rsk-x2_to_res_atlasweb-d2-7c3e19-res-d3` | X2 attaches to D3. |
| `needs_rsk_atlasweb-d2-7c3e19-rsk-x3_to_res_atlasweb-d2-7c3e19-res-d3` | X3 attaches to D3. |
| `needs_res_atlasweb-d2-7c3e19-res-d5_to_req_atlasweb-d2-7c3e19-req-r3` | D5 assigns the taxonomy side of R3 to platform configuration under `PLATCFG-881`. |

## Repository baseline inventory

Facts about `atlas/atlas-web` at commit `7c3e19a05b8f42d6e13097ca5b2d4f8e6017b39d`.

### Routing, presentation, and data access

| Path | Facts at the baseline commit |
| --- | --- |
| `src/routes/router.tsx` | Exports `routeTree`. The route files are `tickets.tsx`, `tickets.$ticketId.tsx`, `queues.tsx`, and `settings.tsx`. |
| `src/components/nav/PrimaryNav.tsx` | Renders three navigation entries: Tickets, Queues, and Settings. |
| `src/components/data-table/DataTable.tsx`, `src/components/data-table/column-def.ts` | `ColumnDef` declares `id`, `header`, `accessibleHeader`, `cell`, `sortable`, `width`, and `hideBelow`. `DataTable` sets `aria-sort` on every header whose `sortable` is true and reads the breakpoint tokens for `hideBelow`. |
| `src/components/data-table/use-sort.ts` | Wires keyboard sort activation and the sort direction state `DataTable` renders. |
| `src/features/tickets/ticket-columns.tsx` | Exports `ticketColumns: ColumnDef[]` with the columns `subject`, `requester`, `queue`, `status`, and `updatedAt`. |
| `src/features/tickets/TicketListContainer.tsx`, `src/features/tickets/TicketDetail.tsx` | The container renders `DataTable` with `ticketColumns` and switches on the query state to render `ListSkeleton`, `EmptyState`, or `ErrorState` from `src/components/state/`; the detail screen renders one ticket from `useTicket`. |
| `src/features/tickets/use-ticket-list.ts` | Exports `useTicketList()`, returning rows plus one state value out of `loading`, `empty`, `error`, and `ready`, plus `refetch`. |
| `src/features/tickets/types.ts` | Declares `TicketListRow` with `id`, `subject`, `requesterName`, `queueId`, `status`, `updatedAt`, `lastResponseAt`, and `severityId`. `lastResponseAt` is populated by `apiClient.getTickets` and is read by no component. |
| `src/lib/api/generated-client.ts` | Exports `apiClient` with `getTickets`, `getTicket`, `getQueues`, and `getEscalations`, generated from `openapi/platform.yaml` by `scripts/generate-client.ts`. Every operation on it is a read. |
| `src/lib/query/query-client.ts`, `src/lib/query/keys.ts` | One query client created with the library defaults; `keys.ts` exports `ticketKeys` and `queueKeys`. |
| `src/lib/format/relative-time.ts` | Exports `formatRelativeTime(iso, now, locale)`, used by the `updatedAt` column. |
| `src/styles/tokens.css`, `src/styles/breakpoints.css` | Tokens define surface, text, border, focus, and neutral status values; breakpoints define `--bp-sm`, `--bp-md`, and `--bp-lg`. |
| `src/components/` | Contains exactly `data-table/`, `state/`, `nav/`, and `form/`. |

### Tests, stories, and documentation

| Path | Facts at the baseline commit |
| --- | --- |
| `test/support/render.tsx`, `test/support/api.ts` | `renderWithProviders(ui)` mounts the router, query client, and theme provider; `mockApi(overrides)` replays one recorded response per endpoint from `test/fixtures/api/`. |
| `test/support/a11y.ts` | Exports `expectSortableHeader(name, direction)` and `expectNoAxeViolations(container)`. |
| `test/features/tickets/ticket-list.test.tsx`, `test/features/tickets/ticket-detail.test.tsx` | Follow the `renderWithProviders` plus `mockApi` plus `expectSortableHeader` pattern, including sort state assertions per column. |
| `src/components/data-table/DataTable.stories.tsx`, `src/components/state/EmptyState.stories.tsx` | The only Storybook files in the repository. |
| `docs/a11y-checklist.md` | Lists the keyboard, label, focus, and contrast patterns the repository applies. |

### Absent at this baseline

- No escalations route file, no escalations navigation entry, and no screen outside the four route files listed above.
- No self-refreshing, polling, live-update, stale-data, retry-with-backoff, or optimistic-update behaviour anywhere in `src/`. No `useQuery` call sets `refetchInterval`, and `src/` contains no mutation, timer, or interval.
- No badge, chip, tag, pill, or severity component in `src/components/`, no severity colour, label, or text alternative anywhere in `src/`, and no severity token in `src/styles/tokens.css`.
- No shared presentation component consumed by more than one feature directory.
- No client cache or invalidation seam beyond the query client defaults: no `src/lib/query/cache.ts`, no invalidation helper, and no key factory for taxonomy or configuration data.
- No call to `localStorage`, `sessionStorage`, `indexedDB`, or a service worker anywhere in `src/`.
- No write operation on `apiClient`, no server code, no database, and no persisted state in this repository.
- No test support for timers, fake clocks, sequenced responses, or partial-failure responses; `mockApi` returns one recorded response per endpoint per test.
