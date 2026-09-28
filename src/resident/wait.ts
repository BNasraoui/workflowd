import { parseArgs } from "node:util"
import { requestRunSocket } from "../worker-identity/socket-client"
export async function registerResidentWait(
  argv: string[],
  env: Record<string, string | undefined>,
  request: typeof requestRunSocket = requestRunSocket,
) {
  const args = parseArgs({
    args: argv,
    options: {
      thread: { type: "string" },
      repo: { type: "string" },
      sha: { type: "string" },
      timeout: { type: "string", default: "3600" },
    },
  }).values
  const socket = env.WORKFLOWD_CODEX_RESIDENT_SOCKET
  if (
    socket === undefined ||
    args.thread === undefined ||
    args.repo === undefined ||
    args.sha === undefined
  )
    throw new Error(
      "Resident wait requires --thread, --repo, --sha and WORKFLOWD_CODEX_RESIDENT_SOCKET",
    )
  const response = await request(
    socket,
    "/ci/resident-waits",
    JSON.stringify({
      threadId: args.thread,
      repository: args.repo.toLowerCase(),
      sha: args.sha.toLowerCase(),
      timeoutMs: Number(args.timeout) * 1000,
    }),
  )
  if (response.status !== 202) throw new Error(`Resident wait refused (${response.status})`)
}
if (import.meta.main) {
  try {
    await registerResidentWait(process.argv.slice(2), process.env)
    console.log(
      "waiting for CI; end this turn now. workflowd will queue a completion or timeout event.",
    )
  } catch {
    console.error("Resident CI wait registration failed; do not end the turn as if registered")
    process.exitCode = 2
  }
}
