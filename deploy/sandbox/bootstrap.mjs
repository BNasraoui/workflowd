import { writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { openSession, takeJobIdentity } from "./bootstrap-helper.mjs"
import { sessionKeyPair } from "./renewal.mjs"

/**
 * The runner's first contact: it opens its gateway session with its own OIDC proof, then starts
 * the relay that holds the run token. The request authority is cleared before the relay starts.
 * The session's private key goes to the relay on its standard input with the grant, and to no
 * file, environment, argument or output.
 */
export async function prepare({
  directory = "/run/workflowd-sandbox",
  environment = process.env,
  identity = fetch,
  tooling = dirname(fileURLToPath(import.meta.url)),
  /** The pause between proofs; the helper's own when not named. */
  backoff,
  /**
   * The session key, a new one unless named. Only the test of the key's secrecy names one: it
   * must know the private key to search each output for it, and the key, by design, is
   * otherwise only in this process's memory and on the relay's standard input.
   */
  sessionKey = sessionKeyPair(),
} = {}) {
  const ref = environment.GITHUB_REF ?? ""
  if (!/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? "") || !ref.startsWith("refs/heads/workflowd/leases/"))
    throw new Error("lease ref refused")
  const leaseId = ref.slice("refs/heads/workflowd/leases/".length)
  const gateway = environment.SANDBOX_GATEWAY_URL ?? ""
  const issue = takeJobIdentity(environment, identity)
  let grant
  try {
    grant = await openSession({ gateway, leaseId, issue, backoff, sessionKey })
  } finally {
    issue.clear()
  }
  await writeFile(`${directory}/native-deadline`, String(grant.deadline), {
    mode: 0o600,
    flag: "wx",
  })
  const child = spawn(
    process.execPath,
    [`${tooling}/capability-relay.mjs`, "runner", directory],
    {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/home/runner",
        ...(environment.RUNNER_TRACKING_ID
          ? { RUNNER_TRACKING_ID: environment.RUNNER_TRACKING_ID }
          : {}),
        // Only a trust root this process already has; the runner image sets none.
        ...(environment.NODE_EXTRA_CA_CERTS
          ? { NODE_EXTRA_CA_CERTS: environment.NODE_EXTRA_CA_CERTS }
          : {}),
      },
      stdio: ["pipe", "pipe", "ignore"],
    },
  )
  child.stdin.end(JSON.stringify({ ...grant, gateway }))
  await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", () => reject(new Error("relay unavailable")))
    child.stdout.once("data", (bytes) =>
      bytes.toString() === "ready\n" ? resolve() : reject(new Error("relay unavailable")),
    )
  })
  child.stdout.destroy()
  child.unref()
  await writeFile(`${directory}/relay.pid`, String(child.pid), { mode: 0o600 })
  await writeFile(`${directory}/execution-mode`, "actions-native", { mode: 0o600 })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The public wrapper of this step shows only that it failed, so no cause is written.
  if (process.argv[2] === "prepare") await prepare().catch(() => (process.exitCode = 1))
  else process.exitCode = 1
}
