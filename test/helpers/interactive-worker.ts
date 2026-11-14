import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { runClaudeInteractiveWorker, type CliWorkerOptions } from "../../src/kernel/codex-worker"
import { fixtureExecutable } from "./fixture-executable.mjs"
import { makeDurableCliProcess, type CliProcessOptions } from "../../src/kernel/codex-session"
import { parseClaudeDispatchEvent } from "../../src/kernel/claude-dispatch"
import { Effect } from "effect"

const pinned = "bc1aad9982c7b59c7d889ff92595d61cf46e0a6eae074cb551d932a989bcd222"

/** Synthetic-upstream environment for the production interactive worker: isolated
 * namespace, pinned binary, private HOME and no host credential variables. */
export async function interactiveFixtureEnvironment(
  binary: string,
  baseUrl: string,
  home: string,
  base: Readonly<Record<string, string | undefined>> = process.env,
) {
  // Refuse before any fixture provisioning or native launch, as the old helper did:
  // an absent host namespace receipt is not isolation.
  const host = base.WORKFLOWD_FIXTURE_HOST_NETNS
  if (host === undefined || !/^net:\[\d+\]$/.test(host))
    throw new Error("Interactive fixture requires its host namespace receipt")
  if ((await readlink("/proc/self/ns/net")) === host)
    throw new Error("Interactive fixture requires its isolated namespace")
  if (
    createHash("sha256")
      .update(await readFile(binary))
      .digest("hex") !== pinned
  )
    throw new Error("Interactive fixture requires pinned Claude 2.1.301")
  if (new URL(baseUrl).hostname !== "127.0.0.1")
    throw new Error("Interactive fixture requires its loopback upstream")
  await mkdir(home, { recursive: true, mode: 0o700 })
  // Explicit synthetic-fixture onboarding (production turns refuse instead of writing it).
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", autoUpdates: false }),
    { mode: 0o600 },
  )
  const kept = Object.entries(base).filter(
    ([key]) =>
      [
        "PATH",
        "LANG",
        "TMPDIR",
        "WORKFLOWD_RUN_ID",
        "WORKFLOWD_WORKER_GITHUB_SOCKET",
        "GH_CONFIG_DIR",
      ].includes(key) || key.startsWith("GIT_"),
  )
  return {
    ...Object.fromEntries(kept),
    HOME: home,
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth-sentinel",
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  }
}

/** Production normal-PTY Claude worker against the fixture's synthetic upstream. */
export async function runInteractiveWorker(options: CliWorkerOptions, baseUrl: string) {
  const binary = fixtureExecutable("claude")
  const env = await interactiveFixtureEnvironment(
    binary,
    baseUrl,
    join(options.directory, ".fixture-native-home"),
  )
  return runClaudeInteractiveWorker(
    { ...options, binary },
    { id: randomUUID(), resume: false },
    35000,
    env,
  )
}

/** Same durable subprocess custody as production dispatch, with its normal PTY
 * worker reached through a fixture entrypoint that supplies the synthetic upstream. */
export const makeInteractiveDispatchCli = (
  options: Omit<CliProcessOptions, "driver">,
  baseUrl: string,
) =>
  makeDurableCliProcess({
    ...options,
    identity: {
      environment: (runId) => ({
        ...options.identity?.environment(runId),
        WORKFLOWD_FIXTURE_UPSTREAM: baseUrl,
      }),
      register: (runId, pid) => options.identity?.register(runId, pid),
    },
    driver: {
      name: "claude",
      workerPath: resolve("test/helpers/interactive-dispatch-worker.ts"),
      parseEvent: parseClaudeDispatchEvent,
      preflight: Effect.void,
    },
  })
