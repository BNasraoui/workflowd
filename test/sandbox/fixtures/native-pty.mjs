// Ordinary fixture backend only: actual pinned interactive CLI under a local PTY,
// production supervisor/control protocol, no container-isolation claim.
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Readable } from "node:stream"
import { nativeControlLines, superviseNative } from "../../../deploy/sandbox/native-supervisor.mjs"
import { ownNativeProcess } from "../../../deploy/sandbox/native-command.mjs"

const [root, binary, socket] = process.argv.slice(2)
const lines = nativeControlLines(process.stdin)
const request = JSON.parse((await lines.next()).value)
await mkdir(join(root, "workspace"), { recursive: true })
const control = Readable.from(
  (async function* () {
    for await (const line of lines) yield line + "\n"
  })(),
)
let owned
try {
  await superviseNative({
    directory: root,
    request,
    control,
    event: (value) => console.log(JSON.stringify(value)),
    backend: {
      async start() {
        owned = ownNativeProcess(
          spawn(
            "/usr/bin/python3",
            [
              "-I",
              fileURLToPath(
                new URL("../../../deploy/sandbox/claude-interactive.py", import.meta.url),
              ),
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          ),
        )
        await writeFile(join(root, "custodian.pid"), String(owned.child.pid), { mode: 0o600 })
        owned.child.stdin.write(
          JSON.stringify({
            binary,
            home: join(root, "home"),
            workspace: join(root, "workspace"),
            session: request.session,
            model: request.model,
            effort: request.effort,
            prompt: request.prompt,
            resume: request.resume,
            baseUrl: { socket },
            sentinel: "fixture-sentinel",
            deadline: request.deadline / 1000,
            tools: ["Read", "Write", "Bash"],
            allowedTools: ["Read", "Write", "Bash(python3 *)"],
          }) + "\n",
        )
        return owned
      },
      async stop() {
        if (owned) await owned.closed
      },
    },
  })
} finally {
  control.destroy()
  process.stdin.destroy()
}
