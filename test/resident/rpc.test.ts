import { expect, test } from "bun:test"
import { RpcClient } from "../../src/resident/rpc"
import { RpcRequestError } from "../../src/resident/rpc"
test("multiplexes concurrent requests and routes notifications without consuming replies", async () => {
  const sent: string[] = []
  const notifications: unknown[] = []
  const rpc = new RpcClient(
    (line) => {
      sent.push(line)
    },
    (event) => notifications.push(event),
    1000,
  )
  const a = rpc.request("thread/start", { cwd: "/a" })
  const b = rpc.request("thread/start", { cwd: "/b" })
  const first = JSON.parse(sent[0]!)
  const second = JSON.parse(sent[1]!)
  rpc.receive(JSON.stringify({ method: "turn/completed", params: { threadId: "b" } }))
  rpc.receive(JSON.stringify({ id: second.id, result: { thread: { id: "b" } } }))
  rpc.receive(JSON.stringify({ id: first.id, result: { thread: { id: "a" } } }))
  expect(await a).toEqual({ thread: { id: "a" } })
  expect(await b).toEqual({ thread: { id: "b" } })
  expect(notifications).toHaveLength(1)
  rpc.close()
})
test("disconnect rejects pending calls and redacts server errors", async () => {
  const rpc = new RpcClient(
    () => {},
    () => {},
    1000,
  )
  const pending = rpc.request("thread/start", {})
  rpc.close()
  await expect(pending).rejects.toThrow("disconnected")
  await expect(rpc.request("thread/start", {})).rejects.toThrow("disconnected")
})

test("RPC error codes distinguish unsupported discovery while messages stay redacted", async () => {
  let sent = ""
  const rpc = new RpcClient(
    (line) => {
      sent = line
    },
    () => {},
    1000,
  )
  const pending = rpc.request("model/list", {})
  rpc.receive(
    JSON.stringify({ id: JSON.parse(sent).id, error: { code: -32601, message: "secret" } }),
  )
  try {
    await pending
    throw new Error("expected failure")
  } catch (error) {
    expect(error).toBeInstanceOf(RpcRequestError)
    expect(error instanceof RpcRequestError && error.code).toBe(-32601)
    expect(String(error)).not.toContain("secret")
  } finally {
    rpc.close()
  }
})
