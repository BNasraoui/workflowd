// Named local slices only. None establishes container or deployed-policy acceptance.
export const coreCases = [
  ["A1", "test/sandbox/public-output.test.ts"],
  ["B1", "test/sandbox/bootstrap.test.ts"],
  ["B2", "test/sandbox/bootstrap-helper.test.ts"],
  ["B3", "test/sandbox/bootstrap.e2e.launcher.test.ts"],
  ["C1", "test/capability-gateway/authorization.test.ts"],
  ["C2", "test/capability-gateway/noscope.test.ts"],
  ["C3", "test/capability-gateway/lifecycle.test.ts"],
  ["C4", "test/agent-host/provider-access.test.ts"],
  ["C5", "test/agent-host/provider-https.launcher.test.ts"],
  ["C6", "test/capability-gateway/transaction.test.ts"],
  ["C7", "test/capability-gateway/composition.test.ts"],
  ["D1", "test/capability-gateway/transport-security.test.ts"],
  ["D3", "test/sandbox/capability-relay.test.ts"],
] as const

export const nativeCases = [
  ["N1", "test/sandbox/interactive-claude.e2e.launcher.test.ts"],
  ["N2", "test/sandbox/native-execution.e2e.test.ts"],
  ["N2b", "test/sandbox/native-execution-ssh.e2e.launcher.test.ts"],
  ["N3", "test/sandbox/native-lifecycle.test.ts"],
  ["N4", "test/sandbox/native-supervisor.test.ts"],
  ["N5", "test/sandbox/native-capture.test.ts"],
  ["N6", "test/sandbox/native-result.e2e.test.ts"],
  ["N7", "test/capability-gateway/result.test.ts"],
  ["N8", "test/kernel/actions-native-routing.test.ts"],
  ["N9", "test/sandbox/native-capture-recovery.test.ts"],
  ["N10", "test/execution/config.test.ts"],
  ["N12", "test/sandbox/native-command.test.ts"],
  ["N13", "test/sandbox/native-control.test.ts"],
  ["N14", "test/sandbox/native-progress.e2e.launcher.test.ts"],
  ["N15", "test/capability-gateway/native-observation.test.ts"],
  ["N16", "test/sandbox/native-recovery.launcher.test.ts"],
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
  ["P3-C1", "test/capability-gateway/native-adapters.test.ts"],
  ["P3-C2", "test/agent-host/native-provider-owner.test.ts"],
  ["P3-C3", "test/execution/config.test.ts"],
  ["P3-C4", "test/agent-host/provider-https.launcher.test.ts"],
  ["P3-D1", "test/capability-gateway/transport-security.test.ts"],
  ["P3-D2", "test/sandbox/capability-relay.test.ts"],
  ["P3-G1", "test/sandbox/native-harnesses.e2e.launcher.test.ts"],
  ["P3-G2", "test/kernel/actions-native-routing.test.ts"],
  ["P3-G3", "test/sandbox/native-lifecycle.test.ts"],
  ["P3-G4", "test/sandbox/native-execution.e2e.test.ts"],
  ["P3-G4b", "test/sandbox/native-execution-ssh.e2e.launcher.test.ts"],
  ["P3-G5", "test/kernel/actions-session-custody.test.ts"],
  ["P3-G6", "test/sandbox/native-client-custody.launcher.test.ts"],
] as const

export const finalCases = [
  ["P4-A", "test/sandbox/public-output.test.ts"],
  ["P4-A2", "test/sandbox/ci-setup.test.ts"],
  ["P4-C", "test/capability-gateway/git-read.test.ts"],
  ["P4-CD", "test/capability-gateway/git.launcher.test.ts"],
  ["P4-E", "test/sandbox/process-environment.test.ts"],
  ["P4-F", "test/sandbox/publication-parity.test.ts"],
  ["P4-G1", "test/sandbox/reconciliation.test.ts"],
  ["P4-G2", "test/sandbox/native-recovery.launcher.test.ts"],
  ["P4-G3", "test/sandbox/native-lifecycle.test.ts"],
  ["P4-G4", "test/runtime-startup.test.ts"],
  ["P4-G5", "test/sandbox/reconciliation-dispatch.test.ts"],
] as const

export const suites: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  core: coreCases,
  "native-local": nativeCases,
  "publication-local": publicationCases,
  adapters: adapterCases,
  "final-local": finalCases,
}

/** Test files that only a suite runs; bunfig.toml keeps them out of the plain run. */
export const launcherTestPattern = "**/*.launcher.test.ts"
