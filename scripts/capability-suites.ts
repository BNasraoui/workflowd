// Named local slices only. None establishes container or deployed-policy acceptance.

/** The directory whose every test file belongs to a suite, or to `ownStep`. */
export const gatewayTestDirectory = "test/capability-gateway"

/**
 * Launcher test files that need what the isolated fixture does not hold: one CI step of their
 * own runs each of them, and no suite does.
 */
export const ownStep: Readonly<Record<string, string>> = {
  "test/capability-gateway/claude-pinned.launcher.test.ts":
    "the pinned Claude Code client; a step of the Tests job runs it with loopback as its only network",
}

const gatewayFiles = [
  ...new Bun.Glob(`${gatewayTestDirectory}/*.test.ts`).scanSync({ cwd: import.meta.dir + "/.." }),
]
  .filter((file) => !(file in ownStep))
  .sort((a, b) => a.localeCompare(b))

/** The gateway's end-to-end files: a gateway process or listener on a real socket. */
const gatewayEndToEnd = gatewayFiles.filter((file) => file.endsWith(".e2e.test.ts"))

export const suites: Readonly<Record<string, ReadonlyArray<string>>> = {
  core: [
    "test/sandbox/public-output.test.ts",
    "test/sandbox/bootstrap.test.ts",
    "test/sandbox/bootstrap-helper.test.ts",
    "test/sandbox/bootstrap.e2e.launcher.test.ts",
    "test/sandbox/capability-relay.test.ts",
    ...gatewayFiles.filter((file) => !gatewayEndToEnd.includes(file)),
  ],
  gateway: gatewayEndToEnd,
  "publication-local": [
    "test/sandbox/publisher-http.e2e.test.ts",
    "test/sandbox/publish.e2e.test.ts",
    "test/sandbox/publish-recovery.e2e.test.ts",
    "test/sandbox/ci-policy.test.ts",
  ],
  "final-local": [
    "test/sandbox/ci-setup.test.ts",
    "test/sandbox/process-environment.test.ts",
    "test/sandbox/publication-parity.test.ts",
    "test/runtime-startup.test.ts",
  ],
}

/**
 * The lines that report a suite's run and its exit code: the number of cases that ran, then the
 * name of each case that failed. A suite that holds no case fails.
 */
export function suiteReport(
  suite: string,
  cases: ReadonlyArray<string>,
  failed: ReadonlyArray<string>,
) {
  const lines = [
    `${suite}: ${cases.length} cases ran, ${failed.length} failed`,
    ...(cases.length === 0 ? [`failed: ${suite} holds no case`] : []),
    ...failed.map((name) => `failed: ${name}`),
  ]
  return { lines, exitCode: cases.length === 0 || failed.length > 0 ? 1 : 0 }
}
