import { createInterface } from "node:readline"

const mode = process.argv[2] ?? "normal"
let initialized = false
const model = (id, isDefault) => ({
  id: `picker-${id}`,
  model: id,
  displayName: id,
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "deliberate", description: "provider-defined" },
    { reasoningEffort: "max", description: "more" },
  ],
  defaultReasoningEffort: "deliberate",
  inputModalities: ["text", "image"],
  isDefault,
  ...(mode === "tiers"
    ? {
        serviceTiers: [{ id: "priority", name: "Fast", description: "priority" }],
        defaultServiceTier: null,
      }
    : {}),
})
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line)
  if (frame.method === "initialized") {
    initialized = true
    return
  }
  let result
  if (frame.method === "initialize") result = { userAgent: "fixture" }
  else if (!initialized) {
    process.exit(3)
  } else if (frame.method === "account/read")
    result = {
      account:
        mode === "unauthenticated" ? null : { type: "chatgpt", email: "private@example.com" },
      requiresOpenaiAuth: true,
    }
  else if (frame.method === "config/read")
    result = { config: { model_provider: "fixture-provider", secret: "credential-secret" } }
  else if (frame.method === "model/list") {
    if (mode === "oversized") {
      process.stdout.write("x".repeat(2_000_001))
      return
    }
    if (mode === "hang") return
    if (mode === "unsupported") {
      process.stdout.write(
        JSON.stringify({ id: frame.id, error: { code: -32601, message: "credential-secret" } }) +
          "\n",
      )
      return
    }
    if (mode === "malformed") result = { data: [{ model: "broken" }], nextCursor: null }
    else
      result = {
        data: [model(frame.params.cursor ? "second" : "first", !frame.params.cursor)],
        nextCursor: frame.params.cursor && mode !== "cycle" ? null : "next",
      }
  } else {
    process.exit(4)
  }
  process.stdout.write(JSON.stringify({ id: frame.id, result }) + "\n")
})
