# Accepted Structure input package: Parcelmap CLI and library

This file is a complete accepted Structure input package for evaluation. It stands alone,
so a Structure producer applies the contract to the text below without opening the
fictional repository. The repository is `parcelmap/parcelmap`, which publishes the `pmap`
command line tool and the `@parcelmap/core` library from one TypeScript package. The
accepted implementation baseline commit is
`1a9d40f7c862b5039e4d17ab60c8f25d3b704e91`. Everything under "Repository baseline
inventory" is factual repository state at that commit.

## Binding

| Field | Value |
| --- | --- |
| workflowId | `wf_parcelmap_parcelmap_PM-905` |
| generation | `1` |
| accepted Design revision | `03-design.md` revision `4`, commit `c04b7e35a1d986f2073bc45de8109a6f2db35704` |
| acceptance package sha256 | `6b03fa17d952c8e440a7b16de83c05f927d4b6a19f5e30c8b1a76d240c58e39f` |
| gate response sha256 | `f27a0c6831b5d94ea70c286fd4b913a75e0f26c89b34a71dc60e58f207d2a493` |
| promotion request sha256 | `4d81e5a0b6270fc918e3d75ba290c46ef70b53d16c8a29b4d05f7e1382ab4c6f` |
| promotion result sha256 | `93c6b0d52a1f78e4c5d03b9671e8a24f0b6d95c3e847f1025a39c7b6d1042e8f` |
| pinned graph snapshot identity | `parcelmap-graph@snapshot-2026-06-18T11:40:12Z-0004` |
| snapshot content hash | `b58f207ae14c93d66027ba853d9e1f40c8b64a7205df3e91a76021cd4e83b5f0` |
| Structure policy | `structure-coverage-policy`, revision `2.3.0`, sha256 `7e94d1b305c62af8931de470b28fa6c54a07e3d9f6152b80c3e9d74a18b05f26` |
| deviation | none; the snapshot is pinned by the confirmed promotion result |

## Accepted graph records

### Informational sources

| Logical ID | Graph ID | Statement |
| --- | --- | --- |
| S1 | `parcelcli-d5-1a9d40-src-s1` | Issue thread `parcelmap#812`, a request to filter scan output by entry size. |
| S2 | `parcelcli-d5-1a9d40-src-s2` | Consumer survey of the six known downstream packages that import `@parcelmap/core`, April 2026. |
| S3 | `parcelcli-d5-1a9d40-src-s3` | Published output contract `docs/cli/output.md` at tag `v3.4.0`. |
| S4 | `parcelcli-d5-1a9d40-src-s4` | Support ticket `SUP-330`, non-deterministic manifest ordering seen in continuous integration. |

### Accepted requirements

| Logical ID | Graph ID | Statement |
| --- | --- | --- |
| R1 | `parcelcli-d5-1a9d40-req-r1` | A user can restrict `pmap scan` output to entries at or above a size they give. |
| R2 | `parcelcli-d5-1a9d40-req-r2` | `resolveManifest` returns entries in the ascending package path order its published documentation states, for the same workspace on any machine. |
| R3 | `parcelcli-d5-1a9d40-req-r3` | A user can check a workspace against its recorded manifest and tell from the process result alone whether the workspace has drifted. |
| R4 | `parcelcli-d5-1a9d40-req-r4` | A consumer can build a reusable workspace index without rescanning, and every consumer of the current index function keeps working through one documented compatibility window. |
| R5 | `parcelcli-d5-1a9d40-req-r5` | Every documented option, output column, and exit code stays documented and is versioned with the release that changes it. |

### Accepted decisions and resolutions

| Logical ID | Graph ID | Position |
| --- | --- | --- |
| D1 | `parcelcli-d5-1a9d40-res-d1` | Add a `--min-size <bytes>` option to `pmap scan`, declared through the existing option specification with the existing bytes value parser, filtering rows before rendering and leaving the documented columns, streams, and exit codes as they are. Authorizes work in this repository. |
| D2 | `parcelcli-d5-1a9d40-res-d2` | Sort `resolveManifest` results by ascending package path before returning them, behind the existing exported signature, so the behaviour matches the published documentation. Authorizes work in this repository. |
| D3 | `parcelcli-d5-1a9d40-res-d3` | Add a `pmap verify` subcommand that reports workspace drift, with a drift exit code distinct from the three documented codes and a machine-readable drift report on stdout. Authorizes work in this repository. |
| D4 | `parcelcli-d5-1a9d40-res-d4` | Export `createWorkspaceIndex` from a new `@parcelmap/core/workspace` package export and deprecate `buildIndex` with a documented compatibility window for existing consumers. Authorizes work in this repository. |
| D5 | `parcelcli-d5-1a9d40-res-d5` | The tool must not read or write any path outside the invoked workspace root. No home directory cache, global configuration file, or environment-provided path may be introduced. Authorizes no work; forbids a surface. |
| D6 | `parcelcli-d5-1a9d40-res-d6` | Release notes, the migration guide, and the published documentation site for the deprecation are owned by developer experience under ticket `DXTEAM-417`. This repository ships no site content and re-plans none of that work. |

### Accepted controls and rules

| Logical ID | Graph ID | Statement |
| --- | --- | --- |
| C1 | `parcelcli-d5-1a9d40-rul-c1` | Every option is declared through the shared option specification; no command parses argv itself. |
| C2 | `parcelcli-d5-1a9d40-rul-c2` | Every documented output column and exit code has a golden file or process-result assertion in the test suite. |
| C3 | `parcelcli-d5-1a9d40-rul-c3` | Human-readable and machine-readable output goes to stdout; diagnostics go to stderr. |
| C4 | `parcelcli-d5-1a9d40-rul-c4` | No exported symbol is removed or changed in signature without a deprecation window recorded in the changelog. |
| C5 | `parcelcli-d5-1a9d40-rul-c5` | All sizes are byte integers produced by the shared bytes value parser. |

### Accepted verification obligations

| Logical ID | Graph ID | Obligation |
| --- | --- | --- |
| V1 | `parcelcli-d5-1a9d40-ver-v1` | Prove `pmap scan --min-size` filters at the boundary value and leaves the documented columns unchanged. |
| V2 | `parcelcli-d5-1a9d40-ver-v2` | Prove `resolveManifest` returns the same ascending path order for a workspace whose directories are read in a shuffled order. |
| V3 | `parcelcli-d5-1a9d40-ver-v3` | Prove `pmap verify` yields the drift result and the machine-readable report for a drifted workspace and for a clean one. |
| V4 | `parcelcli-d5-1a9d40-ver-v4` | Prove `buildIndex` and `createWorkspaceIndex` both work for the six surveyed consumer versions during the compatibility window. |

### Accepted residual risk dispositions

| Logical ID | Graph ID | Disposition |
| --- | --- | --- |
| X1 | `parcelcli-d5-1a9d40-rsk-x1` | Some consumer may depend on the current directory read order despite the published documentation. Accepted. Owner: Core maintainer, L. Brandt. Condition: the change lands in a minor release with a changelog entry. Follow-up: consumer smoke run, ticket `CORE-88`. |
| X2 | `parcelcli-d5-1a9d40-rsk-x2` | The drift report shape may have to change once continuous integration consumers adopt it. Accepted. Owner: CLI maintainer, S. Adeyemi. Condition: the report carries a schema version. Follow-up: review after two releases, ticket `CLI-142`. |
| X3 | `parcelcli-d5-1a9d40-rsk-x3` | The compatibility window length comes from a survey of six known consumers, and unknown consumers may exist. Accepted. Owner: Developer experience, K. Ostrowski. Condition: the deprecation notice names the replacement. Follow-up: registry download review, ticket `DXTEAM-417`. |

## Accepted edges

Edge IDs follow `<edge_type>_<from_type>_<from_id>_to_<to_type>_<to_id>`, where the type
segments are `src`, `req`, `res`, `rul`, `ver`, and `rsk`, and the IDs are the exact graph
IDs above. D1 and D4 have no accepted dependency edges.

| Edge ID | Reads as |
| --- | --- |
| `needs_req_parcelcli-d5-1a9d40-req-r1_to_src_parcelcli-d5-1a9d40-src-s1` | R1 cites issue `parcelmap#812`. |
| `needs_req_parcelcli-d5-1a9d40-req-r2_to_src_parcelcli-d5-1a9d40-src-s4` | R2 cites support ticket `SUP-330`. |
| `needs_req_parcelcli-d5-1a9d40-req-r4_to_src_parcelcli-d5-1a9d40-src-s2` | R4 cites the consumer survey. |
| `needs_req_parcelcli-d5-1a9d40-req-r5_to_src_parcelcli-d5-1a9d40-src-s3` | R5 cites the published output contract. |
| `resolves_res_parcelcli-d5-1a9d40-res-d1_to_req_parcelcli-d5-1a9d40-req-r1` | D1 resolves R1. |
| `resolves_res_parcelcli-d5-1a9d40-res-d2_to_req_parcelcli-d5-1a9d40-req-r2` | D2 resolves R2. |
| `resolves_res_parcelcli-d5-1a9d40-res-d3_to_req_parcelcli-d5-1a9d40-req-r3` | D3 resolves R3. |
| `resolves_res_parcelcli-d5-1a9d40-res-d4_to_req_parcelcli-d5-1a9d40-req-r4` | D4 resolves R4. |
| `produces_res_parcelcli-d5-1a9d40-res-d1_to_rul_parcelcli-d5-1a9d40-rul-c1` | D1 produces C1, which also binds D3. |
| `produces_res_parcelcli-d5-1a9d40-res-d1_to_rul_parcelcli-d5-1a9d40-rul-c5` | D1 produces C5. |
| `produces_res_parcelcli-d5-1a9d40-res-d3_to_rul_parcelcli-d5-1a9d40-rul-c2` | D3 produces C2, which also binds D1. |
| `produces_res_parcelcli-d5-1a9d40-res-d3_to_rul_parcelcli-d5-1a9d40-rul-c3` | D3 produces C3, which also binds D1. |
| `produces_res_parcelcli-d5-1a9d40-res-d4_to_rul_parcelcli-d5-1a9d40-rul-c4` | D4 produces C4, which also binds D2. |
| `needs_ver_parcelcli-d5-1a9d40-ver-v1_to_res_parcelcli-d5-1a9d40-res-d1` | V1 attaches to D1. |
| `needs_ver_parcelcli-d5-1a9d40-ver-v2_to_res_parcelcli-d5-1a9d40-res-d2` | V2 attaches to D2. |
| `needs_ver_parcelcli-d5-1a9d40-ver-v3_to_res_parcelcli-d5-1a9d40-res-d3` | V3 attaches to D3. |
| `needs_ver_parcelcli-d5-1a9d40-ver-v4_to_res_parcelcli-d5-1a9d40-res-d4` | V4 attaches to D4. |
| `needs_rsk_parcelcli-d5-1a9d40-rsk-x1_to_res_parcelcli-d5-1a9d40-res-d2` | X1 attaches to D2. |
| `needs_rsk_parcelcli-d5-1a9d40-rsk-x2_to_res_parcelcli-d5-1a9d40-res-d3` | X2 attaches to D3. |
| `needs_rsk_parcelcli-d5-1a9d40-rsk-x3_to_res_parcelcli-d5-1a9d40-res-d4` | X3 attaches to D4. |
| `needs_res_parcelcli-d5-1a9d40-res-d6_to_req_parcelcli-d5-1a9d40-req-r4` | D6 assigns the published documentation side of R4 to developer experience under `DXTEAM-417`. |
| `needs_res_parcelcli-d5-1a9d40-res-d3_to_res_parcelcli-d5-1a9d40-res-d2` | D3 depends on D2, because drift comparison reads manifest entries in a fixed order. |

## Repository baseline inventory

Facts about `parcelmap/parcelmap` at commit `1a9d40f7c862b5039e4d17ab60c8f25d3b704e91`.

### Command surface

| Path | Facts at the baseline commit |
| --- | --- |
| `src/cli/main.ts` | Exports `run(argv: string[], io: Io): Promise<number>`, which dispatches to the registered commands. |
| `src/cli/command-spec.ts` | Exports the `CommandSpec` interface with `name`, `summary`, `options: OptionSpec[]`, and `run(ctx: CommandContext): Promise<number>`, and the `CommandContext` type carrying parsed option values, `io`, and `workspaceRoot`. |
| `src/cli/commands/index.ts` | Exports `commands: CommandSpec[]`, composed of `scanCommand`, `treeCommand`, and `versionCommand`. Those are the three files in `src/cli/commands/`. |
| `src/cli/commands/scan.ts` | Exports `scanCommand` with the options `--root <path>`, `--max-size <bytes>`, `--format <table or json>`, and `--quiet`. |
| `src/cli/option-spec.ts` | Exports `OptionSpec`, `parseOptions(specs, argv)`, and the value parsers `pathValue`, `bytesValue`, `enumValue`, and `boolFlag`. `bytesValue` accepts `4096`, `12kb`, and `4mb` and returns an integer. |
| `src/cli/output/table.ts`, `src/cli/output/json.ts` | Export `renderTable(rows, columns)` and `renderJson(value)`. Both write to `io.stdout`; diagnostics go through `io.stderr`. |
| `src/cli/exit-codes.ts` | Exports `EXIT_OK = 0`, `EXIT_IO = 1`, and `EXIT_USAGE = 2`. |
| `docs/cli/exit-codes.md`, `docs/cli/output.md`, `docs/cli/scan.md` | Document those three exit codes, the scan columns `path`, `size`, `packages`, `lastModified` and the tree output shape, and each scan option. |

### Library surface

| Path | Facts at the baseline commit |
| --- | --- |
| `package.json` | Declares `bin` mapping `pmap` to `./dist/cli/main.js`, and an `exports` map with exactly two entries: `"."` to `./dist/index.js` and `"./manifest"` to `./dist/manifest.js`. |
| `src/index.ts` | Re-exports `buildIndex`, `resolveManifest`, and the types `ScanResult`, `ManifestEntry`, and `ResolveOptions`. |
| `src/manifest/resolve-manifest.ts` | Exports `resolveManifest(root: string, opts: ResolveOptions): Promise<ManifestEntry[]>`. It appends each entry in the order `readdir` returns it and does not sort. |
| `docs/api/resolve-manifest.md` | States that entries are returned in ascending package path order. |
| `src/index/build-index.ts`, `src/index/workspace-index.ts` | Export `buildIndex(entries: ManifestEntry[]): WorkspaceIndex` and declare the `WorkspaceIndex` type. |
| `src/fs/workspace-root.ts`, `src/fs/scoped-fs.ts` | `resolveWorkspaceRoot(cwd)` resolves the workspace root; every filesystem read goes through `scoped-fs.ts`, which rejects a path outside that root. |
| `CHANGELOG.md` | Groups entries by release under Added, Changed, and Fixed headings. |

### Tests and fixtures

| Path | Facts at the baseline commit |
| --- | --- |
| `test/support/cli.ts`, `test/support/golden.ts` | `runCli(argv)` returns `{ stdout, stderr, exitCode }`; `expectGolden(name, actual)` compares against files in `test/golden/`, which contains `scan/` and `tree/`. |
| `test/cli/scan.test.ts`, `test/cli/tree.test.ts` | Use `runCli` plus `expectGolden` and assert the returned exit code for the documented success and usage-error cases. |
| `test/cli/option-spec.test.ts` | Covers each value parser at its boundary values, including `bytesValue`. |
| `test/support/workspace.ts`, `test/support/order.ts` | `withTempWorkspace(spec, fn)` builds a throwaway workspace, `shuffleReadOrder()` forces directory reads into a randomized order, and `expectSortedByPath(entries)` asserts ascending path order. |
| `test/manifest/resolve-manifest.test.ts`, `test/index/build-index.test.ts` | The manifest test uses `withTempWorkspace`, `shuffleReadOrder`, and `expectSortedByPath`; the index test covers `buildIndex` against fixture manifests. |

### Absent at this baseline

- No `verify` command file, no fourth `CommandSpec`, and no drift, compare, diff, or recorded-manifest concept anywhere in `src/`.
- No exit code other than `0`, `1`, and `2` in `src/` or `docs/`, and no code path that returns a value outside those three.
- No machine-readable report other than `renderJson` over `ScanResult`, and no schema version, report envelope, or stable machine format declaration in `src/` or `docs/`.
- No `createWorkspaceIndex` symbol, no `src/workspace/` directory, and no `exports` entry besides `"."` and `"./manifest"`.
- No deprecation machinery: no `deprecate` helper, no `@deprecated` annotation in `src/`, no runtime warning channel for library consumers, no supported-version policy document, and no compatibility or consumer-version test suite.
- No test fixture that installs, resolves, or runs any downstream consumer package.
- No home directory cache, global configuration file, or environment-variable path read anywhere in `src/`.
