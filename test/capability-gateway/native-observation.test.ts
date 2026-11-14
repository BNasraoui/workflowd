import { expect, test } from "bun:test"
import { nativeResponseObservation } from "../../src/capability-gateway/native-observation"

const stream = (model = "selected", tokens = 3) =>
  [
    { type: "message_start", message: { model, role: "assistant" } },
    {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "private source and tool text" },
    },
    { type: "message_delta", usage: { output_tokens: tokens } },
    { type: "message_stop" },
  ]
    .map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
    .join("")

test("provider observations require complete selected responses and contain only bounded counts", async () => {
  const values: number[] = []
  const observer = nativeResponseObservation("selected", async (count) => {
    values.push(count)
  })
  for (const byte of Buffer.from(stream())) await observer(Uint8Array.of(byte))
  expect(values).toEqual([3])
  await observer(Buffer.from(stream()))
  expect(values).toEqual([3])
  for (const [bytes, refused] of [
    [stream("foreign"), true],
    [stream("selected", -1), true],
    [stream("selected", 10000001), true],
    [stream().replace(/event: message_stop[\s\S]+/, ""), false],
    ["x".repeat(1048577), true],
  ] as const) {
    const seen: number[] = []
    const receive = nativeResponseObservation("selected", async (count) => {
      seen.push(count)
    })
    if (refused) await expect(receive(Buffer.from(bytes))).rejects.toThrow()
    else await receive(Buffer.from(bytes))
    expect(seen).toEqual([])
  }
})
