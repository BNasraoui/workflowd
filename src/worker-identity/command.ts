import { Schema } from "effect"
import { workerCommandEnvironment } from "./command-env"
import { requestRunSocket } from "./socket-client"
const Token = Schema.Struct({ token: Schema.String, expiresAt: Schema.Number })
export async function runWorkerCommand(
  args: string[],
  env: Record<string, string | undefined>,
  io: {
    request: typeof requestRunSocket
    run: (argv: string[], env: Record<string, string | undefined>) => Promise<number>
  },
) {
  const socket = env.WORKFLOWD_WORKER_GITHUB_SOCKET
  const runId = env.WORKFLOWD_RUN_ID
  if (socket === undefined || runId === undefined) throw new Error("Worker run environment missing")
  const separator = args.indexOf("--")
  if (separator < 0) throw new Error("Expected -- before command arguments")
  const response = await io.request(socket, `/workers/github/${encodeURIComponent(runId)}/token`)
  if (!response.ok)
    throw new Error(`Worker identity unavailable (${response.status}); no personal-token fallback`)
  const issued = Schema.decodeUnknownSync(Token)(await response.json())
  if (issued.expiresAt < Date.now() + 60000) throw new Error("Worker identity expires too soon")
  const git = args.slice(0, separator).includes("--git")
  // A helper only answers github.com; it never puts credential material in argv.
  const helper =
    '!f() { host=; while IFS= read -r line; do case "$line" in host=*) host=${line#host=};; esac; done; if [ "$host" = github.com ]; then printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; fi; }; f'
  const argv = git
    ? [
        "git",
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${helper}`,
        ...args.slice(separator + 1),
      ]
    : ["gh", ...args.slice(separator + 1)]
  return io.run(argv, workerCommandEnvironment(env, issued.token))
}
export async function spawnWorkerCommand(argv: string[], env: Record<string, string | undefined>) {
  return await Bun.spawn(argv, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    .exited
}
if (import.meta.main) {
  try {
    process.exitCode = await runWorkerCommand(process.argv.slice(2), process.env, {
      request: requestRunSocket,
      run: spawnWorkerCommand,
    })
  } catch {
    console.error(
      "Worker GitHub command failed; check broker availability, permissions, and run custody",
    )
    process.exitCode = 2
  }
}
