import { writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { openSession, takeJobIdentity } from "./bootstrap-helper.mjs"

/**
 * The runner's first contact: it opens its gateway session with its own OIDC proof, then starts
 * the relay that holds the run token. The request authority is cleared before the relay starts.
 */
export async function prepare({
  directory = "/run/workflowd-sandbox",
  environment = process.env,
  identity = fetch,
  tooling = dirname(fileURLToPath(import.meta.url)),
} = {}) {
  const image = environment.SANDBOX_AGENT_IMAGE
  const workflowSha = environment.GITHUB_SHA
  const ref = environment.GITHUB_REF ?? ""
  if (
    !/^ghcr\.io\/bnasraoui\/workflowd-agent-base@sha256:[a-f0-9]{64}$/.test(image ?? "") ||
    !/^[a-f0-9]{40}$/.test(workflowSha ?? "") ||
    !ref.startsWith("refs/heads/workflowd/leases/")
  )
    throw new Error()
  const leaseId = ref.slice("refs/heads/workflowd/leases/".length)
  await writeFile(`${directory}/agent-image`, image, { mode: 0o600 })
  await writeFile(
    `${directory}/identity.json`,
    JSON.stringify({ repository: environment.GITHUB_REPOSITORY, leaseId }),
    { mode: 0o600 },
  )
  const gateway = environment.SANDBOX_GATEWAY_URL ?? ""
  const issue = takeJobIdentity(environment, identity)
  let grant
  try {
    grant = await openSession({ gateway, leaseId, issue })
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
  try {
    if (process.argv[2] !== "prepare") throw new Error()
    await prepare()
  } catch {
    process.stderr.write("private bootstrap unavailable\n")
    process.exitCode = 1
  }
}
