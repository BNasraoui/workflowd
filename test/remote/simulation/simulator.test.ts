import { expect, test } from "bun:test"
import { RemoteSimulation } from "./simulator"

test("enqueue and delivery settle through the real coordinator, stores, runner, and transport", async () => {
  await using simulation = await RemoteSimulation.make(101)

  await simulation.run([
    { type: "enqueue", host: "runner-a" },
    { type: "coordinator" },
    { type: "runner", host: "runner-a" },
    { type: "coordinator" },
  ])
  const summary = await simulation.quiesce()

  expect(summary).toMatchObject({ accepted: 1, succeeded: 1, executions: 1 })
})

test("duplicate command and result delivery applies terminal work once", async () => {
  await using simulation = await RemoteSimulation.make(102)

  await simulation.run([
    { type: "enqueue", host: "runner-a" },
    { type: "coordinator" },
    { type: "duplicate", channel: "host" },
    { type: "runner", host: "runner-a" },
    { type: "duplicate", channel: "result" },
  ])

  expect(await simulation.quiesce()).toMatchObject({
    succeeded: 1,
    executions: 1,
    completionEvents: 1,
  })
})

test("controlled time releases delayed delivery", async () => {
  await using simulation = await RemoteSimulation.make(103)

  await simulation.run([
    { type: "enqueue", host: "runner-a" },
    { type: "coordinator" },
    { type: "delay", channel: "host" },
    { type: "runner", host: "runner-a" },
    { type: "advance", milliseconds: 100 },
  ])

  expect(await simulation.quiesce()).toMatchObject({ succeeded: 1, executions: 1 })
})

test("controlled time releases a delayed result", async () => {
  await using simulation = await RemoteSimulation.make(116)

  await simulation.run([
    { type: "enqueue", host: "runner-a" },
    { type: "coordinator" },
    { type: "runner", host: "runner-a" },
    { type: "delay", channel: "result" },
    { type: "coordinator" },
    { type: "advance", milliseconds: 1 },
  ])

  expect(await simulation.quiesce()).toMatchObject({ succeeded: 1, executions: 1 })
})

test("reordered results remain independently acceptable", async () => {
  await using simulation = await RemoteSimulation.make(117)

  await simulation.run([
    { type: "enqueue", host: "runner-a" },
    { type: "enqueue", host: "runner-b" },
    { type: "coordinator" },
    { type: "coordinator" },
    { type: "runner", host: "runner-a" },
    { type: "runner", host: "runner-b" },
    { type: "reorder", channel: "result" },
  ])

  expect(await simulation.quiesce()).toMatchObject({ succeeded: 2, executions: 2 })
})

test("reordered command and fence still execute on the addressed runner", async () => {
  await using simulation = await RemoteSimulation.make(104)

  await simulation.run([
    { type: "enqueue", host: "runner-b" },
    { type: "coordinator" },
    { type: "reorder", channel: "host" },
    { type: "runner", host: "runner-b" },
  ])

  expect(await simulation.quiesce()).toMatchObject({ succeeded: 1, executions: 1 })
})

test("offline runner progresses after reconnect", async () => {
  await using simulation = await RemoteSimulation.make(105)

  await simulation.run([
    { type: "enqueue", host: "runner-a" },
    { type: "coordinator" },
    { type: "disconnect", host: "runner-a" },
    { type: "runner", host: "runner-a" },
    { type: "reconnect", host: "runner-a" },
  ])

  expect(await simulation.quiesce()).toMatchObject({ succeeded: 1, executions: 1 })
})

test("coordinator publication recovers after reconnect", async () => {
  await using simulation = await RemoteSimulation.make(106)

  await simulation.run([
    { type: "enqueue", host: "runner-b" },
    { type: "disconnect", host: "coordinator" },
    { type: "coordinator" },
    { type: "reconnect", host: "coordinator" },
  ])

  expect(await simulation.quiesce()).toMatchObject({ succeeded: 1, executions: 1 })
})

test("coordinator consumes an offline result after reconnect", async () => {
  await using simulation = await RemoteSimulation.make(118)

  await simulation.run([
    { type: "enqueue", host: "runner-a" },
    { type: "coordinator" },
    { type: "runner", host: "runner-a" },
    { type: "disconnect", host: "coordinator" },
    { type: "coordinator" },
    { type: "reconnect", host: "coordinator" },
  ])

  expect(await simulation.quiesce()).toMatchObject({ succeeded: 1, executions: 1 })
})

test("coordinator restart preserves dispatch custody", async () => {
  await using simulation = await RemoteSimulation.make(107)

  await simulation.run([
    { type: "enqueue", host: "runner-a" },
    { type: "disconnect", host: "coordinator" },
    { type: "coordinator" },
    { type: "restart", service: "coordinator" },
    { type: "reconnect", host: "coordinator" },
  ])

  expect(await simulation.quiesce()).toMatchObject({ succeeded: 1, executions: 1 })
})

test("lease expiry fences the stale attempt before retry settles", async () => {
  await using simulation = await RemoteSimulation.make(108)

  await simulation.run([
    { type: "enqueue", host: "runner-a" },
    { type: "coordinator" },
    { type: "advance", milliseconds: 1_000 },
    { type: "coordinator" },
    { type: "runner", host: "runner-a" },
  ])

  expect(await simulation.quiesce()).toMatchObject({
    succeeded: 1,
    executions: 1,
    latestAttempt: 2,
    fences: 3,
  })
})

test("a result remains valid after its remote lease expires but before command expiry", async () => {
  await using simulation = await RemoteSimulation.make(114)

  await simulation.run([
    { type: "enqueue", host: "runner-a" },
    { type: "coordinator" },
    { type: "advance", milliseconds: 500 },
    { type: "runner", host: "runner-a" },
  ])

  expect(await simulation.quiesce()).toMatchObject({
    succeeded: 1,
    latestAttempt: 1,
    expiredLeases: 1,
  })
})

test("cancellation reaches the runner before recoverable work settles", async () => {
  await using simulation = await RemoteSimulation.make(109)

  await simulation.run([
    { type: "enqueue", host: "runner-b" },
    { type: "coordinator" },
    { type: "cancel" },
    { type: "runner", host: "runner-b" },
  ])

  expect(await simulation.quiesce()).toMatchObject({ succeeded: 1, latestAttempt: 2, fences: 3 })
})

test("wrong-host work is rejected without execution", async () => {
  await using simulation = await RemoteSimulation.make(110)

  await simulation.run([
    { type: "enqueue", host: "runner-a" },
    { type: "coordinator" },
    { type: "wrongHost" },
    { type: "runner", host: "runner-b" },
  ])

  expect(await simulation.quiesce()).toMatchObject({ succeeded: 1, executions: 1, wrongHost: 1 })
})

test("stale result tokens cannot advance coordinator state", async () => {
  await using simulation = await RemoteSimulation.make(111)

  await simulation.run([
    { type: "enqueue", host: "runner-a" },
    { type: "coordinator" },
    { type: "staleResult" },
    { type: "coordinator" },
  ])

  expect(await simulation.quiesce()).toMatchObject({
    succeeded: 1,
    executions: 1,
    staleResults: 1,
    completionEvents: 1,
  })
})

test("fault injection tolerates a disconnected result publisher", async () => {
  await using simulation = await RemoteSimulation.make(115)

  await simulation.run([
    { type: "enqueue", host: "runner-a" },
    { type: "coordinator" },
    { type: "disconnect", host: "runner-a" },
    { type: "staleResult" },
    { type: "reconnect", host: "runner-a" },
  ])

  expect(await simulation.quiesce()).toMatchObject({ succeeded: 1 })
})

test("runner restart preserves deduplication state", async () => {
  await using simulation = await RemoteSimulation.make(112)

  await simulation.run([
    { type: "enqueue", host: "runner-b" },
    { type: "coordinator" },
    { type: "runner", host: "runner-b" },
    { type: "restart", service: "runner-b" },
    { type: "duplicate", channel: "host" },
    { type: "runner", host: "runner-b" },
  ])

  expect(await simulation.quiesce()).toMatchObject({ succeeded: 1, executions: 1, duplicates: 1 })
})

test("bounded backlog pressure does not starve either runner", async () => {
  await using simulation = await RemoteSimulation.make(113)
  const actions = Array.from({ length: 12 }, (_, index) => ({
    type: "enqueue" as const,
    host: index % 2 === 0 ? ("runner-a" as const) : ("runner-b" as const),
  }))

  await simulation.run(actions)

  expect(await simulation.quiesce()).toMatchObject({ accepted: 12, succeeded: 12, executions: 12 })
})
