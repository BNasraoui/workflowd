import { expect, test } from "bun:test"
import { Effect } from "effect"
import { connect } from "@nats-io/transport-node"
import { jetstreamManager } from "@nats-io/jetstream"
import { CiProvider, CiProviderLive } from "../../src/ci/provider"
import { githubFixture } from "./github-fixture"
const docker = async (...args: string[]) => {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const [text, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(error)
  return text.trim()
}
test("live CI provider persists NATS publications and uses conditional installation requests", async () => {
  const name = `workflowd-ci-test-${process.pid}`
  const fixture = await githubFixture()
  await docker(
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1::4222",
    "nats:2.11.8-alpine",
    "-js",
    "--auth",
    "test-token",
  )
  try {
    const address = await docker("port", name, "4222/tcp")
    const servers = [`nats://${address}`]
    const live = CiProviderLive(
      { token: "ci", repositories: [], servers, auth: { mode: "token", token: "test-token" } },
      fixture.github,
      fixture.OctokitClass,
    )
    // Docker reports the mapping after the listener is created; NATS may still
    // be bootstrapping JetStream, so connection uses its bounded initial retry.
    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* CiProvider
        const request = yield* provider.request(1)
        const first = yield* Effect.tryPromise(() => request("/repos/o/r/actions/runs", null))
        expect(first.etag).toBe("test-etag")
        fixture.setStatus(304)
        expect(
          (yield* Effect.tryPromise(() => request("/repos/o/r/actions/runs", "test-etag"))).status,
        ).toBe(304)
        fixture.setStatus(403)
        expect(
          (yield* Effect.result(Effect.tryPromise(() => request("/repos/o/r/actions/runs", null))))
            ._tag,
        ).toBe("Failure")
        yield* provider.publish("workflowd.v1.ci.repo.sha", '{"sequence":1}', "ci:1")
        yield* provider.publish("workflowd.v1.ci.repo.sha", '{"sequence":1}', "ci:1")
      }).pipe(Effect.provide(live)),
    )
    const nc = await connect({ servers, token: "test-token" })
    try {
      expect(
        (await (await jetstreamManager(nc)).streams.info("WORKFLOWD_CI_V1")).state.messages,
      ).toBe(1)
    } finally {
      await nc.drain()
    }
    // Existing compatible infrastructure is reused.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* CiProvider
      }).pipe(Effect.provide(live)),
    )
  } finally {
    await docker("rm", "-f", name)
    await fixture.close()
  }
}, 60000)
