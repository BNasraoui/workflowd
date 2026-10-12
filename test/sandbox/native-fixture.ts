import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"

const Request = Schema.Struct({
  model: Schema.String,
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        type: Schema.optionalKey(Schema.String),
        tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
      }),
    ),
  ),
})
export type NativeAction = { name: string; arguments: Record<string, unknown> }

/** Real CLI protocol, synthetic model replies and credentials; no inference provider is contacted. */
export async function nativeModelFixture(kind: "codex" | "claude", root: string) {
  let holdAfter = Infinity
  const gate = Promise.withResolvers<void>()
  const requests: unknown[] = []
  const catalogs: string[][] = []
  const actions: Array<NativeAction | ((request: unknown) => NativeAction)> = []
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith(kind === "codex" ? "/responses" : "/messages"))
        return Response.json({ models: [] })
      const raw: unknown = await request.json()
      const body = Schema.decodeUnknownSync(Request)(raw)
      requests.push(raw)
      if (requests.length > holdAfter) await gate.promise
      const names = (body.tools ?? []).flatMap(
        (tool) =>
          tool.tools?.map((child) => `${tool.name}.${child.name}`) ?? [
            tool.name ?? tool.type ?? "unknown",
          ],
      )
      catalogs.push(names)
      const next = actions.shift()
      const action = typeof next === "function" ? next(raw) : next
      const name =
        action === undefined
          ? ""
          : (names.find((value) => value.endsWith(action.name)) ?? action.name)
      const id = `call_${requests.length}`
      const event = (type: string, value: unknown) =>
        `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`
      let output: string
      if (kind === "codex") {
        const item =
          action === undefined
            ? {
                type: "message",
                id,
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: "native-fixture-complete", annotations: [] },
                ],
              }
            : {
                type: "function_call",
                id,
                call_id: id,
                name: name.split(".").at(-1),
                ...(name.includes(".") ? { namespace: name.split(".")[0] } : {}),
                arguments: JSON.stringify(action.arguments),
                status: "completed",
              }
        const items =
          action === undefined
            ? [item]
            : [
                {
                  type: "message",
                  id: `msg_${id}`,
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: "Running the remote fixture task.",
                      annotations: [],
                    },
                  ],
                },
                item,
              ]
        output =
          event("response.created", {
            type: "response.created",
            response: { id, status: "in_progress", output: [] },
          }) +
          items
            .map(
              (item, output_index) =>
                event("response.output_item.added", {
                  type: "response.output_item.added",
                  output_index,
                  item,
                }) +
                event("response.output_item.done", {
                  type: "response.output_item.done",
                  output_index,
                  item,
                }),
            )
            .join("") +
          event("response.completed", {
            type: "response.completed",
            response: {
              id,
              status: "completed",
              output: items,
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          })
      } else {
        const block =
          action === undefined
            ? { type: "text", text: "" }
            : { type: "tool_use", id, name, input: {} }
        const delta =
          action === undefined
            ? { type: "text_delta", text: "native-fixture-complete" }
            : { type: "input_json_delta", partial_json: JSON.stringify(action.arguments) }
        output =
          event("message_start", {
            type: "message_start",
            message: {
              id,
              type: "message",
              role: "assistant",
              model: body.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          }) +
          event("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: block,
          }) +
          event("content_block_delta", { type: "content_block_delta", index: 0, delta }) +
          event("content_block_stop", { type: "content_block_stop", index: 0 }) +
          event("message_delta", {
            type: "message_delta",
            delta: {
              stop_reason: action === undefined ? "end_turn" : "tool_use",
              stop_sequence: null,
            },
            usage: { output_tokens: 1 },
          }) +
          event("message_stop", { type: "message_stop" })
      }
      return new Response(output, { headers: { "Content-Type": "text/event-stream" } })
    },
  })
  const binary = Bun.which(kind)
  if (!binary) throw new Error(`Missing ${kind} fixture CLI`)
  const path = join(root, `${kind}-fixture`)
  const config =
    kind === "codex"
      ? [
          "-c",
          'model_provider="fixture"',
          "-c",
          `model_providers.fixture={name="fixture",base_url="${model.url.toString()}v1",wire_api="responses",requires_openai_auth=false}`,
        ]
      : []
  await writeFile(
    path,
    `#!${process.execPath}\nconst args=process.argv.slice(2); const i=args.indexOf("exec"); if(i>=0) args.splice(i+1,0,...${JSON.stringify(config)}); const child=Bun.spawn([${JSON.stringify(binary)},...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit",env:{...process.env,ANTHROPIC_BASE_URL:${JSON.stringify(model.url.toString())},ANTHROPIC_AUTH_TOKEN:"fixture-only",ANTHROPIC_API_KEY:"fixture-only",CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1"}});process.exitCode=await child.exited\n`,
    { mode: 0o755 },
  )
  return {
    binary: path,
    requests,
    catalogs,
    actions,
    holdAfter: (count: number) => {
      holdAfter = count
    },
    close: () => {
      gate.resolve()
      return model.stop(true)
    },
  }
}

export function remoteEnvironment(request: unknown): string {
  const visit = (value: unknown): string | undefined => {
    if (typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value)
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "id" in parsed &&
          typeof parsed.id === "string"
        )
          return parsed.id
        return visit(parsed)
      } catch {
        return undefined
      }
    }
    if (Array.isArray(value)) return value.map(visit).find((id) => id !== undefined)
    if (typeof value === "object" && value !== null)
      return Object.values(value)
        .map(visit)
        .find((id) => id !== undefined)
    return undefined
  }
  const id = visit(request)
  if (id === undefined) throw new Error("Remote environment creation returned no identity")
  return id
}
