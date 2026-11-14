import { connect } from "node:net"
import { pipeline } from "node:stream"
import { serveRunnerRelay } from "../../../deploy/sandbox/capability-relay.mjs"

const [operation, root] = process.argv.slice(2)
if (operation === "runner") {
  let text = ""
  for await (const bytes of process.stdin) {
    text += bytes.toString()
    if (text.length > 16384) throw new Error("fixture input bound")
  }
  const relay = await serveRunnerRelay(JSON.parse(text), root)
  process.stdout.write("ready\n")
  process.once("SIGTERM", relay.close)
} else {
  const file = {
    "exec /usr/local/bin/runner-control bootstrap": "bootstrap.sock",
    "exec /usr/local/bin/runner-control capabilities": "capability.sock",
  }[process.env.SSH_ORIGINAL_COMMAND]
  if (!file) throw new Error("fixture command refused")
  const socket = connect(`${root}/${file}`)
  pipeline(process.stdin, socket, (error) => {
    if (error) socket.destroy()
  })
  pipeline(socket, process.stdout, (error) => {
    if (error) socket.destroy()
  })
}
