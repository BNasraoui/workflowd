import { readFile } from "node:fs/promises"
import { Schema } from "effect"
import { workerCommandEnvironment } from "./command-env"
const Identity = Schema.Struct({
  endpoint: Schema.String,
  runId: Schema.String,
  capability: Schema.String,
})
const Token = Schema.Struct({ token: Schema.String, expiresAt: Schema.Number })
async function main() {
  const args = process.argv.slice(2)
  if (args[0] !== "--identity" || args[1] === undefined)
    throw new Error("Expected --identity FILE [--git] -- arguments")
  const identity = Schema.decodeUnknownSync(Identity)(JSON.parse(await readFile(args[1], "utf8")))
  const separator = args.indexOf("--")
  if (separator < 0) throw new Error("Expected -- before command arguments")
  const endpoint = new URL(identity.endpoint)
  if (
    endpoint.protocol !== "https:" &&
    !(
      endpoint.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    )
  )
    throw new Error("Worker broker requires HTTPS or loopback")
  const response = await fetch(
    new URL(`/workers/github/${encodeURIComponent(identity.runId)}/token`, endpoint),
    {
      method: "POST",
      headers: { authorization: `Bearer ${identity.capability}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  )
  if (!response.ok)
    throw new Error(`Worker identity unavailable (${response.status}); no personal-token fallback`)
  const issued = Schema.decodeUnknownSync(Token)(await response.json())
  if (issued.expiresAt < Date.now() + 60000) throw new Error("Worker identity expires too soon")
  const git = args.slice(2, separator).includes("--git")
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
  const child = Bun.spawn(argv, {
    env: workerCommandEnvironment(process.env, issued.token),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  process.exitCode = await child.exited
}
void main().catch(() => {
  console.error(
    "Worker GitHub command failed; check broker availability, permissions, and run custody",
  )
  process.exitCode = 2
})
