import { expect, test } from "bun:test"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { Effect, Fiber } from "effect"
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { makeCapabilityGateway } from "../../src/capability-gateway/service"
import { makeCapabilityTransport } from "../../src/sandbox/capability-transport"
import { runStoreMigrations } from "../../src/store/migrations"
import { transport } from "../capability-gateway/fixture"
import { exchangeJobProof } from "../../src/sandbox/bootstrap"
import { ownedPromise } from "../../src/capability-gateway/owned"
import { disposableSsh } from "./fixtures/ssh.mjs"

test("S2: failed relay spawn releases the acquired Unix server and directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "transport-failure-"))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runStoreMigrations
        const gateway = yield* makeCapabilityGateway({
          noscope: { binary: fixtureExecutable("noscope"), configHome: root },
          providerId: "anthropic",
          credentialRole: "fixture",
          maxStreams: 1,
          maxStreamsPerRun: 1,
        })
        const channel = yield* makeCapabilityTransport(
          gateway,
          join(root, "nonexistent-node"),
          root,
        )
        expect(
          (yield* Effect.result(
            channel.connect({ runId: "fixture", channel: "a".repeat(64) }, transport),
          ))._tag,
        ).toBe("Failure")
        expect(yield* Effect.promise(() => readdir(root))).toEqual([])
        yield* channel.disconnect("fixture")
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("S3: interrupted private exchange joins an in-progress proof callback", async () => {
  const accepted = Promise.withResolvers<void>()
  let cleaned = false
  await Effect.runPromise(
    Effect.gen(function* () {
      const exchange = ownedPromise((signal) =>
        exchangeJobProof(
          [process.execPath, "-e", 'process.stdout.write("{}\\n");setInterval(()=>{},1000)'],
          { audience: "workflowd:fixture", peerId: "fixture" },
          async (_, signal) => {
            accepted.resolve()
            return await Effect.runPromise(
              Effect.never.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    cleaned = true
                  }),
                ),
              ),
              { signal },
            )
          },
          signal,
        ),
      )
      const pending = yield* exchange.pipe(Effect.forkScoped)
      yield* Effect.promise(() => accepted.promise)
      yield* Fiber.interrupt(pending)
      expect(cleaned).toBe(true)
    }).pipe(Effect.scoped),
  )
}, 3000)

for (const attack of ["resets", "preface", "settings", "truncated"])
  test(`D/R9: real-SSH ${attack} containment and bounded cleanup`, async () => {
    const node = fixtureExecutable("node")
    const ssh = await disposableSsh(
      (root) =>
        `${node} ${resolve("test/sandbox/fixtures/rejected-peer.mjs")} ${attack} 2>${root}/peer.log`,
    )
    const root = await mkdtemp(join(tmpdir(), "rejected-h2-"))
    let requests = 0
    const backend = join(root, "http.sock")
    const server = Bun.serve({
      unix: backend,
      fetch() {
        requests++
        return new Response("fixture-valid")
      },
    })
    const child = Bun.spawn([node, resolve("deploy/sandbox/capability-relay.mjs"), "controller"], {
      stdin: new Blob([
        JSON.stringify({
          backend,
          ssh: [...ssh.args, "exec /usr/local/bin/runner-control capabilities"],
        }),
      ]),
      stdout: "pipe",
      stderr: "pipe",
    })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) console.error(await readFile(join(ssh.root, "peer.log"), "utf8"))
      expect({ stdout, stderr }).toEqual({
        stdout: attack === "resets" ? "ready\n" : "",
        stderr: "",
      })
      expect({ exited: code === 0 || code === 1, requests }).toEqual({
        exited: true,
        requests: attack === "resets" ? 8 : 0,
      })
      expect(await readFile(join(ssh.root, "peer.log"), "utf8")).toBe("")
      expect(requests).toBe(attack === "resets" ? 8 : 0)
    } finally {
      clearTimeout(timeout)
      child.kill("SIGKILL")
      await child.exited
      await server.stop(true)
      await ssh.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 10000)
