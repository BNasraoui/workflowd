import { chmod, mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { readlink } from "node:fs/promises"
import { serializePublicStatus } from "../src/sandbox/public-output"

// Named local slices only. None establishes container or deployed-policy acceptance.
const coreCases = [
  ["A1", "test/sandbox/public-output.test.ts"],
  ["B1", "test/sandbox/bootstrap.test.ts"],
  ["B2", "test/sandbox/bootstrap-helper.test.ts"],
  ["B3", "test/sandbox/bootstrap.e2e.test.ts"],
  ["C1", "test/capability-gateway/authorization.test.ts"],
  ["C2", "test/capability-gateway/noscope.test.ts"],
  ["C3", "test/capability-gateway/lifecycle.test.ts"],
  ["C4", "test/agent-host/provider-access.test.ts"],
  ["C5", "test/agent-host/provider-https.test.ts"],
  ["C6", "test/capability-gateway/transaction.test.ts"],
  ["C7", "test/capability-gateway/composition.test.ts"],
  ["D1", "test/capability-gateway/transport-security.test.ts"],
  ["D2", "test/sandbox/capability-acquisition.test.ts"],
  ["D3", "test/sandbox/capability-relay.test.ts"],
] as const

const nativeCases = [
  ["N1", "test/sandbox/interactive-claude.e2e.test.ts"],
  ["N2", "test/sandbox/native-execution.e2e.test.ts"],
  ["N3", "test/sandbox/native-lifecycle.test.ts"],
  ["N4", "test/sandbox/native-supervisor.test.ts"],
  ["N5", "test/sandbox/native-capture.test.ts"],
  ["N6", "test/sandbox/native-result.e2e.test.ts"],
  ["N7", "test/capability-gateway/result.test.ts"],
  ["N8", "test/kernel/actions-native-routing.test.ts"],
  ["N9", "test/sandbox/native-capture-recovery.test.ts"],
  ["N10", "test/execution/config.test.ts"],
  ["N11", "test/kernel/interactive-project-config.e2e.test.ts"],
  ["N12", "test/sandbox/native-command.test.ts"],
  ["N13", "test/sandbox/native-control.test.ts"],
  ["N14", "test/sandbox/native-progress.e2e.test.ts"],
  ["N15", "test/capability-gateway/native-observation.test.ts"],
  ["N16", "test/sandbox/native-recovery.test.ts"],
] as const

const publicationCases = [
  ["F1", "test/sandbox/publisher-http.e2e.test.ts"],
  ["F2", "test/sandbox/publish.e2e.test.ts"],
  ["F3", "test/sandbox/publish-recovery.e2e.test.ts"],
  ["F4", "test/sandbox/ci-policy.test.ts"],
] as const

const adapterCases = [
  ["P3-A", "test/sandbox/public-output.test.ts"],
  ["P3-B", "test/sandbox/bootstrap.e2e.test.ts"],
  ["P3-C1", "test/capability-gateway/native-adapters.test.ts"],
  ["P3-C2", "test/agent-host/native-provider-owner.test.ts"],
  ["P3-C3", "test/execution/config.test.ts"],
  ["P3-C4", "test/agent-host/provider-https.test.ts"],
  ["P3-D1", "test/capability-gateway/transport-security.test.ts"],
  ["P3-D2", "test/sandbox/capability-relay.test.ts"],
  ["P3-G1", "test/sandbox/native-harnesses.e2e.test.ts"],
  ["P3-G2", "test/kernel/actions-native-routing.test.ts"],
  ["P3-G3", "test/sandbox/native-lifecycle.test.ts"],
  ["P3-G4", "test/sandbox/native-execution.e2e.test.ts"],
  ["P3-G5", "test/kernel/actions-session-custody.test.ts"],
  ["P3-G6", "test/sandbox/native-client-custody.test.ts"],
] as const

const finalCases = [
  ["P4-A", "test/sandbox/public-output.test.ts"],
  ["P4-A2", "test/sandbox/ci-setup.test.ts"],
  ["P4-CD", "test/capability-gateway/git.test.ts"],
  ["P4-E", "test/sandbox/process-environment.test.ts"],
  ["P4-F", "test/sandbox/publication-parity.test.ts"],
  ["P4-G1", "test/sandbox/reconciliation.test.ts"],
  ["P4-G2", "test/sandbox/native-recovery.test.ts"],
  ["P4-G3", "test/sandbox/native-lifecycle.test.ts"],
  ["P4-G4", "test/runtime-startup.test.ts"],
  ["P4-G5", "test/sandbox/reconciliation-dispatch.test.ts"],
] as const

async function main() {
  const args = process.argv.slice(2)
  const suite = args[1]
  const cases =
    suite === "core"
      ? coreCases
      : suite === "native-local"
        ? nativeCases
        : suite === "publication-local"
          ? publicationCases
          : suite === "adapters"
            ? adapterCases
            : suite === "final-local"
              ? finalCases
              : undefined
  if (
    args.length !== 6 ||
    args[0] !== "--suite" ||
    cases === undefined ||
    args[2] !== "--upstream" ||
    args[3] !== "fixture" ||
    args[4] !== "--evidence" ||
    !args[5]
  )
    throw new Error("security invocation refused")
  const host = process.env.WORKFLOWD_FIXTURE_HOST_NETNS
  if (!host || !/^net:\[[0-9]+\]$/.test(host) || host === (await readlink("/proc/self/ns/net")))
    throw new Error("fixture namespace required")
  const directory = resolve(args[5])
  await mkdir(directory, { mode: 0o700 })
  await chmod(directory, 0o700)
  const results = []
  for (const [id, file] of cases) {
    const command = [process.execPath, "test", file]
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    let failure: "timeout" | "capacity" | undefined
    const stop = (reason: typeof failure) => {
      failure = reason
      child.kill("SIGKILL")
    }
    const timeout = setTimeout(() => stop("timeout"), 45000)
    let total = 0
    const capture = async (stream: ReadableStream<Uint8Array>) => {
      const chunks = []
      for await (const bytes of stream) {
        total += bytes.length
        if (total > 4 * 1048576) {
          stop("capacity")
          break
        }
        chunks.push(bytes)
      }
      return Buffer.concat(chunks).toString("utf8")
    }
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      capture(child.stdout),
      capture(child.stderr),
    ])
    clearTimeout(timeout)
    const output = stdout + stderr
    const passed = Number(/\n\s*(\d+) pass\b/.exec(output)?.[1] ?? 0)
    const assertions = Number(/\n\s*(\d+) expect\(\) calls/.exec(output)?.[1] ?? 0)
    const ok =
      exitCode === 0 &&
      !failure &&
      passed > 0 &&
      /\n\s*0 fail\b/.test(output) &&
      !/\n\s*[1-9]\d* (?:skip|todo|filtered out)\b/.test(output)
    await writeFile(join(directory, `${id}.log`), output, { mode: 0o600 })
    results.push({ id, file, command, exitCode, passed, assertions, ok, failure })
    // IDs come exclusively from this reviewed list; child diagnostics never enter this sink.
    process.stdout.write(
      `${id} ${serializePublicStatus({ stage: "test", outcome: ok ? "ok" : "failed", reason: ok ? "none" : (failure ?? "unavailable"), count: passed })}\n`,
    )
  }
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(
      {
        version: 1,
        suite,
        results,
        completeCoreCases: suite === "core" && results.every((result) => result.ok),
        completeListedCases: results.every((result) => result.ok),
        separateP1Evidence: [
          "filesystem-run.py provider-gid.test.ts",
          "Node real-SSH transport feasibility",
          "changed-line and per-file coverage",
          "final static gates",
        ],
        separateP2Evidence: [
          "owned-Docker image/runtime/UID/Dagger/network and death-injection receipts",
          "owned native artifact through ZIP validation and synthetic protected publisher",
        ],
        separateP3Evidence: [
          "exact-client owned-container/controller/SSH/result/publication receipts",
          "pinned image build and exact-owner cleanup",
        ],
        separateActivationGates: [
          "reviewed production fixed-v1 publisher pin",
          "production restart/drain or reviewed same-job reattachment",
          "deployed federation/ACL and credential-owner activation",
          "actual provider and Actions entitlement",
        ],
        separateMergeGates: ["source-qualified coverage", "per-file coverage", "CRAP", "full CI"],
        completeSecurityAcceptance: false,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  if (results.some((result) => !result.ok)) process.exitCode = 1
}

await main().catch(() => {
  process.stdout.write(
    serializePublicStatus({ stage: "test", outcome: "failed", reason: "refused", count: 0 }) + "\n",
  )
  process.exitCode = 1
})
