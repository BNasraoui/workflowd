// Exact dialects observed with Codex 0.159.1 and OpenCode beta-19242. Fixture
// tool instructions are synthetic; the real clients execute and report them.
import assert from "node:assert/strict"

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
export function nativeToolResponse(client, body, action, sequence) {
  const call = `call_${sequence}`
  const command = !action
    ? undefined
    : action[0] === "Bash"
      ? action[1].command
      : action[0] === "Read"
        ? `cat ${quote(action[1].file_path)}`
        : `python3 -c ${quote(`from pathlib import Path; Path(${JSON.stringify(action[1].file_path)}).write_text(${JSON.stringify(action[1].content)})`)}`
  if (client === "codex") {
    if (action) assert.ok(body.tools.some((tool) => tool.name === "exec_command"))
    const item = action
      ? {
          type: "function_call",
          id: call,
          call_id: call,
          name: "exec_command",
          arguments: JSON.stringify({ cmd: command, yield_time_ms: 10000 }),
          status: "completed",
        }
      : {
          type: "message",
          id: call,
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "Synthetic native turn complete.", annotations: [] },
          ],
        }
    const event = (type, value) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`
    return (
      event("response.created", { response: { id: call, status: "in_progress", output: [] } }) +
      event("response.output_item.added", { output_index: 0, item }) +
      event("response.output_item.done", { output_index: 0, item }) +
      event("response.completed", {
        response: {
          id: call,
          model: body.model,
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      })
    )
  }
  if (action) assert.ok(body.tools.some((tool) => tool.function?.name === "shell"))
  const delta = action
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: call,
            type: "function",
            function: {
              name: "shell",
              arguments: JSON.stringify({ command, description: "Synthetic native tool" }),
            },
          },
        ],
      }
    : { role: "assistant", content: "Synthetic native turn complete." }
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({ id: call, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
  return chunk(delta, null) + chunk({}, action ? "tool_calls" : "stop") + "data: [DONE]\n\n"
}

export function nativeToolResult(client, body, sequence) {
  const result =
    client === "codex"
      ? body.input.findLast(
          (item) => item.type === "function_call_output" && item.call_id === `call_${sequence}`,
        )?.output
      : body.messages.findLast(
          (item) => item.role === "tool" && item.tool_call_id === `call_${sequence}`,
        )?.content
  if (result === undefined) return []
  assert.equal(typeof result, "string")
  return [
    {
      is_error: !/(?:Process exited with code 0|Command exited with code 0\.)/.test(result),
      content: result,
    },
  ]
}
