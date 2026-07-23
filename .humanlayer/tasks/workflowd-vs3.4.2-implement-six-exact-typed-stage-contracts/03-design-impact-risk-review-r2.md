# Impact and Risk Review

## Subject

| Field | Identity |
| --- | --- |
| Ticket | `workflowd-vs3.4.2`, live Beads revision updated `2026-07-23T12:43:26Z` |
| Design | `03-design-discussion-exact-stage-contracts.md`, revision 2, SHA-256 `30430be4f28f75bd58e9e9d6020ba1ce46068165ad922156e6f8a016f7c4bc09` |
| Ownership report | `03-design-boundary-review-r2.md`, bound to Design revision 2, SHA-256 `8032304907cbcddc37690dbaf08bbdb3875884a5dfd3c9d3ce1451f1bcb6db2e`; only identity and `ScopeClean` entry verdict consumed |
| Review binding | `03-design-acceptance-binding-r2.json`, contract version 1; authoritative separate envelope naming the Design and ownership-report paths and digests |
| Source set | `4d5be3489fc81aca45e7e34bba0d96bb7261dec4feea1a712695302782ae1ee7`; repository base `c5a18e27c709facd9bd21c991fccea720a410229` |
| Workflow Generation | `workflowd-workflowd-vs3.4.2:workflowd-vs3.4.2`, Generation 1 |
| Policy revision | `local.impact-risk@1`, SHA-256 `fca8e7391d1a244f5121053474e5dae18ed89faad34cf8ac325ee764e888391b` |

## Verdict

`ReviseDesign`

## Human Summary

Revision 2 establishes bounded, content-addressed contracts and replay, but it does not require an atomic currentness check between accepted-source discovery and making the persisted request claimable, nor does it state the cross-field equality rules that bind every artifact reference to the current repository, workflow, Generation, stage, and accepted revision. Those omissions permit an exact, hash-valid request to carry stale or wrong-scope authority. Revise the Design to add both fail-closed invariants and their observable failure dispositions before the human Design gate.

## Source Inventory

| Source | Status | Revision and completeness | Relevance |
| --- | --- | --- | --- |
| Current ticket `workflowd-vs3.4.2` | Examined | Live read-only Beads record, updated `2026-07-23T12:43:26Z`; description, scope, exclusions, design, criteria, notes, and comments represented | Product authority and acceptance invariants |
| Complete issue graph | Examined | Live read-only dependency list plus all 12 children of `workflowd-vs3.4`; direct dependency `workflowd-vs3.4.1`, parent, six direct dependents, and sibling owners examined | Control ownership, sequencing, and downstream containment/recovery |
| Accepted Questions | Examined | `01-research-questions-typed-stage-contracts.md`, complete, SHA-256 `0852b4845f4d278e1b586899295ef9e7def177651eb1ab7d0c11e097e61b02f2` | Defines the accepted research scope |
| Accepted Research | Examined | `02-research-typed-stage-contracts.md`, status `complete`, baseline `c5a18e27c709facd9bd21c991fccea720a410229`, SHA-256 `935fda4fc687a454c2c1c1120b144877d0706fd6922ea65b2be0b6b6b1f163ce` | Current implementation, tests, bounds, persistence, and source evidence |
| Exact Design revision 2 | Examined | Complete 363-line artifact; bound digest independently verified | Subject of this review |
| Ownership report | Examined | Bound digest independently verified; only report identity and `ScopeClean` verdict examined | Entry condition only |
| Authoritative review binding | Examined | Complete contract-version-1 JSON envelope; all named digests independently verified | Binds exact report, Design, source set, Generation, and policy |
| `docs/qrspi-contract.md` | Examined | Repository base `c5a18e2`; artifact identity, authority order, accepted-revision, StageRun, and StageRevision sections | Normative immutable artifact and progression invariants |
| `docs/qrspi-stage-runtime-design.md` | Examined | Repository base `c5a18e2`; catalog, exact-input, durable identity, and record sections | Accepted source and runtime boundary model |
| `docs/qrspi-trusted-stage-catalog-design.md` | Examined | Repository base `c5a18e2`; registration, validation, persistence, and type-restoration sections | Existing catalog trust boundary |
| `skills/qrspi-design-structure/references/qrspi-design-structure-contract.md` | Examined | Repository base `c5a18e2`; StageRevision and Design-release contract sections | Mirrored downstream contract |
| Current production source | Examined | Git `HEAD` equals bound repository base; `src/qrspi/stage-catalog.ts`, `domain.ts`, `store.ts`, `ports.ts`, `adapters.ts`, `workflow-start.ts`, `source-resolver.ts`, `agent-payload.ts`, `layers.ts`, `config.ts`, and migrations covered by accepted Research and targeted reads | Existing type erasure, repository authority, operation persistence, currentness, and failure handling |
| Current tests | Examined | Catalog, ticket, adapter, workflow-start, harness, structured-session, store, migration, and Layer coverage at the bound base; targeted catalog and corruption cases read | Existing deterministic and fail-closed evidence; proposed seams do not yet exist |
| Deployment and operating model | Examined | `README.md`, `deploy` model as cited there, `src/config.ts`, `src/layers.ts`, and `package.json`; Bun process, Effect Layers, SQLite, GitHub App, OpenCode, systemd, health, and journal operation covered | Runtime credentials, restart, deployment, and operator boundaries |
| Current observability evidence | Examined | Typed catalog/store diagnostics, startup closure in `src/layers.ts`, SQLite state, `/health`, systemd status, and journal smoke commands; no source-assembly metrics or alerts exist at the baseline | Detection and operator response evidence |
| Provenance graph snapshot | Unavailable | No authoritative snapshot identity or completeness statement was supplied; not treated as absent | Revision 2 names only a future typed Structure input scope; no graph claims or authority were inferred for this review |

## Design Decision Inventory

| ID | Source decision | Decision | Intended outcome | Design evidence |
| --- | --- | --- | --- | --- |
| D1 | Desired End State 1-2; architecture surface 1; contract table | Register six built-ins in an explicit tuple, each with a distinct stage-tagged request/result Schema over shared bounded identities | Typed stage semantics without a central stage switch or duplicated identity rules | Design lines 26-28, 80-84, 132-143, 175-181, 219-223 |
| D2 | Desired End State 3-6; shared source model; source-order decision | Assemble every request from Ticket identity plus the exact enabled accepted predecessor subsequence in newest-to-oldest technical order | Deterministic authority and rejection of missing, extra, duplicate, or reordered sources | Design lines 28-31, 87-130, 141, 145-163, 183-187 |
| D3 | Architecture surface 2; repository-read decision | Read each artifact by repository, commit, and relative path with a byte cap, then verify observed commit/path, blob SHA, and content SHA-256 | Immutable source bytes and fail-closed substitution detection | Design lines 30-31, 82-83, 126, 145-153, 189-193 |
| D4 | Ticket-reference and bounded-authority decisions | Put a bounded `TicketRevisionReference` in requests; reload, Schema-decode, and semantically hash the exact stored row before task construction | Preserve full Ticket authority while every valid request fits 32 KiB | Design lines 32-35, 96-103, 126-128, 158-167, 213-217 |
| D5 | Architecture surface 3; type-erasure and compatibility decisions | Keep executable erasure inside `TrustedStageCatalog`, invoke only selected trusted closures, and split generic from contract-local compatibility | Extensible trusted dispatch with concrete Schema restoration | Design lines 67-77, 84-85, 169, 195-199, 229-264 |
| D6 | Architecture surface 4; durable replay decision | Persist a versioned `StageProduceInput` with exact scope, contract ref, decoded request, and nested request hash in existing operation columns; replay the same request | Deterministic retry/restart without mutable source rediscovery | Design lines 85, 145-167, 201-205, 290-306 |
| D7 | Authority-manifest and lifecycle boundary decision | Build a bounded fixed task with Ticket-first typed authority; leave materialization, execution, publication, and progression to later owners | Exact handoff without granting contract code execution or publication authority | Design lines 127-129, 163-167, 225-253 |
| D8 | Bounds and failure decision | Enforce per-read, per-source, complete request, configured input, result-Schema, and global bounds; fail malformed or corrupt durable values closed | Prevent oversized or malformed work from becoming claimable or persisted | Design lines 31, 35, 145-165, 207-211 |
| D9 | Contract-specific distinctions | Add pinned Design policies, one exact Structure acceptance package/scope, and typed Implementation checkpoint/prepared-commit unions; project document and implementation outputs separately | Preserve owner-issued and execution-kind semantics through local contracts | Design lines 132-143, 169, 175-181 |
| D10 | Legacy, extension, and verification boundaries | Leave placeholder rows unclaimable, prove registration-only extension with a seventh test contract, test exact negative cases, and make no aggregate-capacity claim | Safe format introduction and local acceptance evidence without taking later lifecycle ownership | Design lines 34, 39-44, 164-165, 219-223, 347-363 |

## Affected Surface Trace

| Decision | Surface | Disposition | Evidence |
| --- | --- | --- | --- |
| D1 | Code | Replaces the Questions placeholder with six modules and an explicit registration tuple | Design surfaces 1 and 3; current `stage-catalog.ts:21-49,646-670` has unknown aliases and one built-in |
| D1 | Data | Schema and registration hashes change, but D1 adds no new durable table | Design lines 80-85; catalog hashes generated Schemas at current `stage-catalog.ts:161-167` |
| D1 | Configuration | Known stage definitions must resolve the matching fixed key/kind/policy contract | Design compatibility paragraph and contract table |
| D1 | Interfaces | Six request/result interfaces replace one broad placeholder | Ticket criterion 1; Design lines 132-143 |
| D1 | ExternalEffects | NoMaterialImpact: registration, decoding, task construction, and projection are process-local | Ticket excludes execution/publication; Design lines 39-44 |
| D1 | Operations | Startup catalog construction can close QRSPI on malformed or incompatible registrations | Current `layers.ts:67-80,150-159`; Design compatibility rules |
| D1 | Users | NoMaterialImpact: no user-facing stage execution or presentation is introduced | Ticket and Design exclusions |
| D1 | NeighboringTickets | Supplies typed contract seams to D3, D4, D7, D9, D10, and D12 | Live issue graph |
| D2 | Code | Adds trusted predecessor derivation and order-preserving source assembly | Design lines 82-83, 130-141, 145-153 |
| D2 | Data | Requests retain exact source content and canonical ordered reference identity | `ExactStageSources`; Design lines 104-126 |
| D2 | Configuration | Enabled/disabled snapshots determine expected predecessor membership | Design lines 130-141; current definition normalization preserves order |
| D2 | Interfaces | Source envelope crosses catalog, store, and later producer boundaries | Design architecture diagram and surfaces 2-4 |
| D2 | ExternalEffects | Reads immutable Git artifacts before persistence | Design exact request flow |
| D2 | Operations | Assembly failures keep work nonclaimable; the Design does not specify the final currentness recheck | Design lines 145-159; R1 |
| D2 | Users | Wrong authority order can change generated stage meaning despite valid bytes | Ticket criterion 4 and normative authority order |
| D2 | NeighboringTickets | Consumes accepted pointers owned by D7 and publication references owned by D5 | Live D5/D7 scopes; R1 sequencing |
| D3 | Code | Extends `QrspiRepositoryPort` and GitHub adapter with exact artifact reads and comparisons | Design lines 189-193, 328-345; current port lacks this method |
| D3 | Data | Carries repository/workflow/Generation/stage/revision/Git/content identity with bytes | Design lines 89-95, 126 |
| D3 | Configuration | Byte ceilings and supported media types become contract identity | Design bounds paragraph |
| D3 | Interfaces | Repository observations must match requested immutable identity | Design lines 145-153 |
| D3 | ExternalEffects | Uses authenticated GitHub App reads; historical objects can be unavailable and must fail closed | Current `layers.ts:112-146`, `adapters.ts:189-218`; Git retention contract |
| D3 | Operations | Timeout, missing object, byte overflow, or mismatch blocks assembly with diagnostics | Current repository adapter timeout pattern; Design rejection rules |
| D3 | Users | Prevents silently supplying changed technical context to an agent | Ticket criteria 2-4 |
| D3 | NeighboringTickets | Consumes D5 immutable references; current Design omits explicit equality to current scope | D5 issue scope; R2 |
| D4 | Code | Adds exact ticket-row reader and verified task-authority construction | Design surface 4 and lines 126-128, 158-167 |
| D4 | Data | Reuses the existing content-addressed ticket row without duplicating the full record | Current store/migrations evidence; Design lines 213-217 |
| D4 | Configuration | Request remains under configured and global input ceilings regardless of ticket size | Design lines 164-167, 213-217 |
| D4 | Interfaces | `StageTaskAuthority` gives CAP-D4 a Ticket reference followed by ordered technical sources | Design lines 101-105, 127-129 |
| D4 | ExternalEffects | NoMaterialImpact: replay reads local SQLite only and does not reread tracker or Git | Design lines 166-167, 201-205 |
| D4 | Operations | Missing, malformed, hash-mismatched, or identity-mismatched ticket rows fail stably | Design line 167 |
| D4 | Users | Preserves the complete Ticket as highest product authority rather than truncating it | Design desired end state and resolved question |
| D4 | NeighboringTickets | D4 materializes the verified row and sources before execution | Live D4 scope and Design handoff |
| D5 | Code | Extends private runtime registrations with selected executable closures and erased methods | Design lines 84-85, 195-199, 255-264 |
| D5 | Data | Registration hashes bind metadata and generated Schemas, not closures themselves | Current catalog evidence and implementation revision |
| D5 | Configuration | Fresh and restart validation rerun generic and contract-local compatibility | Design line 169 |
| D5 | Interfaces | Generic callers receive only decoded/bounded prepared output | Design surface 3 |
| D5 | ExternalEffects | NoMaterialImpact: the catalog receives no store, publisher, or repository credentials | Design exclusions and runtime architecture |
| D5 | Operations | Unknown, changed, malformed, or incompatible registrations close activation | Current typed catalog diagnostics and Layer closure |
| D5 | Users | NoMaterialImpact: catalog selection is not a user-facing authorization decision | Trusted server configuration model |
| D5 | NeighboringTickets | Extends the D1 catalog and supplies D4/D7/D10 without a stage switch | Live issue graph |
| D6 | Code | Adds `StageProduceInput` codecs, nested hash checks, and exact ticket-row lookup | Design lines 145-167, 201-205 |
| D6 | Data | Existing operation JSON/hash columns become the durable request envelope | Design surface 4; current store row model |
| D6 | Configuration | Contract version and registration identity distinguish the new format | Design lines 158-159, 203-205 |
| D6 | Interfaces | Replay consumes only persisted request plus exact ticket reference | Design lines 159-167 |
| D6 | ExternalEffects | NoMaterialImpact on retry: no tracker or mutable artifact read is permitted | Design desired end state 7 |
| D6 | Operations | Corruption is detected on durable read, but stale accepted-pointer identity is not defined as a persistence guard | Design lines 203-209; R1 |
| D6 | Users | Stable replay prevents a retry from changing task authority silently | Ticket scope and Design replay decision |
| D6 | NeighboringTickets | D3 later owns stage-state tables; D7 creates/advances later operations | Live D3/D7 scopes |
| D7 | Code | Adds bounded prompt and typed authority manifest but no harness execution | Design lines 127-129, 166-167 |
| D7 | Data | Authority manifest retains Ticket-first and source order without duplicating the ticket | `StageTaskAuthority` model |
| D7 | Configuration | Agent, model, timeout, retry, workspace, and publication remain definition/harness choices | Design line 167 |
| D7 | Interfaces | Creates an explicit CAP-D2 to CAP-D4 materialization handoff | Design lines 127-129, 166-167 |
| D7 | ExternalEffects | NoMaterialImpact in this ticket: CAP-D4 performs workspace/session effects later | Ticket exclusions |
| D7 | Operations | Downstream source/session/currentness checks can contain stale output but occur after request creation | Live D4 acceptance criteria; C3 |
| D7 | Users | Agent receives exact authority through later materialization rather than an oversized prompt | Design task-construction explanation |
| D7 | NeighboringTickets | D4 owns producer custody; D5 publication; D7 progression | Live issue graph |
| D8 | Code | Adds Schema and UTF-8 byte filters at each request/result boundary | Design lines 145-165, 207-211 |
| D8 | Data | Bounds apply per record; no aggregate quota, retention, or reservation is claimed | Design lines 164-165 and exclusions |
| D8 | Configuration | Numeric limits are exported constants reflected in Schema/registration identity | Design lines 164-165 |
| D8 | Interfaces | Malformed, mistagged, oversized, or corrupt values fail before crossing persistence/prepared-output seams | Design desired end state 6 |
| D8 | ExternalEffects | Repository reads stop at the per-source byte cap | Design exact request flow |
| D8 | Operations | Typed failures and nonclaimability are the current detection path; no dedicated metrics or alert is designed | Current diagnostics/health evidence |
| D8 | Users | Prevents oversized inputs/results from exhausting the declared per-operation envelope | Ticket criteria 3 and 6 |
| D8 | NeighboringTickets | D12 later supplies integrated capacity-boundary evidence; aggregate capacity remains elsewhere | Live D12 scope |
| D9 | Code | Adds specialized local Schemas and distinct projection logic | Design contract table and lines 141-143 |
| D9 | Data | Pins policy/package/promotion/graph/checkpoint/finality identities | Design lines 136-143 |
| D9 | Configuration | Design policies and implementation checkpoint policy must match contract-local rules | Design compatibility paragraph |
| D9 | Interfaces | Typed owner-result fields avoid generic artifact-role substitution | Design line 141 |
| D9 | ExternalEffects | NoMaterialImpact: reviews, gates, Provenance, and implementation execution remain external | Ticket exclusions |
| D9 | Operations | Missing or incompatible specialized identities block compatibility or decoding | Design contract-local invariants |
| D9 | Users | Preserves different document and implementation outcomes and final evidence | Ticket criterion 1 |
| D9 | NeighboringTickets | D9 owns Design package/promotion/graph effects; D4/D7 own implementation execution/progression | Live issue graph; Provenance snapshot unavailable, not inferred |
| D10 | Code | Adds local negative, boundary, corruption, ordering, and extension tests | Design lines 347-363 |
| D10 | Data | Legacy placeholder rows remain factual and unclaimable; no conversion occurs | Design exclusions and durable replay decision |
| D10 | Configuration | Explicit tuple order replaces filesystem or object-value discovery | Design registration decision |
| D10 | Interfaces | Seventh contract traverses erased assemble/build/prepare operations by registration alone | Design lines 219-223 |
| D10 | ExternalEffects | Test repository observations are injected; no production agent or publication effect is added | Design testing paragraph |
| D10 | Operations | Restart/corruption tests verify stable fail-closed behavior; legacy recovery remains D11 | Design lines 347-363; live D11 scope |
| D10 | Users | NoMaterialImpact: tests and format fencing do not expose a new user workflow | Ticket exclusions |
| D10 | NeighboringTickets | D11 owns offline legacy handling and D12 integrated verification | Live issue graph |

## Risk Register

| ID | Decisions | Surfaces | Evidence | Trigger | Failure mode | Consequence and materiality |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | D2, D6, D7 | Data, Interfaces, Operations, NeighboringTickets | The flow derives accepted predecessors, performs external artifact reads, then persists a claimable request; revision 2 specifies hashes but no atomic comparison of current Generation/run/revision, accepted pointers, and target head immediately before persistence. The normative parent requires successors to consume only current `acceptedRevision`; D7 owns guarded progression but runs later. | An accepted predecessor, current Generation/run/revision, or target parent changes after source discovery or during artifact reads and before the request becomes claimable | The request is exact and hash-valid for the old snapshot, so content/hash checks pass while claimable work carries stale authority | A stage can produce from a revision that is no longer accepted, violating a parent acceptance invariant and potentially propagating stale technical decisions. This can change Design acceptance and downstream work, so it is material. |
| R2 | D2, D3, D6 | Code, Data, Interfaces, Operations | `ArtifactReference` carries repository, workflow, Generation, source stage/revision, commit, path, blob, and content identities, but the validation flow names membership/order and observed commit/path/blob/content checks without requiring equality to the current target repository, workflow/Generation, expected role, and exact accepted revision pointer. A valid Git object and hashes prove object identity, not authority for this workflow. | A malformed caller or durable input supplies a hash-valid artifact reference from another repository, workflow, Generation, stage, or nonaccepted revision under an otherwise allowed role | Source assembly accepts semantically wrong-scope bytes because all local Schema, Git, blob, and content checks succeed | The resulting request attributes unrelated or stale content as accepted authority. That can disclose cross-repository content to an agent and produce incorrect downstream artifacts, violating exact-source and acceptance criteria; the consequence is material. |

## Risk Characterization

| Risk | Current rating, exposure, uncertainty, and basis | Detectability and signal | Reversibility | Blast radius | Current controls | Required controls | Residual rating, assumptions, and uncertainty |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | Impact `Significant`; likelihood `Unknown`, so no matrix score. Exposure is each source-assembly-to-persistence interval. Uncertainty `Medium`: the deterministic race window is evidenced, but no assembly timing or accepted-pointer change frequency exists. | No designed preclaim signal distinguishes stale acceptance. Existing hash/Schema checks report byte or durable corruption, not a once-valid source snapshot becoming stale. Later D4/D7 currentness failures may be after task exposure. | Operator/new-Generation or monotonic revision recovery is possible before publication; after downstream acceptance it requires supersession and regeneration. | One stage request initially; without containment it can affect its producer output and all later stages in the Generation. | Exact immutable reads; ordered source hash; persisted request hash; later D4 source/currentness matching and D7 guarded progression | Add an atomic fail-closed persistence/claimability invariant and mismatch diagnostic; retain downstream containment and recovery | Impact `Significant`; likelihood `Unknown`; no score. Assumes the missing atomic guard is added and C3/C4 hold. Residual uncertainty `Medium` until a deterministic race test proves stale requests never become claimable. |
| R2 | Impact `Significant`; likelihood `Unknown`, so no matrix score. Exposure is every accepted artifact assembled into a request. Uncertainty `Medium`: the omitted equality rules and consequence are direct, but no evidence supports occurrence frequency. | Exact Git/hash checks cannot distinguish a valid wrong-scope artifact. No named cross-scope mismatch signal exists. Detection could occur only through later human review or unrelated currentness checks. | The request and outputs can be superseded and rebuilt if detected; any disclosed content cannot be made undisclosed. | One request and agent session initially, with possible propagation to later artifacts; confidentiality impact is bounded to the referenced repository content but authorization evidence was not supplied. | Schema-shaped `ArtifactReference`; role ordering; exact commit/path/blob/content verification; request hashes | Add explicit cross-field authority equality checks, typed mismatch reasons, and before-exposure verification | Impact `Significant`; likelihood `Unknown`; no score. Assumes all missing equality checks are added before persistence and rerun on durable decode. Residual uncertainty `Medium` because no authentication or repository-access evidence beyond the current GitHub App deployment was supplied. |

## Control Coverage

| Risk | Prevention | Detection | Containment | Recovery |
| --- | --- | --- | --- | --- |
| R1 | `Missing:Design must require one guarded store transition that rechecks current Generation, StageRun/revision, exact accepted predecessor pointers, workflow definition, and target parent immediately before persisting or enabling the request` | `Missing:typed stale-source/currentness reason must identify the mismatched pointer or scope and keep the operation nonclaimable` | C3 | C4 |
| R2 | `Missing:Design must require every source reference to equal the current repository, workflow, Generation, expected role/stage, and exact accepted revision identity before any bytes enter a request` | `Missing:typed cross-scope/identity mismatch must be observable before persistence and on durable decode` | `Missing:no evidenced control currently prevents a hash-valid wrong-scope request from reaching task materialization` | C4 |

## Control Ledger

| ID | Risks | Status | Kind | Obligation | Ownership class | Owner | Delivery phase | Verification target | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | R1, R2 | Existing | Prevention | Read only the named immutable Git object, enforce byte bounds, and compare observed commit/path, blob SHA, and content SHA-256 | CurrentTicket | `workflowd-vs3.4.2` | Implementation | V1: changed object identity or bytes cannot enter a request | Design D3 and ticket criteria 2-3 |
| C2 | R1, R2 | Existing | Detection | Schema-decode persisted operation/request envelopes and recompute outer and nested canonical hashes before task construction | CurrentTicket | `workflowd-vs3.4.2` | Implementation | V2: malformed or hash-corrupt durable input remains nonclaimable with a typed reason | Design D6; current store corruption pattern |
| C3 | R1 | Required | Containment | Refuse producer resume, result acceptance, or custody transfer unless workflow, Generation, run, revision, operation, source, session, and lease identities still match | DownstreamTicket:workflowd-vs3.4.4 | `workflowd-vs3.4.4` | BeforeExposure | V3: a stale source/request result cannot transfer custody or release publication | Explicit D4 acceptance criterion and dependency on D2/D3 |
| C4 | R1, R2 | Required | Recovery | Supersede stale work and create only a monotonic replacement revision or successor Generation from current accepted authority | DownstreamTicket:workflowd-vs3.4.7 | `workflowd-vs3.4.7` | Recovery | V4: stale work remains terminal/noncurrent and a rebuilt request has new exact identity | Explicit D7 replacement/currentness scope and parent StageRevision contract |

## Verification Plan

| ID | Risks and controls | Claim and boundary | Method and rationale | Pass evidence | Owner and phase | Automation gap |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | R1, R2; C1 | At the repository-port/source-assembler boundary, altered commit, path, blob, content, UTF-8 bytes, role membership, duplication, or order never yields `ExactStageSources` | `ComponentIntegration`: injected repository observations are the lowest boundary that exposes request/observation mismatch without real network nondeterminism | Each mutation returns the exact typed failure and no request/persistence call occurs; exact-limit bytes pass once | `workflowd-vs3.4.2`, Implementation | None |
| V2 | R1, R2; C2 | At the SQLite/store decode boundary, malformed input, changed nested request, wrong request hash, or wrong operation hash cannot build a task | `ComponentIntegration`: direct SQLite mutation through production decoders is the existing reliable corruption boundary | Every mutation yields its expected `malformed`, `hash_mismatch`, or `identity_mismatch` data error; no claimable replacement or task appears | `workflowd-vs3.4.2`, Implementation | None |
| V3 | R1; C3 | At producer custody transfer, an output from a source/request identity that is no longer current cannot persist prepared output or release publication | `ComponentIntegration`: file-SQLite plus deterministic source supersession is the lowest reliable guarded-transition boundary | Stale transfer affects zero current rows, remains nonadvancing with an exact diagnostic, and the current request retains sole custody eligibility | `workflowd-vs3.4.4`, BeforeExposure | None; downstream ticket has not yet implemented the seam |
| V4 | R1, R2; C4 | At StageRevision/Generation recovery, stale work never reopens and replacement uses a higher exact identity assembled from current accepted pointers | `ComponentIntegration`: file-SQLite progression/restart test proves monotonic recovery and durable currentness | Old work is terminal/noncurrent across restart; exactly one new request has the new revision or Generation identity and current accepted source set | `workflowd-vs3.4.7`, Recovery | None; downstream ticket has not yet implemented the seam |

## Residual Risk and Decisions

| Risk | Assumed controls | Residual rating and basis | Materiality | Decision status | Decision owner and evidence |
| --- | --- | --- | --- | --- | --- |
| R1 | C1, C2, C3, C4 plus the missing atomic persistence/currentness guard and diagnostic | Impact `Significant`, likelihood `Unknown`, no score; the omitted guard is not yet a Design obligation, so material uncertainty remains | Material | NeedsDecision | No risk acceptance is requested: Design owner for revision 2 must add the invariant; ticket/parent require accepted-revision currentness |
| R2 | C1, C2, C4 plus the missing cross-field authority checks, diagnostic, and containment | Impact `Significant`, likelihood `Unknown`, no score; valid wrong-scope content remains possible under the written validation sequence | Material | NeedsDecision | No risk acceptance is requested: Design owner for revision 2 must add the invariant; ticket criteria require exact source identity |

## Excluded Speculation

| Candidate | Why considered | Missing evidence link | Disposition |
| --- | --- | --- | --- |
| Canonical NFC hashing changes exact artifact bytes | Request hashing normalizes JSON strings while artifact identity hashes returned bytes | No evidence shows persistence rewrites source content or that the independently stored content SHA fails to bind normalization-distinct bytes | Excluded |
| Git object retention causes replay failure | The architecture states historical Git objects can become unavailable | Replay persists technical bytes and rereads only the content-addressed ticket row; no evidence links later Git retention loss to replay | Excluded |
| Aggregate SQLite or workspace exhaustion | Requests and results have per-record ceilings | Ticket and Design expressly exclude aggregate capacity, and no workload/capacity evidence establishes an occurrence or consequence for this change | Excluded |
| Malicious database actor rewrites values and all hashes coherently | Canonical hashes are integrity checks, not authentication | No threat model, actor capability, authentication requirement, or exposure evidence was supplied | Excluded |
| Provenance graph content is wrong or unavailable at Structure execution | The Structure request will bind a future graph snapshot scope | No authoritative graph snapshot or owner result was supplied, and this Design does not execute or validate Provenance graph semantics | Excluded |

## Human Risk Decision

None.
