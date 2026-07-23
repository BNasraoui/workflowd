# Impact and Risk Review

## Subject

| Field | Identity |
| --- | --- |
| Ticket | `workflowd-vs3.4.2`, live revision updated `2026-07-23T12:43:26Z` |
| Design | `03-design-discussion-exact-stage-contracts.md`, revision 1, SHA-256 `5bdedf4f16c47cd8dd9bc3c62410b58c2124c36b3e87c47df67244fa7fb64ae1` |
| Ownership report | `03-design-boundary-review-r1.md`, matching Design revision 1, SHA-256 `6e693fa104e85ae6c521212f1321e4ca77349dce8033698ea6744f302030f1ec`; entry verdict `ScopeClean` |
| Review binding | `03-design-acceptance-binding-r1.json`, SHA-256 `e1225a66e85161248b61dba0d5a23ae2e7504c59418a43a538c22664c3f4924c`; binds the exact Design and ownership-report paths and digests |
| Source set | `4d5be3489fc81aca45e7e34bba0d96bb7261dec4feea1a712695302782ae1`; repository base `c5a18e27c709facd9bd21c991fccea720a410229` |
| Workflow Generation | `workflowd-workflowd-vs3.4.2:workflowd-vs3.4.2`, Generation 1 |
| Policy revision | `local.impact-risk@1`, SHA-256 `fca8e7391d1a244f5121053474e5dae18ed89faad34cf8ac325ee764e888391b` |

## Verdict

`ReviseDesign`

## Human Summary

The Design places the complete `TicketRevision` inside every stage request while retaining a 32 KiB complete-request ceiling, but the accepted `ReadyTicket` Schema permits a single valid ticket to exceed that ceiling. Such a ticket deterministically fails before any stage becomes claimable, and the Design provides no compatible ticket projection, ingress bound, larger envelope, or recovery disposition. Revise Design revision 1 to make accepted ticket size and stage-request size compatible while preserving exact ticket authority and replay identity.

## Source Inventory

| Source | Status | Revision and completeness | Relevance |
| --- | --- | --- | --- |
| Current ticket and complete issue graph | Examined | Live read-only `bd show`, `bd dep tree --direction=both`, `bd dep list`, and all children of `workflowd-vs3.4`; ticket updated `2026-07-23T12:43:26Z` | Requirements, current owner, dependencies, six direct dependents, and downstream delivery sequence |
| Accepted Questions | Examined | `01-research-questions-typed-stage-contracts.md`, complete file, SHA-256 `0852b4845f4d278e1b586899295ef9e7def177651eb1ab7d0c11e097e61b02f2` | Required research scope |
| Accepted Research | Examined | `02-research-typed-stage-contracts.md`, status `complete`, base `c5a18e27c709facd9bd21c991fccea720a410229`, SHA-256 `935fda4fc687a454c2c1c1120b144877d0706fd6922ea65b2be0b6b6b1f163ce` | Current code, tests, bounds, persistence, and runtime evidence |
| Exact Design | Examined | Revision 1, complete file, digest verified as `5bdedf4f16c47cd8dd9bc3c62410b58c2124c36b3e87c47df67244fa7fb64ae1` | Review subject |
| Ownership report | Examined | Complete file; digest verified as `6e693fa104e85ae6c521212f1321e4ca77349dce8033698ea6744f302030f1ec`; only bound identity and `ScopeClean` entry verdict consumed | Entry condition only |
| Authoritative review binding | Examined | Contract version 1; complete file; digest `e1225a66e85161248b61dba0d5a23ae2e7504c59418a43a538c22664c3f4924c`; all bound artifact digests verified | Exact subject, source-set, Generation, and policy binding |
| `docs/qrspi-contract.md` | Examined | Base `c5a18e27c709facd9bd21c991fccea720a410229`; complete cited artifact, authority, StageRun, and StageRevision sections; SHA-256 `55470a92b645ccfcea8f694ec43ae64b6dd9f6f7615664539e05756b4edcfc7d` | Normative artifact identity, authority order, and accepted-revision behavior |
| `docs/qrspi-stage-runtime-design.md` | Examined | Base `c5a18e27c709facd9bd21c991fccea720a410229`; complete cited contract, exact-source, identity, and record sections; SHA-256 `149ec8c3423f978bcb7d2e1eab202c431396e5e1c6ef6f6dd9dcb58b18dd532b` | Parent architecture for exact requests and 32 KiB envelope |
| `docs/qrspi-trusted-stage-catalog-design.md` | Examined | Base `c5a18e27c709facd9bd21c991fccea720a410229`; complete cited registration, validation, and type-restoration sections; SHA-256 `63cbb95b4bfdbb44dd80c606d3a9cbaf4bcbe6750b1071a5ff4dbfa1c11c1a2d` | Trusted catalog and pre-claim validation boundary |
| `skills/qrspi-design-structure/references/qrspi-design-structure-contract.md` | Examined | Base `c5a18e27c709facd9bd21c991fccea720a410229`; complete cited StageRevision section; SHA-256 `688e550b27966c7a74f4c99326dbc6ce93fa75b42486c2475d0abe1ab0c8963b` | Distinct document and implementation revision contract |
| Current affected source | Examined | Repository HEAD and bound base both `c5a18e27c709facd9bd21c991fccea720a410229`; `src/agent-payload.ts`, `src/qrspi/domain.ts`, `stage-catalog.ts`, `ports.ts`, `adapters.ts`, `store.ts`, `source-resolver.ts`, `src/store/migrations.ts`, and `src/layers.ts` examined at relevant boundaries | Current ticket-size, request-size, catalog, repository, durable-input, and composition behavior |
| Current affected tests | Examined | Base `c5a18e27c709facd9bd21c991fccea720a410229`; catalog, payload, adapter, workflow-start, store, migration, and layer test evidence identified through accepted Research and direct catalog/workflow-start test inspection | Existing lowest-boundary checks and missing exact-request fit invariant |
| Deployment and operating model | Examined | `package.json` scripts and `src/layers.ts` live composition at base commit; QRSPI uses one Effect Layer, GitHub adapter, SQLite store, and no current generic stage producer loop | Exposure, startup, and delivery context |
| Current observability and operational evidence | Examined | Current typed catalog/store errors, QRSPI-local closed-service composition, durable operation state, and test diagnostics at base commit; production does not yet invoke contract assembly/build/projection | Detection timing and current absence of runtime recovery for rejected exact requests |

## Design Decision Inventory

| ID | Source decision | Decision | Intended outcome | Design evidence |
| --- | --- | --- | --- | --- |
| D1 | Proposed architecture surfaces 1 and contract table | Compose one Schema-backed exact-source envelope into six separately tagged, bounded request/result contracts; project five documents and one typed implementation step | Preserve local stage semantics without duplicated identity rules | Design lines 76-81, 83-128, 158-163 |
| D2 | Shared source model and source-order decision | Keep the Ticket separate as highest authority; derive every enabled accepted predecessor exactly once in newest-to-oldest order and hash the ordered immutable references | Deterministic authority and source-set identity | Design lines 83-115, 126, 164-168 |
| D3 | Immutable artifact-read decision | Read by repository, exact commit, and relative path with a byte cap; compare observed commit/path, Git blob SHA, and content SHA-256 | Prevent mutable or substituted source content | Design lines 132-140, 170-174, 276-293 |
| D4 | Catalog erasure and compatibility decisions | Keep executable erasure inside `TrustedStageCatalog`; decode and bound selected requests/results and run contract-local compatibility on fresh and restart validation | Registration-only extension with one trusted dispatch seam | Design lines 80-81, 176-180, 204-232, 148-150 |
| D5 | Durable replay decision | Persist a versioned `StageProduceInput` with exact scope, contract ref, complete decoded request, and `requestSha256`; replay that value and fence legacy placeholders | Stable retry/restart identity without source rediscovery | Design lines 31, 38-39, 81, 141-144, 182-186, 258-274 |
| D6 | Bounds and failure decision | Enforce per-read, per-source UTF-8, complete request, configured input, selected result, and global envelope bounds; keep the complete stage request at 32 KiB | Reject malformed or oversized records before persistence or prepared output | Design lines 29-31, 142-146, 188-192 |
| D7 | Trusted task decision | Render decoded Ticket content first, then technical sources in stored order and fixed instructions; leave execution policy outside the contract | Deterministic task meaning with correct authority precedence | Design lines 147-150 |
| D8 | Registration and verification decision | Register the six contracts in an explicit tuple and prove exact limits, ordering, identity mismatches, replay corruption, distinct results, and a seventh registration-only extension | Deterministic built-ins and lowest-boundary extensibility evidence | Design lines 194-198, 295-311 |

## Affected Surface Trace

| Decision | Surface | Disposition | Evidence |
| --- | --- | --- | --- |
| D1 | Code | Six concrete Effect Schemas and projections replace the unknown aliases | Design lines 76-81; current aliases at `src/qrspi/stage-catalog.ts:21-27` |
| D1 | Data | Every request carries the full common envelope; result data remains stage-tagged | Design lines 83-128 |
| D1 | Configuration | Contract refs, policy refs, and Schema-derived registration identity constrain configured stages | Design lines 113-125, 146, 150 |
| D1 | Interfaces | Six request/result contracts and two prepared-output tags become trusted interfaces | Design lines 117-128 |
| D1 | ExternalEffects | NoMaterialImpact: contracts prepare values but do not execute agents or publish Git | Design lines 35-42, 148-150 |
| D1 | Operations | Decode failures stop requests/results before claim or persistence | Design lines 29-31, 80-81 |
| D1 | Users | Product instructions are supplied through the full `TicketRevision`; valid ticket size can therefore affect stage availability | Design lines 92-103; `src/qrspi/domain.ts:50-102` |
| D1 | NeighboringTickets | D3, D4, D7, D9, and D10 consume the typed contracts or their outputs | Live issue graph and ticket dependency descriptions |
| D2 | Code | Source assembly derives, validates, orders, and hashes accepted predecessor references | Design lines 113-115, 132-140 |
| D2 | Data | Ticket content is separate; technical sources retain role, immutable reference, and exact content | Design lines 83-114 |
| D2 | Configuration | Enabled snapshots determine expected predecessor membership | Design lines 115, 126 |
| D2 | Interfaces | `ExactStageSources` is the shared assembly-to-contract interface | Design lines 83-114 |
| D2 | ExternalEffects | NoMaterialImpact: this decision reads already accepted artifacts and performs no mutation | Design lines 35-42, 132-140 |
| D2 | Operations | Missing, extra, duplicate, or reordered sources fail before claimability | Design lines 29-31, 132-140 |
| D2 | Users | Ticket authority cannot be overridden by later technical artifacts | Design lines 27-29, 164-168 |
| D2 | NeighboringTickets | D7 supplies accepted pointers and D5 supplies immutable references before downstream consumption | Live issue graph and ticket descriptions for `workflowd-vs3.4.5` and `.7` |
| D3 | Code | Repository port and GitHub adapter gain an exact bounded artifact read | Design lines 170-174; current port lacks it at `src/qrspi/ports.ts:37-66` |
| D3 | Data | Returned bytes must match blob and content identities before becoming source content | Design lines 132-140 |
| D3 | Configuration | Byte cap is a trusted exported limit, not repository input | Design lines 145-146 |
| D3 | Interfaces | `QrspiRepositoryPort` gains a read-only operation keyed by repository, commit, and path | Design lines 170-174 |
| D3 | ExternalEffects | Read-only GitHub API access; no ref, commit, workspace, or publication mutation | Design lines 35-42, 170-174 |
| D3 | Operations | Identity mismatch, oversized bytes, timeout, or unavailable Git content stops assembly | Design lines 29-31, 132-140; current adapter timeout pattern at `src/qrspi/adapters.ts:315-330` |
| D3 | Users | Exact source failures prevent a stage from running rather than silently using changed content | Design lines 29-31 |
| D3 | NeighboringTickets | D5 publishes immutable references; this ticket only reads them | Live issue graph and `workflowd-vs3.4.5` scope |
| D4 | Code | Runtime registrations retain selected Schemas and closures behind erased methods | Design lines 176-180, 204-232 |
| D4 | Data | Schema-decoded request/result values alone cross the selected contract boundary | Design lines 176-180 |
| D4 | Configuration | Generic and contract-local compatibility checks rerun for fresh definitions and restart | Design lines 148-150 |
| D4 | Interfaces | Public catalog operations return bounded prepared output without exposing untyped closures | Design lines 80-81, 176-180 |
| D4 | ExternalEffects | NoMaterialImpact: catalog dispatch has no store, agent, Git, or progression authority | Design lines 35-42, 148-150 |
| D4 | Operations | Registration drift and incompatible persisted definitions fail preflight | Design lines 148-150; current preflight evidence in accepted Research |
| D4 | Users | NoMaterialImpact: this internal trust seam changes no user role or product authority | Ticket scope and Design lines 176-180 |
| D4 | NeighboringTickets | D1 supplies the catalog foundation; D4 and D10 later invoke/compose it | Live issue graph and ticket descriptions for `workflowd-vs3.4.1`, `.4`, and `.10` |
| D5 | Code | Store codecs and catalog execution decode and hash-check one new `StageProduceInput` format | Design lines 182-186, 258-274 |
| D5 | Data | Exact request JSON and nested request hash persist in existing operation columns | Design lines 81, 141-144 |
| D5 | Configuration | Contract reference and exact Generation/stage scope bind replay to the configured snapshot | Design lines 141-144, 182-186 |
| D5 | Interfaces | New-format input is the durable handoff to later producer execution | Design lines 31, 141-144 |
| D5 | ExternalEffects | Retry/restart performs no source reread; old placeholders are not activated or converted | Design lines 31, 38-39, 182-186 |
| D5 | Operations | Hash/Schema corruption and legacy input are nonclaimable | Design lines 31, 39, 184-186 |
| D5 | Users | Exact retry preserves the same Ticket and technical context after process restart | Design lines 31, 182-186 |
| D5 | NeighboringTickets | D3 owns later stage-state records, D4 consumes the input, and D11 owns offline legacy recovery | Live issue graph and ticket descriptions for `workflowd-vs3.4.3`, `.4`, and `.11` |
| D6 | Code | Layered byte and Schema checks apply to source reads, request JSON, and result JSON | Design lines 142-146, 188-192 |
| D6 | Data | Each source is capped and the full request remains capped at 32 KiB | Design lines 145-146 |
| D6 | Configuration | Stage `maxEncodedInputBytes` may narrow but not exceed the contract/global request bound | Design lines 142-146; `src/agent-payload.ts:3-18` |
| D6 | Interfaces | Oversize and malformed requests/results are rejected before durable or prepared boundaries | Design lines 29-31, 188-192 |
| D6 | ExternalEffects | NoMaterialImpact: rejection occurs before agent or Git effects | Design lines 29-31, 35-42 |
| D6 | Operations | A Schema-valid `ReadyTicket` can exceed 32 KiB before any technical source is added, making its stage request unclaimable | `src/qrspi/domain.ts:50-102`; `src/agent-payload.ts:3-18`; Design lines 92-103, 145-146 |
| D6 | Users | R1: a ticket accepted by readiness can be refused by every stage solely because the two accepted bounds are incompatible | Same evidence as preceding row |
| D6 | NeighboringTickets | D3/D4/D7 cannot create, run, or advance work when CAP-D2 cannot produce a claimable request | Live issue graph and scopes for `workflowd-vs3.4.3`, `.4`, and `.7` |
| D7 | Code | Trusted renderers build deterministic prompts from decoded requests | Design lines 147-150 |
| D7 | Data | Ticket content precedes technical content without changing stored source order | Design lines 147-150 |
| D7 | Configuration | Agent, model, timeout, retry, workspace, and publication policy remain outside contracts | Design lines 148-150 |
| D7 | Interfaces | Contract returns `AgentTask` to the later harness boundary | Design lines 204-218 |
| D7 | ExternalEffects | NoMaterialImpact: task construction does not start a session or mutate a repository | Design lines 35-42, 147-150 |
| D7 | Operations | Deterministic replay produces the same task from the persisted decoded request | Design lines 31, 147-150, 182-186 |
| D7 | Users | Ticket-first rendering preserves product authority in agent-visible instructions | Design lines 147-150 |
| D7 | NeighboringTickets | D4 owns agent/session execution after task construction | Live issue graph and `workflowd-vs3.4.4` scope |
| D8 | Code | Explicit tuple replaces implicit registration enumeration; a seventh fixture exercises erased operations | Design lines 194-198 |
| D8 | Data | Tests cover source/request/result identity and bound edge cases without aggregate-capacity claims | Design lines 295-311 |
| D8 | Configuration | Tuple order is a deterministic live default | Design lines 194-198 |
| D8 | Interfaces | Registration alone extends assemble/build/prepare behavior without central dispatch changes | Design lines 194-198 |
| D8 | ExternalEffects | Injected repository observations and SQLite corruption fixtures avoid live mutation | Design lines 295-311 |
| D8 | Operations | Pure, adapter, and SQLite checks provide pre-deployment evidence; no production stage loop yet exists | Design lines 295-311; `src/layers.ts:36-160` |
| D8 | Users | NoMaterialImpact: tests and registration order add no user role or UI | Ticket scope and Design lines 194-198 |
| D8 | NeighboringTickets | D12 later owns integrated cross-capability evidence; this ticket retains local acceptance checks | Live issue graph and `workflowd-vs3.4.12` scope |

## Risk Register

| ID | Decisions | Surfaces | Evidence | Trigger | Failure mode | Consequence and materiality |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | D1, D6 | Data, Interfaces, Operations, Users, NeighboringTickets | Design puts complete `TicketRevision` in `ExactStageSources` and retains a 32 KiB complete request (`03-design...:92-103,145-146`). `TicketRevision` contains `ReadyTicket`; its independently valid fields allow 20,000 description characters, up to 100 sources of 2,000 characters, up to 100 acceptance criteria of 4,000 characters, and up to 100 scenarios (`src/qrspi/domain.ts:27-102`). The enforced global request envelope is 32 KiB (`src/agent-payload.ts:3-18`). | A readiness-accepted ticket's encoded `TicketRevision`, envelope identity, and local request fields exceed 32 KiB, even with no technical predecessor sources | Exact request decoding/bounding rejects the request before persistence and claimability | The Generation cannot run even the Questions stage for a ticket that the authoritative readiness contract accepts; all downstream stage work is blocked. This violates the intended accepted-ticket-to-stage handoff and can change Design acceptance, so it is material. |

## Risk Characterization

| Risk | Current rating, exposure, uncertainty, and basis | Detectability and signal | Reversibility | Blast radius | Current controls | Required controls | Residual rating, assumptions, and uncertainty |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | Impact `Moderate (3)`: one valid workflow is wholly unavailable until its input contract changes, but no data or external state is lost. Likelihood `Unknown`: failure is deterministic per stage-request assembly whose encoded request exceeds 32 KiB, but evidence does not establish the frequency of such tickets. No matrix score. Exposure basis: each new stage request. Uncertainty `High` because live ticket-size distribution is unavailable. | Before effect: the assembler/Schema bound can emit an exact encoded-size failure; observer is the QRSPI operation/runtime owner. No current production stage loop exposes that signal yet. | Operator recovery only after ticket contraction or a contract/runtime revision; retrying the same persisted inputs cannot recover | One Generation and all its configured stages for each over-limit accepted ticket; no Git or third-party mutation | C1 | `Missing: Design must make the accepted TicketRevision domain and complete stage-request envelope compatible while retaining exact ticket authority and replay identity`; `Missing: define an owned recovery disposition for already accepted tickets that cannot fit` | Impact `Moderate (3)`; likelihood `Unknown`; no score. Assumes only C1, which detects and fails closed but does not make the workflow runnable. Uncertainty `High`; material residual remains. |

## Control Coverage

| Risk | Prevention | Detection | Containment | Recovery |
| --- | --- | --- | --- | --- |
| R1 | `Missing: revise the exact Design to select a bounded exact ticket representation, tighten readiness bounds, or change the complete-request envelope with matching launch/persistence constraints` | C1 | `NotApplicable: fail-closed rejection already prevents persistence and external effects, but containment cannot restore a stage request that cannot be represented` | `Missing: an owned disposition for an already accepted over-limit ticket` |

## Control Ledger

| ID | Risks | Status | Kind | Obligation | Ownership class | Owner | Delivery phase | Verification target | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | R1 | Required | Detection | Measure the complete Schema-decoded encoded request and reject an over-limit value before persistence or claimability with a stable bounded diagnostic | CurrentTicket | `workflowd-vs3.4.2` | Implementation | V1: exact-limit acceptance and over-limit rejection with no claimable operation | Design lines 29-31, 141-146, 188-192; ticket acceptance criterion 3 |

## Verification Plan

| ID | Risks and controls | Claim and boundary | Method and rationale | Pass evidence | Owner and phase | Automation gap |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | R1; C1 | At the contract/persistence boundary, the complete encoded request is measured after Schema decoding; an exact-limit request may persist, while a request one encoded UTF-8 byte over the selected limit produces a stable failure and no claimable `StageProduce` row | `ComponentIntegration`: a real contract Schema plus file-SQLite store is the lowest boundary that proves both encoded-size classification and absence of durable claimability | Deterministic assertions show the measured encoded byte counts, exact-limit success, over-limit typed failure, and zero ready/leased operation for the rejected input | `workflowd-vs3.4.2`, Implementation | None |

## Residual Risk and Decisions

| Risk | Assumed controls | Residual rating and basis | Materiality | Decision status | Decision owner and evidence |
| --- | --- | --- | --- | --- | --- |
| R1 | C1 | Impact `Moderate (3)`; likelihood `Unknown`; no score. C1 prevents unsafe persistence but leaves a valid workflow unavailable whenever the trigger occurs. | Material | NeedsDecision | Design author for `workflowd-vs3.4.2`; no exact-Design acceptance of this incompatibility exists, and the current Design must choose a compatible ticket/request contract before a residual decision can be evaluated |

## Excluded Speculation

| Candidate | Why considered | Missing evidence link | Disposition |
| --- | --- | --- | --- |
| Invalid UTF-8 artifact bytes could be replacement-decoded into task content | The Design hashes bytes and later stores `content: string` | No evidence specifies a non-fatal decoder or shows byte/string divergence; the Design's per-source UTF-8 validation may reject it | Excluded |
| Repository API could return content from a commit other than the requested SHA | The current adapter has no exact artifact-read method | No implementation or observed adapter response exists for the proposed operation, so the trigger and failure mode are not evidenced | Excluded |
| Legacy placeholder operations could become claimable after deployment | Existing rows have the old minimal input shape | The Design expressly fences old-format inputs, and the live issue graph assigns offline classification/recovery to `workflowd-vs3.4.11`; no evidence shows an exposure path that bypasses those checks | Excluded |

## Human Risk Decision

None.
