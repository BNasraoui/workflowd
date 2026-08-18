import { expect, test } from "bun:test"
import { Effect } from "effect"
import { encodeRemoteFence } from "../../../src/remote/codec"
import { makeDeterministicTransport } from "./transport"

const fence = {
  version: 1,
  kind: "fence",
  jobId: "job-1",
  generation: 1,
  hostId: "runner-a",
  disposition: "current",
  issuedAt: "2026-08-18T00:00:00.000Z",
} as const

test("the in-memory transport delivers host-addressed bytes and acknowledges them", async () => {
  const transport = makeDeterministicTransport()
  await Effect.runPromise(transport.port.publishFence(fence))

  const deliveries = await Effect.runPromise(transport.port.takeHostBatch("runner-a"))
  expect(deliveries).toHaveLength(1)
  expect(deliveries[0]!.data).toEqual(await Effect.runPromise(encodeRemoteFence(fence)))
  expect(transport.pending("host")).toBe(1)

  await Effect.runPromise(deliveries[0]!.acknowledge)
  expect(transport.pending("host")).toBe(0)
})

test("delayed messages remain hidden until explicitly released", async () => {
  const transport = makeDeterministicTransport()
  await Effect.runPromise(transport.port.publishFence(fence))

  transport.delay("host")
  expect(await Effect.runPromise(transport.port.takeHostBatch("runner-a"))).toEqual([])
  transport.release("host")
  expect(await Effect.runPromise(transport.port.takeHostBatch("runner-a"))).toHaveLength(1)
})

test("delaying a channel holds its currently queued batch together", async () => {
  const transport = makeDeterministicTransport()
  await Effect.runPromise(transport.port.publishFence(fence))
  await Effect.runPromise(transport.port.publishFence({ ...fence, generation: 2 }))

  transport.delay("host")
  expect(await Effect.runPromise(transport.port.takeHostBatch("runner-a"))).toEqual([])
})

test("duplicating a message preserves bytes under a new delivery identity", async () => {
  const transport = makeDeterministicTransport()
  await Effect.runPromise(transport.port.publishFence(fence))

  transport.duplicate("host")
  const deliveries = await Effect.runPromise(transport.port.takeHostBatch("runner-a"))
  expect(deliveries).toHaveLength(2)
  expect(deliveries[1]!.data).toEqual(deliveries[0]!.data)
  expect(deliveries[1]!.deliveryId).not.toBe(deliveries[0]!.deliveryId)
})

test("a duplicate may redeliver the latest acknowledged message", async () => {
  const transport = makeDeterministicTransport()
  await Effect.runPromise(transport.port.publishFence(fence))
  const [original] = await Effect.runPromise(transport.port.takeHostBatch("runner-a"))
  await Effect.runPromise(original!.acknowledge)

  transport.duplicate("host")

  expect(await Effect.runPromise(transport.port.takeHostBatch("runner-a"))).toHaveLength(1)
})

test("reordering swaps the next two deliveries without changing them", async () => {
  const transport = makeDeterministicTransport()
  const newer = { ...fence, generation: 2 }
  await Effect.runPromise(transport.port.publishFence(fence))
  await Effect.runPromise(transport.port.publishFence(newer))

  transport.reorder("host")
  const deliveries = await Effect.runPromise(transport.port.takeHostBatch("runner-a"))
  expect(deliveries[0]!.data).toEqual(await Effect.runPromise(encodeRemoteFence(newer)))
  expect(deliveries[1]!.data).toEqual(await Effect.runPromise(encodeRemoteFence(fence)))
})

test("disconnected endpoints stop traffic until reconnect", async () => {
  const transport = makeDeterministicTransport()
  transport.disconnect("coordinator")
  expect(await Effect.runPromise(Effect.exit(transport.port.publishFence(fence)))).toMatchObject({
    _tag: "Failure",
  })

  transport.reconnect("coordinator")
  await Effect.runPromise(transport.port.publishFence(fence))
  transport.disconnect("runner-a")
  expect(await Effect.runPromise(transport.port.takeHostBatch("runner-a"))).toEqual([])
  transport.reconnect("runner-a")
  expect(await Effect.runPromise(transport.port.takeHostBatch("runner-a"))).toHaveLength(1)
})

test("fault injection can address unchanged bytes to the wrong host", async () => {
  const transport = makeDeterministicTransport()
  const data = await Effect.runPromise(encodeRemoteFence(fence))

  transport.injectHost("runner-b", data)
  expect(await Effect.runPromise(transport.port.takeHostBatch("runner-a"))).toEqual([])
  expect(await Effect.runPromise(transport.port.takeHostBatch("runner-b"))).toHaveLength(1)
})

test("the ordering mutation seam splits a normally atomic fetched batch", async () => {
  const transport = makeDeterministicTransport({ singleMessageBatches: true })
  await Effect.runPromise(transport.port.publishFence(fence))
  await Effect.runPromise(transport.port.publishFence({ ...fence, generation: 2 }))

  expect(await Effect.runPromise(transport.port.takeHostBatch("runner-a"))).toHaveLength(1)
})
