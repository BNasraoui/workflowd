// Named local slices only. None establishes container or deployed-policy acceptance.
export const coreCases = [
  ["A1", "test/sandbox/public-output.test.ts"],
  ["B1", "test/sandbox/bootstrap.test.ts"],
  ["B2", "test/sandbox/bootstrap-helper.test.ts"],
  ["B3", "test/sandbox/bootstrap.e2e.launcher.test.ts"],
  ["C1", "test/capability-gateway/authorization.test.ts"],
  ["C2", "test/capability-gateway/noscope.test.ts"],
  ["C3", "test/capability-gateway/lifecycle.test.ts"],
  ["C6", "test/capability-gateway/transaction.test.ts"],
  ["C7", "test/capability-gateway/composition.test.ts"],
  ["D1", "test/capability-gateway/transport-security.test.ts"],
  ["D3", "test/sandbox/capability-relay.test.ts"],
] as const

export const publicationCases = [
  ["F1", "test/sandbox/publisher-http.e2e.test.ts"],
  ["F1b", "test/sandbox/publisher-pinned.e2e.launcher.test.ts"],
  ["F2", "test/sandbox/publish.e2e.test.ts"],
  ["F3", "test/sandbox/publish-recovery.e2e.test.ts"],
  ["F4", "test/sandbox/ci-policy.test.ts"],
] as const

export const adapterCases = [
  ["P3-A", "test/sandbox/public-output.test.ts"],
  ["P3-B", "test/sandbox/bootstrap.e2e.launcher.test.ts"],
  ["P3-C3", "test/execution/config.test.ts"],
  ["P3-D1", "test/capability-gateway/transport-security.test.ts"],
  ["P3-D2", "test/sandbox/capability-relay.test.ts"],
  ["P3-G5", "test/kernel/actions-session-custody.test.ts"],
] as const

export const finalCases = [
  ["P4-A", "test/sandbox/public-output.test.ts"],
  ["P4-A2", "test/sandbox/ci-setup.test.ts"],
  ["P4-C", "test/capability-gateway/git-read.test.ts"],
  ["P4-CD", "test/capability-gateway/git.launcher.test.ts"],
  ["P4-E", "test/sandbox/process-environment.test.ts"],
  ["P4-F", "test/sandbox/publication-parity.test.ts"],
  ["P4-G1", "test/sandbox/reconciliation.test.ts"],
  ["P4-G4", "test/runtime-startup.test.ts"],
  ["P4-G5", "test/sandbox/reconciliation-dispatch.test.ts"],
] as const

export const suites: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  core: coreCases,
  "publication-local": publicationCases,
  adapters: adapterCases,
  "final-local": finalCases,
}

/** Test files that only a suite runs; bunfig.toml keeps them out of the plain run. */
export const launcherTestPattern = "**/*.launcher.test.ts"
