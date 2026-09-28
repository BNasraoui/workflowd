import { parseArgs } from "node:util"
import { readFile } from "node:fs/promises"
async function main() {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      thread: { type: "string" },
      repo: { type: "string" },
      sha: { type: "string" },
      timeout: { type: "string", default: "3600" },
    },
  }).values
  const tokenFile = process.env.WORKFLOWD_CODEX_RESIDENT_TOKEN_FILE
  if (
    tokenFile === undefined ||
    args.thread === undefined ||
    args.repo === undefined ||
    args.sha === undefined
  )
    throw new Error(
      "Resident wait requires --thread, --repo, --sha and WORKFLOWD_CODEX_RESIDENT_TOKEN_FILE",
    )
  const url = new URL(process.env.WORKFLOWD_URL ?? "http://127.0.0.1:8787")
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("Resident endpoint requires HTTPS or loopback")
  const response = await fetch(new URL("/ci/resident-waits", url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${(await readFile(tokenFile, "utf8")).trim()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      threadId: args.thread,
      repository: args.repo.toLowerCase(),
      sha: args.sha.toLowerCase(),
      timeoutMs: Number(args.timeout) * 1000,
    }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
  if (response.status !== 202) throw new Error(`Resident wait refused (${response.status})`)
  console.log(
    "waiting for CI; end this turn now. workflowd will queue a completion or timeout event.",
  )
}
void main().catch(() => {
  console.error("Resident CI wait registration failed; do not end the turn as if registered")
  process.exitCode = 2
})
