// Disposable SSH ForceCommand: fixed production bootstrap and native operations.
import { appendFile } from "node:fs/promises"
import { connect } from "node:net"
import { pipeline } from "node:stream"

const root = "/evidence/native-runtime"
const operation = process.env.SSH_ORIGINAL_COMMAND
if (
  [
    "exec /usr/local/bin/runner-control bootstrap",
    "exec /usr/local/bin/runner-control capabilities",
  ].includes(operation)
) {
  const socket = connect(
    `${root}/${operation.endsWith(" bootstrap") ? "bootstrap" : "capability"}.sock`,
  )
  pipeline(process.stdin, socket, (error) => {
    if (error) socket.destroy()
  })
  pipeline(socket, process.stdout, (error) => {
    if (error) socket.destroy()
  })
} else {
  const match =
    /^exec \/usr\/local\/bin\/runner-control (native-(?:initialize|execute|stop|evidence|result|cleanup))$/.exec(
      operation ?? "",
    )
  if (!match) throw new Error("Fixture SSH operation refused")
  if (match[1] === "native-stop")
    await appendFile(`${root}/native-stop-requested`, "stop\n", { mode: 0o600 })
  process.argv[2] = match[1]
  await import("/source/deploy/sandbox/native-runner.mjs")
}
