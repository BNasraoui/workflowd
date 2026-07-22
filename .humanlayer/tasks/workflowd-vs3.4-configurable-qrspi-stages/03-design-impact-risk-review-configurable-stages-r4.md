# Impact and Risk Review

## Subject

| Field | Identity |
| --- | --- |
| Ticket | `workflowd-vs3.4`, “Run configurable QRSPI stages and publish their artifacts” |
| Design | `.humanlayer/tasks/workflowd-vs3.4-configurable-qrspi-stages/03-design-discussion-configurable-stages-r4.md`, revision 4, blob `9534cb55980aa72638a91b74816cfad04aaaedb8`, SHA-256 `444b525f15e4d1065f7c91cf532b5f2a3d92bce5a7513d4f1c262ad635cbcf43` |
| Ownership report | `.humanlayer/tasks/workflowd-vs3.4-configurable-qrspi-stages/03-design-boundary-review-configurable-stages-r4.md`, revision 4, blob `e2aa5eb4ef9ee68bbd6070472e9d84f051b02260`, SHA-256 `806f2f10b52d35c2e9d27dd920f4c50e19e949abf02e30c2e9cd44ac6eb8ecb5`, entry verdict `ScopeClean` |
| Review binding | `.humanlayer/tasks/workflowd-vs3.4-configurable-qrspi-stages/03-design-acceptance-binding-r4.json`, contract version 1, SHA-256 `092bd8990bb83c2aac19bea5962a1fc510c64215f38540501af32a8dcd4d8998`; all four bound artifact blob IDs and content SHA-256 values independently matched the files |
| Source set | Questions blob `ec9ddbcbc6165087394066a2df9d6a80061ef38e`, SHA-256 `4279e73b21aa25918639d3fbfed8574367d66023a69e6f3b53b60c28c3e24876`; Research blob `56fc1422df29da74bb81c8830eb46ba10c9f4ec4`, SHA-256 `c88f48fbdb535bff05557a4007d77b0d2c25c25e0e893412f1a67490b6208701`; bound source-set SHA-256 `71674132945f9a0043fb230e696d6daacd12438b443600b7d8211e25c0eb599a` |
| Workflow Generation | WorkflowId `BNasraoui/workflowd:workflowd-vs3.4`; Generation `1`; repository base and examined HEAD `42e129ab75ea0de39aa1bd6db4502325cd3effb1`; workflow-definition SHA-256 `6f7f7dcc51ce36973696247baecd645ba622a1e6ac05ca3d94d5ba6eb23da001` |
| Policy revision | Design `workflowd.design-acceptance@1` / `30560f4776d78c0767d7a0e4f5ec71d780bc7cd0fc2edec92593e1945cbc5251`; promotion `workflowd.provenance-promotion@1` / `c49d6d0f646616efb87e13e1be4cb9f449e187796775d9f6476883584c466bbf`; Structure `workflowd.structure@1` / `d360ea62f9b7e1847c0da5b630af93fd28f98fb7f58e88d7b5f026be5922b85d`, as pinned by the authoritative binding |

## Verdict

`NeedsRiskDecision`

## Human Summary

Revision 4 supplies complete Design-level controls and verification obligations for exact publication reconciliation, mandatory handoff availability and same-record recovery, and legacy upgrade recovery; none of those traces requires a Design change. Cumulative retained SQLite records and nonterminal workspaces can, under sustained use on finite shared storage, exhaust capacity and stop writes for QRSPI and unrelated controller work. Aggregate capacity policy is neither owned by this ticket nor assigned to a downstream ticket, so the Design is otherwise complete but cannot become `ImpactReady` until the accountable human decides whether to accept, defer, or obtain evidence and an owner for material risk R9.

## Source Inventory

| Source | Status | Revision and completeness | Relevance |
| --- | --- | --- | --- |
| Current ticket `workflowd-vs3.4` | Examined | Read-only Beads record, updated `2026-07-22T16:11:47Z`; task, exclusions, design, all 11 criteria, dependencies, dependents, and zero comments examined | Product authority, intended outcomes, and owned acceptance boundary |
| Exact product issue graph | Examined | Read-only `bd show` and both-direction dependency graph for the target; parent, prerequisite, downstream product owners, and ownership-relevant `workflowd-3d8` examined | Cross-ticket effects, owners, and safe delivery order |
| Accepted Questions | Examined | Complete seven-question artifact; blob and SHA-256 match the binding | Required investigation scope |
| Accepted Research | Examined | Status `complete`, commit `5bfec302fcb6e97e8bf1f399e561ea53881a6c6e`, no open questions; blob and SHA-256 match | Current behavior and affected source/test map |
| Design revision 4 | Examined | Complete 855-line revision; repository base, blob, content SHA-256, Questions SHA-256, and Research SHA-256 match | Exact decisions under review |
| Ownership report | Examined | Exact bound revision, blob, digest, and `ScopeClean` verdict match | Entry identity and verdict only; no impact claim was used as evidence |
| Review binding | Examined | Contract version 1; supplied binding digest matches; every path-backed blob and content digest matches | Authoritative Design/report/source/Generation/policy binding |
| Normative QRSPI contract | Examined | `docs/qrspi-contract.md`, SHA-256 `55470a92b645ccfcea8f694ec43ae64b6dd9f6f7615664539e05756b4edcfc7d`, all 1,585 lines; bundled skill copy passed `bun run skill:check` | Normative identities, transitions, ownership, retention, recovery, and conformance |
| Current QRSPI code and data model | Examined | `src/config.ts`, `src/qrspi/domain.ts`, `src/qrspi/store.ts`, `src/qrspi/workflow-start.ts`, `src/qrspi/adapters.ts`, `src/store/migrations.ts` at bound HEAD | Existing validation, tables, first-child creation, currentness, and missing stage runtime |
| Current harness, workspace, interfaces, and effects | Examined | `src/agent-harness.ts`, `src/opencode/`, `src/workspace/`, `src/workspace/fix.ts`, `src/qrspi/ports.ts`, `src/layers.ts`, and worker/store seams | Existing trusted execution, custody, Git checks, and Effect composition constraints |
| Deployment and operating model | Examined | `src/main.ts`, `src/runtime.ts`, `deploy/systemd/workflowd.service`, `deploy/workflowd.env.example`, and `package.json` | Automatic current migrations, supervised workers, listener order, restart, and absent upgrade CLI today |
| Current observability | Examined | `src/http.ts`, runtime logging, durable operation/gate fields, and current store queries | Current `/health` is liveness-only; QRSPI errors are local/logged and no status/capacity product exists |
| Current tests | Examined | QRSPI, migration, harness, layer, worker, and real-Git workspace suites identified by Research | Existing evidence boundary and exact gaps covered by revision 4 obligations |
| Impact-review method references and calculator | Examined | `risk-and-control-model.md`, `verification-model.md`, `output-contract.md`, and `risk-matrix.ts`; matrix `5x5-v1` | Materiality, controls, verification, report, rating, and verdict rules |

## Design Decision Inventory

| ID | Source decision | Decision | Intended outcome | Design evidence |
| --- | --- | --- | --- | --- |
| D1 | Decision summary 1-2; Trusted definitions and catalogs | Server-owned hashed definitions select trusted versioned contracts and harnesses; one validator and one erased catalog seam reject unsafe, unknown, incompatible, or unavailable selections before claim | Configurability without repository code execution or per-stage runtime branches | Design lines 46-62, 91-188 |
| D2 | Built-in contracts and exact inputs | Six distinct typed contracts assemble bounded, immutable, authority-ordered source sets and persist exact requests and hashes | Correct stage meaning, replay, and ticket authority | Design lines 190-242 |
| D3 | Durable model; currentness | Strict tagged records and one generic operation lifecycle own leases, state, revision pointers, diagnostics, currentness, and restart | Durable progression without stale or malformed advancement | Design lines 244-375, 631-652 |
| D4 | Generation initialization; producer lifecycle | Linear initialization, session checkpoints, attempt workspaces, result validation, atomic custody transfer, cleanup fencing, and no harness publication authority | Safe agent execution and recoverable handoff to publication | Design lines 377-414 |
| D5 | Artifact publication | Verify exact scope/tree/content, create one signed sole-parent final commit, persist intent, exact-old fast-forward update, and authoritative observation | Immutable canonical artifacts with no duplicate or unauthorized Git effect | Design lines 416-450 |
| D6 | Target reconciliation | Publication conflicts, stale effects, rollback, or ambiguous observations enter one durable publication-scoped reconciliation with read-only observation and exact typed resolutions | Reconcile external Git truth without stale parent advance or destructive mutation | Design lines 471-533 |
| D7 | Implementation and revisions; progression | Accepted-only linear progression, distinct document/implementation shapes, contiguous observed commits, monotonic replacement revisions, and no PR during stages | Deterministic stage completion and checkpoint handoff | Design lines 452-469 and 64-69 |
| D8 | Mandatory owner handoffs | Validate required `.5/.6/.9/.14` capability refs before exposure; persist exact idempotent local receipts; wait and recover on the same handoff identity | Available, duplicate-safe cross-owner delivery without taking owner lifecycles | Design lines 535-586 |
| D9 | Review, gate, Design, Provenance, and reentry effects | Apply only exact typed owner results; approval alone cannot release Structure; `.9` confirmation and snapshot do; only `.14` selects bounded reentry effects | Preserve specialist ownership and prevent stale or incomplete Design advancement | Design lines 588-629 |
| D10 | Effect composition and deployment | Add one catalog/store/service/publisher/loop; validate QRSPI before activation; fail only QRSPI closed; retain local diagnostics but add no status/readiness product | Deploy the runtime without coupling unrelated service or taking operational-status ownership | Design lines 654-672 |
| D11 | Migration and offline recovery | Preserve legacy rows, never infer facts, require preflight manifest, verified backup, append-only apply/rollback, exact offline supersession, verify, then ordinary successor kickoff | Safe upgrade and recovery from shipped but unexecutable legacy child rows | Design lines 674-728 |
| D12 | Verification obligations | Use real SQLite/Git and fault injection to prove publication reconciliation, direct diagnostics, handoff availability/recovery, upgrade rollback/supersession, and the full stage matrix | Observable evidence at the lowest reliable boundaries | Design lines 730-774 |
| D13 | Residual operational risk | Retain all v1 audit records and nonterminal workspace custody; bound individual records but add no aggregate capacity policy, status, recovery, deletion, or owner | Preserve normative audit/recovery semantics without inventing an unowned capacity subsystem | Design lines 815-834; contract lines 1324-1347 |

## Affected Surface Trace

| Decision | Surface | Disposition | Evidence |
| --- | --- | --- | --- |
| D1 | Code | Introduces catalog resolution, normalized validation, compatibility checks, and generic dispatch | Design lines 138-188; current `domain.ts:222-298` validates only base descriptors |
| D1 | Data | Persists complete normalized definition and registration identity/hash | Design lines 138-153, 267-270 |
| D1 | Configuration | Replaces descriptor-only config with contract, harness, policy, availability, and handoff validation at every activation boundary | Design lines 144-153; current `config.ts:393-468` |
| D1 | Interfaces | Adds stable `StageContractRef`, `AgentHarnessRef`, `StageContract`, and catalog seam | Design lines 97-135, 158-173 |
| D1 | ExternalEffects | NoMaterialImpact: catalog and definition processing are local and definitions contain no executable effect | Design lines 48-54, 176-188 |
| D1 | Operations | Invalid current references close QRSPI before claim while registrations remain for nonterminal work | Design lines 144-153 |
| D1 | Users | Operators receive early exact configuration failure rather than latent stage failure | Design lines 146-153, 661-666 |
| D1 | NeighboringTickets | Uses `.2` harness mechanics; does not transfer StageRun/catalog/publication ownership | Design authority table lines 79-82 |
| D2 | Code | Adds six contract implementations, schema decode, request assembly, and output projection | Design lines 156-188, 190-242 |
| D2 | Data | Stores exact source bytes/references, ticket hash, source-set hash, target, and typed request | Design lines 201-235 |
| D2 | Configuration | Per-definition and per-contract input/result bounds constrain accepted payloads | Design lines 114-135, 164-179 |
| D2 | Interfaces | Each stage has a distinct request/result Schema under a common exact-source envelope | Design lines 190-242 |
| D2 | ExternalEffects | Reads immutable Git bytes only; retries cannot rediscover mutable latest paths | Design lines 229-235 |
| D2 | Operations | Bound violations and hash/source mismatch fail before execution or downstream use | Design lines 176-180, 229-234 |
| D2 | Users | Producers and reviewers receive exact authoritative context; ticket remains highest authority | Design lines 229-242 |
| D2 | NeighboringTickets | Supplies exact immutable subjects to later review, gate, Provenance, and Structure owners | Design lines 236-242; contract lines 948-962 |
| D3 | Code | Expands store transactions and one loop for produce, publish, and reconcile | Design lines 244-375 |
| D3 | Data | Adds strict tables, JSON decode, SQL checks, run/revision pointers, operation diagnostics, and immutable history | Design lines 262-337 |
| D3 | Configuration | Lease policy must cover execution, cancellation, and durable completion | Design lines 668-672 |
| D3 | Interfaces | Operation schemas repeat full scope and typed parent effects | Design lines 339-375 |
| D3 | ExternalEffects | Every intent and completion is fenced by current durable identity | Design lines 631-647 |
| D3 | Operations | Data errors quarantine readable identities; retry, uncertainty, restart, and cleanup retain owned state | Design lines 641-652 |
| D3 | Users | Stale or malformed work cannot silently advance; exact diagnostics remain queryable | Design lines 641-652 |
| D3 | NeighboringTickets | Local state accepts owner outputs but does not expose owner stores or claim owner work | Design lines 335-337, 588-629 |
| D4 | Code | Adds workspace preparation, launch/session checkpoints, result decode, candidate verification, and atomic custody transfer | Design lines 394-414 |
| D4 | Data | Adds attempt execution, session, cleanup, prepared-result, candidate, and custody records | Design lines 280-299 |
| D4 | Configuration | Harness/agent/model/timeout/retry selections are server-owned and availability-checked | Design lines 114-122, 184-188 |
| D4 | Interfaces | Harness receives task/session capability but no store, publisher, progression, or repository credential | Design lines 166-188 |
| D4 | ExternalEffects | Creates/resumes/aborts OpenCode sessions and manages workspaces; cannot publish Git | Design lines 394-414 |
| D4 | Operations | Unconfirmed cleanup fences replacement; custody cleanup preserves uncertain/nonterminal publication | Design lines 409-414 |
| D4 | Users | Late or invalid agent output becomes audit/retry/failure rather than canonical work | Design lines 403-413 |
| D4 | NeighboringTickets | Reuses `.2` execution/session mechanics and leaves `.7` presentation/retention policy outside | Design lines 79-85 |
| D5 | Code | Adds a dedicated publisher distinct from current ordinary-push `Workspace.publishFix` | Design lines 416-437; current `workspace/fix.ts:38-130` |
| D5 | Data | Persists one final SHA, signature evidence, old SHA, idempotency identity, observation, and immutable reference | Design lines 425-436 |
| D5 | Configuration | Requires controller signing key and authorized path/content policy | Design lines 419-428, 668-672 |
| D5 | Interfaces | Requires exact compare-and-set, fast-forward-only update and authoritative observation | Design lines 431-449; contract lines 493-539 |
| D5 | ExternalEffects | Mutates the ticket branch with one verified signed commit; never creates a PR | Design lines 425-436, 468-469 |
| D5 | Operations | Unknown mutation is observed before retry; mismatches do not advance the cursor | Design lines 444-450 |
| D5 | Users | Reviewers consume immutable artifact identity, not mutable worktree/branch state | Contract lines 469-488 |
| D5 | NeighboringTickets | Creates references consumed by `.8`; does not implement presentation | Design lines 86-87 |
| D6 | Code | Adds one publication-scoped reconcile claim path and guarded resolution application | Design lines 499-527 |
| D6 | Data | Stores old/final/observed SHAs, evidence hash, saved parent state, reason, allowed resolution, exact error, and timestamps | Design lines 477-497, 529-533 |
| D6 | Configuration | Observation and retry budgets govern waiting; no weaker mutation is configurable | Design lines 507-527 |
| D6 | Interfaces | Typed actions are `ObserveAgain`, `ExternalStateRestored`, `AcceptChangedTarget`, or `FailGeneration` bound to latest observation | Design lines 519-527 |
| D6 | ExternalEffects | Reconciliation observes Git read-only and never force-pushes, resets, deletes, or selects a replacement SHA | Design lines 507-510 |
| D6 | Operations | Atomically blocks publication, restores prior state only on exact evidence, or supersedes through ordinary WorkflowStart | Design lines 499-527 |
| D6 | Users | Conflicts remain visible and blocked for an exact resolution rather than being overwritten | Design lines 516-533 |
| D6 | NeighboringTickets | NoMaterialImpact on generic PR reconciliation: identity and lifecycle are explicitly limited to this ticket's publication | Design lines 471-474 |
| D7 | Code | Adds linear progression, revision replacement, and implementation step loop without per-stage workers | Design lines 452-469 |
| D7 | Data | Distinct document revisions, implementation steps/checkpoints, monotonic ordinals, and immutable terminal history | Design lines 276-299, 452-466 |
| D7 | Configuration | Declaration order, activation, review, and gate policy select transitions; arbitrary DAG remains invalid | Design lines 64-69, 138-150 |
| D7 | Interfaces | Checkpoints carry ordered commits/evidence but no PR identity | Design lines 454-460 |
| D7 | ExternalEffects | Each implementation commit is authoritatively observed before another producer is released | Design lines 452-460 |
| D7 | Operations | Failed publication creates a new revision; old terminal publication never reopens | Design lines 462-466 |
| D7 | Users | Successors consume only accepted revisions; plan-only workflows can complete without implementation | Design lines 438-442, 468-469 |
| D7 | NeighboringTickets | Final verification and PR publication remain with later owners | Design lines 468-469, 844-851 |
| D8 | Code | Adds a trusted handoff catalog, availability guards, durable receipt insertion, submit, and observe paths | Design lines 535-586 |
| D8 | Data | Stores deterministic handoff ID, exact request/result hashes, state, attempts, observations, errors, and timestamps | Design lines 574-586 |
| D8 | Configuration | Mandatory refs derive from configured review/gate/Design paths and are validated before ingress and each activation | Design lines 551-570 |
| D8 | Interfaces | Stable local adapter contract exposes only availability, idempotent submit, and exact observe | Design lines 537-553 |
| D8 | ExternalEffects | Submits exact owner request once by idempotency identity; restoration resubmits/observes the same row | Design lines 574-581 |
| D8 | Operations | Missing capability blocks new QRSPI effects but permits unrelated service and exact recovery work | Design lines 565-572 |
| D8 | Users | A mandatory owner outage parks the exact workflow rather than losing or duplicating its request | Design lines 574-586 |
| D8 | NeighboringTickets | `.5`, `.6`, `.9`, and `.14` own their lifecycles; the local receipt is the required enabling seam | Design lines 541-560, 588-629 |
| D9 | Code | Adds exact typed result validation, deterministic promotion-request construction, snapshot gating, and bounded reentry application | Design lines 588-629 |
| D9 | Data | Stores exact scope/package/response/request/result/snapshot/directive identities and local receipts only | Design lines 310-313, 602-628 |
| D9 | Configuration | Design, promotion, and Structure policy identities are pinned before publication | Design lines 130-135, 236-240 |
| D9 | Interfaces | Approval sets accepted Design but only matching `.9` result/snapshot releases Structure; `.14` alone issues reentry | Design lines 602-629 |
| D9 | ExternalEffects | Provenance mutation/observation and human response transport remain outside; this ticket submits and consumes exact values | Design lines 608-619 |
| D9 | Operations | Partial, conflicting, absent, uncertain, duplicate, or stale owner outcomes remain blocked | Design lines 615-619, 621-629 |
| D9 | Users | Human approval cannot bypass promotion and cannot apply to another package/revision | Design lines 602-619; contract lines 797-825 |
| D9 | NeighboringTickets | Explicit lifecycle owners are `.5`, `.6`, `.9`, and `.14`, with safe sequence before Structure exposure | Design lines 82-89, 588-629 |
| D10 | Code | Extends one Effect layer graph and starts one supervised QRSPI loop | Design lines 654-664; current `layers.ts:26-153`, `runtime.ts:98-224` |
| D10 | Data | NoMaterialImpact beyond D3 records: no separate status/capacity store is introduced | Design lines 656-666 |
| D10 | Configuration | Adds complete QRSPI definitions, signing, selections, and capability registrations; repository project config remains disabled | Design lines 668-672 |
| D10 | Interfaces | QRSPI ingress fails closed with exact local errors; no status HTTP or Effect interface is added | Design lines 661-666 |
| D10 | ExternalEffects | QRSPI activation failure prevents new QRSPI claims but does not stop listener or unrelated workers | Design lines 661-666 |
| D10 | Operations | Uses existing supervision; current `/health` remains liveness-only and future readiness/status is downstream-owned | Current `http.ts:21-35`; Design lines 661-666 |
| D10 | Users | Operators can query durable rows/offline commands but receive no aggregate QRSPI status product from this ticket | Design lines 320-323, 661-666 |
| D10 | NeighboringTickets | `workflowd-3d8` owns aggregation, readiness, terminal-failure presentation, and safe retry; not capacity policy | Design lines 40-42, 89, 320-323 |
| D11 | Code | Adds noninteractive preflight/apply/resolve/verify command boundary and prevents new claimer from touching legacy rows | Design lines 674-728 |
| D11 | Data | Preserves legacy bytes, classifies all current/nonterminal rows, stores canonical manifest and backup evidence, and appends schema only | Design lines 676-718 |
| D11 | Configuration | Commands bind database path, manifest hash, workflow, Generation, definition, and exact action | Design lines 688-697 |
| D11 | Interfaces | CLI returns complete bounded diagnostics and permitted next command before writes | Design lines 699-710 |
| D11 | ExternalEffects | Apply fsyncs/verifies same-filesystem DB/WAL/SHM backup; resolve supersedes exact legacy work without Git/Provenance inference | Design lines 712-728 |
| D11 | Operations | Incompatible/dormant workflows alone remain blocked; rollback or verified restore precedes failure return | Design lines 712-725 |
| D11 | Users | Operator can recover using shipped commands only; wrong or changed identity fails without writes | Design lines 688-728 |
| D11 | NeighboringTickets | Ordinary authenticated successor kickoff remains `.3`; migration does not create stage state | Design lines 720-728 |
| D12 | Code | NoMaterialImpact on production logic: obligations constrain implementation evidence rather than add runtime branches | Design lines 730-774 |
| D12 | Data | Fixtures and assertions cover exact durable rows, manifests, observations, and terminal resolutions | Design lines 735-742 |
| D12 | Configuration | Layer tests vary mandatory registrations, definitions, bounds, versions, and policies | Design lines 739-750 |
| D12 | Interfaces | Contract tests exercise catalog, handoff, Git, offline CLI, and negative PR boundaries | Design lines 735-770 |
| D12 | ExternalEffects | Real Git repositories and faulted adapters prove mutation/observation and recovery ordering | Design lines 735-774 |
| D12 | Operations | Restart, wait, failure, rollback, unclaimable state, and recovery drill are explicit pass targets | Design lines 735-742 |
| D12 | Users | Human execution is limited to the actual residual-risk gate; behavioral proofs are deterministic automation | Design lines 730-774; verification model |
| D12 | NeighboringTickets | Owner adapters are replaceable test boundaries; tests do not absorb owner lifecycle implementation | Design lines 739-742 |
| D13 | Code | No aggregate capacity logic or garbage collector is introduced | Design lines 826-830 |
| D13 | Data | QRSPI audit/revision/execution records have no automatic deletion; workspaces remain while publication/effect is nonterminal | Design lines 817-824; contract lines 1324-1347 |
| D13 | Configuration | Individual payload/diff bounds exist, but no total database/workspace limit, reserve, or admission setting exists | Design lines 821-830 |
| D13 | Interfaces | No capacity status, signal, or recovery API is invented | Design lines 826-830 |
| D13 | ExternalEffects | Long-lived uncertain publication retains workspace custody and can consume shared filesystem capacity | Design lines 819-824 |
| D13 | Operations | Sustained accumulation can exhaust shared storage, prevent SQLite/Git writes, and affect unrelated controller work | Design lines 817-830 |
| D13 | Users | Operators lack an aggregate threshold, warning, owned recovery procedure, or accepted exposure condition | Design lines 826-834 |
| D13 | NeighboringTickets | No graph ticket owns capacity policy; `workflowd-3d8` owns status/readiness only and cannot be presumed the owner | Design lines 40-42, 826-834; examined issue graph |

## Risk Register

| ID | Decisions | Surfaces | Evidence | Trigger | Failure mode | Consequence and materiality |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | D1 | Code, Data, Configuration, Operations | Current config validates descriptor shape only (`config.ts:393-468`, `domain.ts:222-298`); revision 4 adds catalog/availability checks | A malformed, incompatible, unknown, or removed active definition reaches claim | Work executes under unresolved or mismatched contract/harness semantics | Exact-input and restart criteria fail and durable work may become unrecoverable; material requirement violation |
| R2 | D2, D4 | Code, Data, Interfaces, Users | Current QRSPI has no stage executor; contract requires bounded Schema boundaries; current harness proves typed session phases | Untrusted or stale source/result bytes pass an erased or durable boundary | Wrong authority, oversized payload, or malformed output becomes prepared/published stage work | Canonical artifact can misstate ticket meaning or poison downstream stages; material data/trust loss |
| R3 | D3, D4, D7 | Code, Data, ExternalEffects, Operations | Current WorkflowStart uses transaction/currentness fencing; revision 4 adds stage/run/revision/session/attempt checks | Lease expiry, replacement, restart, or newer Generation races a late result | Stale attempt mutates state, transfers custody, or releases a successor | Wrong workflow state or external effect advances; explicit criterion 9 violation with broad workflow blast radius |
| R4 | D5 | Code, Interfaces, ExternalEffects, Operations | Current fix publisher uses ordinary refspec push (`workspace/fix.ts:101-109`); normative contract requires exact-old CAS | Candidate/path/signature mismatch or concurrent branch movement occurs near publish | Unauthorized tree or non-exact commit is published, or concurrent work is overwritten/adopted | Canonical Git history and artifact integrity are lost; recovery may be difficult, so material |
| R5 | D5, D6 | Data, Interfaces, ExternalEffects, Operations, Users | Design observation matrix and reconciliation transitions cover success, absence, conflict, rollback, stale effect, unreadability, and restart | Mutation outcome is unknown, head conflicts, evidence differs, or currentness is lost after effect | Publication is duplicated, silently abandoned, or advances a stale parent | Git and Workflowd diverge or workflow stalls/advances incorrectly; material acceptance and operational failure |
| R6 | D8, D9 | Configuration, Interfaces, Operations, Users, NeighboringTickets | Mandatory refs are derived before exposure; exact handoff row survives unavailable adapter and restart | Required owner capability is absent/lost, delivery duplicates, or result identity mismatches | Boundary request disappears/duplicates or wrong owner outcome advances local stage state | Review/gate/Provenance obligations are bypassed or workflow becomes unrecoverably parked; material cross-ticket failure |
| R7 | D9 | Data, Interfaces, Operations, NeighboringTickets | Exact acceptance scope, package response, promotion result/snapshot, and `.14` directive are all required | Stale/partial/uncertain owner result or over-broad reentry directive arrives | Design releases Structure early or unrelated outputs are invalidated/reused | Unapproved meaning drives work or accepted derived work is corrupted; material authority violation |
| R8 | D11 | Data, ExternalEffects, Operations, Users | Current store applies migrations automatically and has shipped legacy child rows with no executor; revision 4 requires offline classification and recovery | Existing database contains dormant, malformed, partial, or externally affected rows during upgrade | Migration invents state, damages rows, cannot roll back, or new runner claims legacy work | Audit truth or external-effect safety is lost and service recovery may require difficult restoration; material deployment risk |
| R9 | D13 | Data, ExternalEffects, Operations, Users | Design lines 817-830 and normative contract lines 1324-1347 establish indefinite audit retention, nonterminal custody, per-record bounds, and no aggregate control | A finite shared volume receives sustained workflows/revisions/attempts or long-lived uncertain publication | SQLite and workspace use grows until SQLite or Git cannot write | QRSPI and unrelated controller work can fail on the shared volume; broad service disruption makes this material and requires explicit acceptance |

## Risk Characterization

| Risk | Current rating, exposure, uncertainty, and basis | Detectability and signal | Reversibility | Blast radius | Current controls | Required controls | Residual rating, assumptions, and uncertainty |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | Impact `Moderate (3)`; likelihood `Unknown`, no score. Exposure is each definition activation/restart; future implementation-defect frequency has no evidence. Uncertainty `Medium`. | Exact validation error before claim, observed by operator/runtime | Operator configuration correction while no work is exposed | One QRSPI definition and its referenced durable work | Base Schema and cross-field validation | C1 | Impact `Minor (2)`; likelihood `Unknown`, no score, assuming C1. Uncertainty `Low`; fail-closed behavior leaves bounded QRSPI unavailability |
| R2 | Impact `Significant (4)`; likelihood `Unknown`, no score. Exposure is each stage revision boundary; no implementation occurrence evidence. Uncertainty `Medium`. | Schema/hash/bound failure before prepared output or publication, observed by operation owner | Retry/new revision before publication; published wrong meaning needs revision | One revision and all successors consuming it | Existing trusted harness payload Schemas | C2, C3 | Impact `Minor (2)`; likelihood `Unknown`, no score, assuming C2-C3. Uncertainty `Low`; invalid data remains local and blocked |
| R3 | Impact `Significant (4)`; likelihood `Unknown`, no score. Exposure is each attempt/state transition; race frequency is unsupported. Uncertainty `Medium`. | Zero-row guarded transaction, stale audit, cleanup state, or reconciliation at/before effect | Same-record retry/reconcile; irreversible external effect is not assumed absent | One Generation, its branch, and downstream stages | Existing WorkflowStart and harness fencing patterns | C3, C4, C5 | Impact `Minor (2)`; likelihood `Unknown`, no score, assuming controls. Uncertainty `Medium` because external timing remains variable |
| R4 | Impact `Significant (4)`; likelihood `Unknown`, no score. Exposure is each artifact/implementation publication. Uncertainty `Medium`. | Pre-mutation verification or authoritative post-update mismatch, observed by publisher/reconciler | Pre-effect rejection is automatic; post-effect requires R5 reconciliation | Ticket branch, artifact consumers, and current Generation | Existing sole-parent/trailer/signature patterns do not provide exact-old QRSPI update | C6, C7 | Impact `Minor (2)`; likelihood `Unknown`, no score, assuming controls. Uncertainty `Low`; exact-old failure is contained before advancement |
| R5 | Impact `Significant (4)`; likelihood `Unknown`, no score. Exposure is each publication intent/observation; conflict/outage rate is unknown. Uncertainty `Medium`. | Durable observation mismatch/wait/reconciliation row before parent advance, queryable by owner | Same publication retry, exact reconciliation resolution, successor WorkflowStart, or Generation failure | One publication/Generation; stale audit may span predecessor and successor | Existing WorkflowStart demonstrates intent/observation but no QRSPI publisher/reconciler exists | C7, C8, C9 | Impact `Moderate (3)`; likelihood `Unknown`, no score, assuming controls. Uncertainty `Medium`; unresolved external conflict may cause bounded long-lived stall but not stale advance |
| R6 | Impact `Significant (4)`; likelihood `Unknown`, no score. Exposure is each configured owner crossing and restart; outage/delivery frequency is unknown. Uncertainty `Medium`. | Availability guard before effect; queryable `waiting_capability`, attempts, observations, mismatch, and exact error | Restore adapter and submit/observe same row; wrong result remains blocked | One handoff and parent stage; Design path can block Structure | No current QRSPI handoff implementation | C10, C11, C12, C13 | Impact `Moderate (3)`; likelihood `Unknown`, no score, assuming controls. Uncertainty `Medium`; owner outage can stall but cannot lose identity or advance stale work |
| R7 | Impact `Significant (4)`; likelihood `Unknown`, no score. Exposure is each Design acceptance/promotion/reentry result. Uncertainty `Medium`. | Exact identity/hash mismatch before state transition, visible in handoff diagnostics | Same handoff observation, new Design revision, or bounded reentry replay | Design and transitively affected Structure/Plan outputs | Normative acceptance scope and owner boundaries | C4, C12, C14 | Impact `Minor (2)`; likelihood `Unknown`, no score, assuming controls. Uncertainty `Low`; mismatch remains blocked |
| R8 | Impact `Significant (4)`; likelihood `Unknown`, no score. Exposure is each deployment upgrading a database; population of legacy/incompatible rows varies by deployment. Uncertainty `Medium`. | Preflight manifest/diagnostics before writes; apply/verify errors and row/hash comparison; operator observes CLI result | Transaction rollback or verified backup restore; exact dormant supersession and fresh kickoff | One database, affected workflows, and controller startup | Existing strict migrations and foreign keys; no current offline preflight/backup command | C15, C16, C17 | Impact `Minor (2)`; likelihood `Unknown`, no score, assuming controls. Uncertainty `Low`; failed upgrade restores/proves prior state and blocks only affected workflow |
| R9 | Impact `Significant (4)` x likelihood `AlmostCertain (5)` = `20 / Critical` under `5x5-v1`. Exposure is a finite shared volume operated for long enough under sustained unbounded record/workspace creation; exhaustion follows because retention has no aggregate bound. Uncertainty `High` for time-to-exhaustion and actual environment workload/capacity, not for the cumulative direction. | Today only write/Git/filesystem failure at or after exhaustion; no aggregate threshold, warning, or owner | Operator storage intervention may restore future writes, but no owned procedure reconciles failed/uncertain work; recovery is not established | Shared Workflowd database/workspace volume and unrelated controller work | Individual payload/diff bounds and custody cleanup rules | C18; `PendingDecision:R9` for aggregate prevention, detection, and recovery | Same `Significant (4) x AlmostCertain (5) = 20 / Critical` on the stated sustained finite-volume exposure, assuming only C18. Uncertainty `High`; C18 limits single-record size but not cumulative exhaustion. Material decision remains open |

## Control Coverage

| Risk | Prevention | Detection | Containment | Recovery |
| --- | --- | --- | --- | --- |
| R1 | C1 | C1 | C1 | C1 |
| R2 | C2, C3 | C2 | C2, C3 | C4 |
| R3 | C3, C4 | C4, C5 | C4, C5 | C4, C5 |
| R4 | C6 | C6, C7 | C6 | C7, C8 |
| R5 | C7 | C7, C8, C9 | C8 | C8, C9 |
| R6 | C10, C12 | C10, C11, C12 | C10, C12 | C11, C13 |
| R7 | C4, C12, C14 | C11, C14 | C12, C14 | C11, C14 |
| R8 | C15 | C15, C16, C17 | C15, C16 | C16, C17 |
| R9 | `PendingDecision:R9` because no owned aggregate admission/capacity policy exists | `PendingDecision:R9` because no owned threshold/signal exists | C18 limits individual payload/diff size and workspace cleanup releases proven terminal/superseded custody, but does not bound cumulative use | `PendingDecision:R9` because no owned aggregate recovery/reconciliation procedure exists |

## Control Ledger

| ID | Risks | Status | Kind | Obligation | Ownership class | Owner | Delivery phase | Verification target | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | R1 | Required | Prevention, Detection, Containment, Recovery | Resolve and validate complete definitions, contracts, harnesses, policies, availability, hashes, paths, bounds, and retained active versions at every activation/restart boundary; fail QRSPI closed before claim with exact error | CurrentTicket | `workflowd-vs3.4` | BeforeExposure | V1: invalid/missing refs never create claimable work; corrected config can activate unchanged durable identity | Design lines 138-153 |
| C2 | R2 | Required | Prevention, Detection, Containment | Decode and bound exact immutable source/request/result bytes at the selected contract, preserve authority order, and reject hash/duplicate/path mismatch before persistence or publication | CurrentTicket | `workflowd-vs3.4` | Implementation | V2: malformed, oversized, reordered, duplicate, or changed source/result cannot pass | Design lines 176-180, 229-242 |
| C3 | R2, R3 | Existing and Required | Prevention, Containment | Keep trusted harness limited to task/session work; persist launch before create and session before prompt; bind attempt workspace and output to exact lease/session identity | CurrentTicket | `workflowd-vs3.4` using `.2` mechanics | Implementation | V3: late/invalid session output cannot transfer custody or advance | Design lines 184-188, 394-414; current harness tests |
| C4 | R2, R3, R7 | Required | Prevention, Detection, Containment, Recovery | Guard every durable transition and external intent by exact Generation/run/revision/operation/attempt/session/handoff identities; quarantine data errors and preserve stale audit | CurrentTicket | `workflowd-vs3.4` | Implementation | V3 and V11: zero-row stale/mismatch outcome never advances and valid same identity recovers | Design lines 631-652 |
| C5 | R3 | Required | Detection, Containment, Recovery | Fence cleanup and workspace custody; no replacement while cleanup is unconfirmed and no deletion while publication/effect is nonterminal or uncertain | CurrentTicket | `workflowd-vs3.4` | Recovery | V3: forced cleanup uncertainty retains custody/fence; exact terminal/superseded custody releases | Design lines 409-414 |
| C6 | R4 | Required | Prevention, Detection, Containment | Verify custody, scope, diff/path/content, parent, signature/trailers, and one final SHA, then use exact-old fast-forward-only mutation | CurrentTicket | `workflowd-vs3.4` | BeforeExposure | V4: unsafe candidate or changed old SHA causes no accepted mutation/advance | Design lines 416-436 |
| C7 | R4, R5 | Required | Detection, Recovery | Persist intent before mutation and authoritatively observe remote ref, parent, signature, trailers, attribution, blob, and content before completion; observe unknown effect before retry | CurrentTicket | `workflowd-vs3.4` | Runtime | V4: every crash window resolves from authoritative Git without duplicate SHA or stale parent advance | Design lines 425-450 |
| C8 | R4, R5 | Required | Containment, Recovery | Atomically create one publication-scoped `TargetReconcile`, save parent state, make publication unclaimable, and permit only read-only observation and exact typed resolution | CurrentTicket | `workflowd-vs3.4` | Recovery | V4: conflict/rollback/stale/unknown cases never reset refs or advance stale parent | Design lines 499-527 |
| C9 | R5 | Required | Detection, Recovery | Retain complete directly queryable reconciliation identity, observations, error, allowed actions, and terminal resolution exactly once across restart | CurrentTicket | `workflowd-vs3.4` | Runtime | V5: pending/waiting/failed/unclaimable records remain complete and terminal resolution is singular | Design lines 529-533, 735-738 |
| C10 | R6 | Required | Prevention, Detection, Containment | Derive mandatory owner refs and validate registrations/availability before ingress, each run/revision activation, and new effects while unrelated service remains available | RequiredEnablingSeam | `workflowd-vs3.4` | BeforeExposure | V6: removing each mandatory registration closes only QRSPI before a child effect | Design lines 551-572 |
| C11 | R6, R7 | Required | Detection, Recovery | Persist exact handoff diagnostics and observe/resubmit the same deterministic local receipt after failure, restart, and restoration; duplicates return same result and mismatches remain blocked | RequiredEnablingSeam | `workflowd-vs3.4` | Recovery | V7: failed adapter/restart/restoration uses one handoff/request hash and preserves exact error | Design lines 574-586 |
| C12 | R6, R7 | Required | Prevention, Containment | Accept only exact typed owner results bound to current scope/package/policy/request; approval alone and partial/uncertain results cannot release Structure | RequiredEnablingSeam | `workflowd-vs3.4` | Runtime | V11: stale, partial, conflicting, or mismatched result leaves the exact parent blocked | Design lines 588-619 |
| C13 | R6 | Required | Recovery | Implement idempotent owner-side lifecycle and exact result production behind the registered capability before its configured path is exposed | DownstreamTicket:`workflowd-vs3.5`, `workflowd-vs3.6`, `workflowd-vs3.9`, or `workflowd-vs3.14` as selected | Named downstream ticket | BeforeExposure | V7 plus each owner contract: adapter can submit/observe one deterministic request and return exact result | Design lines 541-560; examined issue graph. Safe sequence is registration and V6 availability before QRSPI exposure |
| C14 | R7 | Required | Prevention, Detection, Containment, Recovery | Pin all Design/promotion/Structure identities; require exact `.9` result/snapshot for release; accept bounded `.14` reentry and apply only named local effects idempotently | RequiredEnablingSeam | `workflowd-vs3.4` | Runtime | V11: approval-only release, stale snapshot, and broadened/duplicate directive all fail without unintended state change | Design lines 602-629 |
| C15 | R8 | Required | Prevention, Detection, Containment | Before normal startup writes, read/query-only snapshot and classify every current Generation/nonterminal operation into canonical bounded manifest with exact diagnostics/actions | CurrentTicket | `workflowd-vs3.4` | BeforeExposure | V8: new/dormant/malformed/partial fixtures receive complete pre-write classification and incompatible work stays blocked | Design lines 688-710 |
| C16 | R8 | Required | Detection, Containment, Recovery | Verify unchanged manifest/database, fsync and verify same-filesystem DB/WAL/SHM backup, apply append-only schema transactionally, and prove rollback or restore/verify backup | CurrentTicket | `workflowd-vs3.4` | BeforeExposure | V8: each injected failure leaves proven pre-upgrade schema/rows or verified restored backup | Design lines 712-718 |
| C17 | R8 | Required | Detection, Recovery | Resolve only exact no-effect legacy Generation through idempotent offline supersession, verify result, and use ordinary authenticated WorkflowStart for successor | CurrentTicket | `workflowd-vs3.4` | Recovery | V9: wrong identity/hash writes nothing; exact repeat is idempotent; fresh kickoff succeeds without direct SQL | Design lines 720-728 |
| C18 | R9 | Existing and Required | Containment | Enforce every configured/global payload and diff bound and release only workspace custody proven terminal or superseded; do not represent these as aggregate-capacity control | CurrentTicket | `workflowd-vs3.4` | Implementation | V10: each durable boundary rejects over-limit records/diffs and custody cleanup never removes uncertain/nonterminal work | Design lines 114-122, 164-180, 409-414, 817-830 |

## Verification Plan

| ID | Risks and controls | Claim and boundary | Method and rationale | Pass evidence | Owner and phase | Automation gap |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | R1; C1 | Complete config/catalog/handoff validation prevents claim at the Layer/activation boundary | ComponentIntegration: lowest boundary covering Schema, catalog, availability, restart, and activation together | Each unknown/duplicate/incompatible/unavailable ref fails before child claim; complete set activates; unrelated service remains available | `workflowd-vs3.4`, BeforeExposure | None |
| V2 | R2; C2 | Exact source/result Schemas, hashes, bounds, order, and authority survive persistence and retry | ComponentIntegration with real SQLite: durable round-trip is required; pure Schema tests cannot prove stored bytes | Changed/reordered/duplicate/oversized/malformed data is rejected; exact accepted input replays unchanged | `workflowd-vs3.4`, Implementation | None |
| V3 | R2, R3; C3, C4, C5 | Session and workspace output can transfer custody only under the exact current attempt and cleanup fence | ComponentIntegration with real SQLite/workspaces and controlled lease/session faults | Launch precedes create, reference precedes prompt; stale/late output changes no parent; uncertain cleanup blocks replacement; valid recovery retains identity | `workflowd-vs3.4`, Implementation/Recovery | None |
| V4 | R4, R5; C6, C7, C8 | Publication and reconciliation preserve exact Git truth across every mutation/transaction/restart window | SystemTest with real bare/source Git and file SQLite: exact-old mutation and authoritative observation require real Git semantics | Success, absence, conflict, rollback, stale post-effect, unreadable observation, every typed resolution, transaction failure, and restart produce no reset, duplicate final SHA, weaker mutation, or stale advance | `workflowd-vs3.4`, Implementation/Recovery | None |
| V5 | R5; C9 | Reconciliation remains directly recoverable without a status product | ComponentIntegration with forced pending/waiting/failed/unclaimable rows | Query returns all bound IDs/revisions/SHAs/evidence/reason/error/actions/timestamps; one exact terminal result survives restart | `workflowd-vs3.4`, Runtime | None |
| V6 | R6; C10 | Mandatory owner capability is present before any configured crossing can create an effect | ComponentIntegration at Layer/activation boundary | Removing each `.5/.6/.9/.14` registration in turn closes QRSPI before claim/effect; full set starts; unrelated listener/workers remain usable | `workflowd-vs3.4`, BeforeExposure | None |
| V7 | R6; C11, C13 | An unavailable owner crossing recovers through one exact handoff and owner lifecycle | InterfaceContract plus ComponentIntegration with replaceable owner adapter; this is the lowest cross-owner boundary | Failure after durable insert, process restart, restoration, duplicate delivery, and mismatch preserve one ID/request hash; exact result resumes once; mismatch remains blocked | `workflowd-vs3.4` and named downstream owner, BeforeExposure/Recovery | None |
| V8 | R8; C15, C16 | Upgrade classifies before writes and never converts/invents legacy state; failure restores/proves prior DB | SystemTest with versioned file databases and injected migration/fsync/verification failures | Complete manifest/diagnostics precede writes; backup opens and matches; each failure leaves exact prior schema/rows or verified restore | `workflowd-vs3.4`, BeforeExposure | None |
| V9 | R8; C17 | Shipped recovery can retire only exact dormant legacy work and create a successor only through ordinary ingress | RecoveryDrill: CLI/process boundary is the product recovery surface | Wrong DB/manifest/workflow/Generation/definition fails without writes; exact action repeats same receipt; verify passes; normal service and authenticated kickoff create fresh Generation | `workflowd-vs3.4`, Recovery | None |
| V10 | R9; C18 | Individual bounds and custody rules work but do not claim an aggregate capacity guarantee | ComponentIntegration with boundary-size payloads/diffs and nonterminal/uncertain workspace states | Over-limit item fails before durable/effect use; terminal/superseded custody can clean; uncertain/nonterminal custody remains. Evidence explicitly makes no total-capacity assertion | `workflowd-vs3.4`, Implementation | Aggregate capacity threshold, environment sizing, monitoring, and recovery cannot be verified because no authorized control or acceptance condition exists |
| V11 | R7; C4, C12, C14 | Only exact current package/response/promotion/snapshot/directive identities can alter Design progression/reentry | InterfaceContract plus ComponentIntegration: owner outputs cross typed interfaces then one local transaction | Approval alone leaves Structure blocked; exact `.9` result releases once; stale/partial/conflicting scope fails; bounded `.14` directive changes only named outputs and duplicate is idempotent | `workflowd-vs3.4`, Runtime | None |

## Residual Risk and Decisions

| Risk | Assumed controls | Residual rating and basis | Materiality | Decision status | Decision owner and evidence |
| --- | --- | --- | --- | --- | --- |
| R1 | C1 | `Minor (2)`, likelihood `Unknown`, no score; fail-closed QRSPI configuration error only | NonMaterial | NonMaterial | Design owner; C1/V1 prove no exposure before correction |
| R2 | C2, C3, C4 | `Minor (2)`, likelihood `Unknown`, no score; malformed data is blocked or replaced before canonical use | NonMaterial | NonMaterial | Design owner; C2-C4 and V2-V3 |
| R3 | C3, C4, C5 | `Minor (2)`, likelihood `Unknown`, no score; stale attempts remain audit and exact work recovers | NonMaterial | NonMaterial | Design owner; C3-C5 and V3 |
| R4 | C6, C7, C8 | `Minor (2)`, likelihood `Unknown`, no score; exact-old/preflight failures do not advance | NonMaterial | NonMaterial | Design owner; C6-C8 and V4 |
| R5 | C7, C8, C9 | `Moderate (3)`, likelihood `Unknown`, no score; unresolved external conflict can park one Generation but cannot erase external work or advance stale state | NonMaterial | NonMaterial | Design owner; bounded safe stall and exact recovery are acceptance behavior under C7-C9/V4-V5 |
| R6 | C10, C11, C12, C13 | `Moderate (3)`, likelihood `Unknown`, no score; an owner outage can park one boundary while unrelated service continues | NonMaterial | NonMaterial | Current and named downstream owners; explicit issue ownership, pre-exposure registration, same-record recovery, C10-C13/V6-V7 |
| R7 | C4, C12, C14 | `Minor (2)`, likelihood `Unknown`, no score; stale/mismatched owner results remain blocked | NonMaterial | NonMaterial | Design owner; C4/C12/C14 and V11 |
| R8 | C15, C16, C17 | `Minor (2)`, likelihood `Unknown`, no score; failed/unsupported upgrade preserves prior DB and blocks affected workflow | NonMaterial | NonMaterial | Design owner; C15-C17 and V8-V9 |
| R9 | C18 only | `Significant (4) x AlmostCertain (5) = 20 / Critical` for sustained unbounded use on a finite shared volume; environment determines time-to-exhaustion, not the cumulative direction | Material | NeedsDecision | Accountable human Design approver; revision 4 lines 815-834 explicitly leave the risk unaccepted, and the issue graph assigns no capacity-policy owner |

## Excluded Speculation

| Candidate | Why considered | Missing evidence link | Disposition |
| --- | --- | --- | --- |
| Storage exhaustion corrupts SQLite or Git irreversibly | Filesystem exhaustion can stop writes and is operationally serious | Examined Design/current evidence establishes failed writes and service impact, not corruption or irreversibility | Excluded |
| `workflowd-3d8` owns aggregate capacity policy | It owns readiness, failure presentation, and safe retry, and may consume QRSPI diagnostics | Its ticket and revision 4 contain no capacity limits, reservation, retention, sizing, or recovery lifecycle assignment | Excluded |
| Mandatory owner outages are frequent | Handoffs must tolerate unavailability and restart | No observed outage frequency or deployment history supports a likelihood anchor | Excluded |
| Exact-old Git publication can force-push or erase conflicting work | Publication mutates a shared branch | The Design expressly forbids force-push/reset/delete and requires exact-old fast-forward-only mutation; no contrary mechanism is present | Excluded |

## Human Risk Decision

For Design revision 4 and material risk R9, does the accountable human Design approver choose **(A)** accept cumulative SQLite/workspace exhaustion for this exact Design and stated finite-volume exposure without an aggregate control, **(B)** defer Design approval until an authorized owner and acceptance condition for capacity prevention/detection/recovery are established outside `workflowd-vs3.4`, or **(C)** require deployment-specific workload, free-space, and time-to-exhaustion evidence before choosing A or B?
