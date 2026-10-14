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
  const git = args[0] === "--git"
  if (git && args[1] !== "--") throw new Error("Expected -- before git arguments")
  const command = args.slice(git ? 2 : args[0] === "--" ? 1 : 0)
  if (command.length === 0) throw new Error("Worker command arguments missing")
  const response = await io.request(
    socket,
    `/workers/github/${encodeURIComponent(runId)}/token`,
    env.WORKFLOWD_WORKER_CAPABILITY === undefined
      ? undefined
      : JSON.stringify({
          sessionId: env.WORKFLOWD_WORKER_SESSION_ID,
          capability: env.WORKFLOWD_WORKER_CAPABILITY,
        }),
  )
  if (!response.ok)
    throw new Error(`Worker identity unavailable (${response.status}); no personal-token fallback`)
  const issued = Schema.decodeUnknownSync(Token)(await response.json())
  if (issued.expiresAt < Date.now() + 60000) throw new Error("Worker identity expires too soon")
  // A helper only answers github.com; it never puts credential material in argv.
  const helper =
    '!f() { host=; while IFS= read -r line; do case "$line" in host=*) host=${line#host=};; esac; done; if [ "$host" = github.com ]; then printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; fi; }; f'
  const argv = git
    ? [
        "git",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "http.extraHeader=",
        "-c",
        "http.sslVerify=true",
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${helper}`,
        ...command,
      ]
    : ["gh", ...command]
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
