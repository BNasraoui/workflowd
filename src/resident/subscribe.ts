import { parseArgs } from "node:util"
import { Schema } from "effect"
import { requestRunSocket } from "../worker-identity/socket-client"
import { EventSelector } from "./subscriptions"

const Receipt = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["registered", "duplicate"]),
  instruction: Schema.optional(Schema.String),
  deliveryState: Schema.optional(
    Schema.Literals(["pending", "prepared", "sending", "delivered", "operator_required"]),
  ),
})

export async function subscribeToEvent(
  selector: unknown,
  env: Record<string, string | undefined>,
  request: typeof requestRunSocket = requestRunSocket,
) {
  const decoded = Schema.decodeUnknownSync(EventSelector)(selector, { onExcessProperty: "error" })
  const socket = env.WORKFLOWD_OPENCODE_RESIDENT_SOCKET ?? env.WORKFLOWD_CODEX_RESIDENT_SOCKET
  const runId = env.WORKFLOWD_RUN_ID
  if (socket === undefined || runId === undefined)
    throw new Error("Resident run environment required")
  const response = await request(
    socket,
    "/subscriptions",
    JSON.stringify({
      runId,
      selector: decoded,
      ...(env.WORKFLOWD_OPENCODE_RESIDENT_SOCKET === undefined
        ? {}
        : { capability: env.WORKFLOWD_SUBSCRIPTION_CAPABILITY }),
    }),
  )
  if (response.status !== 202) throw new Error(`Subscription refused (${response.status})`)
  return Schema.decodeUnknownSync(Receipt)(await response.json())
}

if (import.meta.main) {
  try {
    const args = parseArgs({
      options: {
        repo: { type: "string" },
        sha: { type: "string" },
        "agent-run": { type: "string" },
      },
    }).values
    const selector =
      args["agent-run"] === undefined
        ? { kind: "ci", repository: args.repo, sha: args.sha }
        : { kind: "agent_run", run_id: args["agent-run"] }
    console.log(JSON.stringify(await subscribeToEvent(selector, process.env)))
  } catch {
    console.error("Subscription registration failed; do not end the turn as if registered")
    process.exitCode = 2
  }
}
