import { parseArgs } from "node:util"
import { readFile } from "node:fs/promises"
import { waitCi } from "./ci/wait"

async function main() {
  const args = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      sha: { type: "string" },
      timeout: { type: "string", default: "3600" },
    },
  })
  if (
    args.positionals.join(" ") !== "wait ci" ||
    args.values.repo === undefined ||
    args.values.sha === undefined
  )
    throw new Error("Usage: workflowd wait ci --repo owner/name --sha SHA [--timeout seconds]")
  const token =
    process.env.WORKFLOWD_CI_TOKEN_FILE === undefined
      ? process.env.WORKFLOWD_CI_TOKEN
      : (await readFile(process.env.WORKFLOWD_CI_TOKEN_FILE, "utf8")).trim()
  if (token === undefined) throw new Error("Set WORKFLOWD_CI_TOKEN_FILE or WORKFLOWD_CI_TOKEN")
  const result = await waitCi(
    {
      repository: args.values.repo.toLowerCase(),
      sha: args.values.sha.toLowerCase(),
      timeoutMs: Number(args.values.timeout) * 1000,
      baseUrl: process.env.WORKFLOWD_URL ?? "http://127.0.0.1:8787",
      token,
    },
    { fetch, heartbeat: (line) => console.error(line) },
  )
  console.log(JSON.stringify(result))
  process.exitCode = result.conclusion === "success" ? 0 : 1
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "CI wait failed")
  process.exitCode = 2
})
