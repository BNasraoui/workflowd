import { serveRunnerRelay } from "../../../deploy/sandbox/capability-relay.mjs"

const [operation, root] = process.argv.slice(2)
if (operation !== "runner") throw new Error("fixture operation refused")
let text = ""
for await (const bytes of process.stdin) {
  text += bytes.toString()
  if (text.length > 16384) throw new Error("fixture input bound")
}
const relay = await serveRunnerRelay(JSON.parse(text), root)
process.stdout.write("ready\n")
process.once("SIGTERM", relay.close)
