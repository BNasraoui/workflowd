import { parseArgs } from "node:util"
import { readFile } from "node:fs/promises"
import { waitCi } from "./ci/wait"

export async function runWaitCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  io: { fetch: typeof fetch; log: (text: string) => void; heartbeat: (text: string) => void },
) {
  const args = parseArgs({
    args: argv,
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
    env.WORKFLOWD_CI_TOKEN_FILE === undefined
      ? env.WORKFLOWD_CI_TOKEN
      : (await readFile(env.WORKFLOWD_CI_TOKEN_FILE, "utf8")).trim()
  if (token === undefined) throw new Error("Set WORKFLOWD_CI_TOKEN_FILE or WORKFLOWD_CI_TOKEN")
  const result = await waitCi(
    {
      repository: args.values.repo.toLowerCase(),
      sha: args.values.sha.toLowerCase(),
      timeoutMs: Number(args.values.timeout) * 1000,
      baseUrl: env.WORKFLOWD_URL ?? "http://127.0.0.1:8787",
      token,
    },
    { fetch: io.fetch, heartbeat: io.heartbeat },
  )
  io.log(JSON.stringify(result))
  return result.conclusion === "success" ? 0 : 1
}
if (import.meta.main) {
  try {
    process.exitCode = await runWaitCommand(process.argv.slice(2), process.env, {
      fetch,
      log: console.log,
      heartbeat: console.error,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : "CI wait failed")
    process.exitCode = 2
  }
}
