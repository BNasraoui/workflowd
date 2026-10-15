import { expect, test } from "bun:test"
import { Effect } from "effect"
import { connect } from "@nats-io/transport-node"
import {
  type StreamConfig,
  jetstreamManager,
  StorageType,
  RetentionPolicy,
  DiscardPolicy,
} from "@nats-io/jetstream"
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
const withProvider = async (
  run: (
    live: ReturnType<typeof CiProviderLive>,
    servers: string[],
    fixture: Awaited<ReturnType<typeof githubFixture>>,
  ) => Promise<void>,
) => {
  const fixture = await githubFixture()
  let container: string | undefined
  try {
    // Docker allocates the host port and each container owns its store directory.
    container = await docker(
      "run",
      "-d",
      "-p",
      "127.0.0.1::4222",
      "nats:2.11.8-alpine",
      "-js",
      "-sd",
      "/data",
      "--auth",
      "test-token",
    )
    const address = await docker("port", container, "4222/tcp")
    const servers = [`nats://${address}`]
    const live = CiProviderLive(
      { token: "ci", repositories: [], servers, auth: { mode: "token", token: "test-token" } },
      fixture.github,
      fixture.OctokitClass,
    )
    await run(live, servers, fixture)
  } finally {
    try {
      if (container !== undefined) await docker("rm", "-f", container)
    } finally {
      await fixture.close()
    }
  }
}

test("live CI provider persists NATS publications and uses conditional installation requests", async () => {
  await withProvider(async (live, servers, fixture) => {
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
  })
}, 60000)

// Never delete and recreate WORKFLOWD_CI_V1 in one store: NATS file-store
// teardown can overlap its replacement. Each case starts with an empty store.
const mismatches: Partial<StreamConfig>[] = [
  { storage: StorageType.Memory },
  { discard: DiscardPolicy.New },
  { max_age: 100000000, duplicate_window: 100000000 },
  { max_bytes: 1 },
  { retention: RetentionPolicy.Interest },
  { subjects: ["workflowd.other.>"] },
]
test.each(mismatches)(
  "live CI provider refuses an incompatible stream: %j",
  async (mismatch) => {
    await withProvider(async (live, servers) => {
      const admin = await connect({ servers, token: "test-token" })
      try {
        const manager = await jetstreamManager(admin)
        await manager.streams.add({
          name: "WORKFLOWD_CI_V1",
          subjects: ["workflowd.v1.ci.>"],
          storage: StorageType.File,
          retention: RetentionPolicy.Limits,
          discard: DiscardPolicy.Old,
          max_age: 86400 * 1e9,
          max_bytes: 64 * 1024 * 1024,
          ...mismatch,
        })
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            yield* CiProvider
          }).pipe(Effect.provide(live), Effect.result),
        )
        expect(result._tag).toBe("Failure")
        expect(String(result)).toContain("Incompatible CI stream")
        const current = (await manager.streams.info("WORKFLOWD_CI_V1")).config
        expect(current).toMatchObject(mismatch)
      } finally {
        await admin.drain()
      }
    })
  },
  60000,
)
