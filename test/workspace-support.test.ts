import { expect, test } from "bun:test"
import { join } from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { runWorkspaceCommandBytes } from "../src/workspace/command"
import { LocalRepositoryCatalog } from "../src/workspace/discovery"
import { ScopedKeyedLock } from "../src/workspace/locks"

test("bounded command output drains stdout while retaining only the configured bytes", async () => {
  const maxStdoutBytes = 4_096
  const result = await Effect.runPromise(
    runWorkspaceCommandBytes(
      "generate large output",
      ["bash", "-c", "dd if=/dev/zero bs=1048576 count=8 2>/dev/null; printf drained >&2"],
      { maxStdoutBytes },
    ),
  )

  expect(result.truncated).toBe(true)
  expect(result.stdout.byteLength).toBe(maxStdoutBytes)
  expect(result.stdout.buffer.byteLength).toBe(maxStdoutBytes)
})

test("an interrupted keyed-lock waiter does not release the holder or retain the key", async () => {
  const locks = new ScopedKeyedLock()
  const holderEntered = Effect.runSync(Deferred.make<void>())
  const releaseHolder = Effect.runSync(Deferred.make<void>())
  const holder = Effect.runFork(
    Effect.scoped(
      locks.acquire("worktree").pipe(
        Effect.tap(() => Deferred.succeed(holderEntered, undefined)),
        Effect.zipRight(Deferred.await(releaseHolder)),
      ),
    ),
  )
  await Effect.runPromise(Deferred.await(holderEntered))
  const waiter = Effect.runFork(Effect.scoped(locks.acquire("worktree")))
  await Effect.runPromise(
    Effect.gen(function* () {
      while ((yield* Fiber.status(waiter))._tag !== "Suspended") {
        yield* Effect.yieldNow()
      }
    }),
  )

  await Effect.runPromise(Fiber.interrupt(waiter))
  const contenderEntered = Effect.runSync(Deferred.make<void>())
  const contender = Effect.runFork(
    Effect.scoped(
      locks
        .acquire("worktree")
        .pipe(Effect.tap(() => Deferred.succeed(contenderEntered, undefined))),
    ),
  )
  await Effect.runPromise(Effect.yieldNow())
  expect(await Effect.runPromise(Deferred.isDone(contenderEntered))).toBe(false)
  await Effect.runPromise(Deferred.succeed(releaseHolder, undefined))
  await Effect.runPromise(Fiber.join(holder))
  await Effect.runPromise(Deferred.await(contenderEntered))
  await Effect.runPromise(Fiber.join(contender))
})

test("the local repository catalog reuses scans while its snapshot is fresh", async () => {
  let now = 1_000
  let scans = 0
  const io = {
    now: () => now,
    modifiedAt: async () => 10,
    readSubdirectories: async () => {
      scans += 1
      return ["one", "two"]
    },
  }
  const catalog = new LocalRepositoryCatalog(["/repositories"], {
    ttlMs: 500,
    io,
  })

  expect(await catalog.candidates()).toEqual([
    "/repositories",
    join("/repositories", "one"),
    join("/repositories", "two"),
  ])
  expect(await catalog.candidates()).toHaveLength(3)
  now += 499
  expect(await catalog.candidates()).toHaveLength(3)

  expect(scans).toBe(1)
})

test("the local repository catalog refreshes a changed root after a cache miss", async () => {
  let modifiedAt = 10
  let entries: ReadonlyArray<string> = []
  const io = {
    now: () => 1_000,
    modifiedAt: async () => modifiedAt,
    readSubdirectories: async () => entries,
  }
  const catalog = new LocalRepositoryCatalog(["/repositories"], {
    ttlMs: 60_000,
    io,
  })
  expect(await catalog.candidates()).toEqual(["/repositories"])

  entries = ["appeared-later"]
  modifiedAt += 1

  expect(await catalog.refreshChanged()).toContain(join("/repositories", "appeared-later"))
})

test("the local repository catalog revalidates an expired snapshot", async () => {
  let now = 1_000
  let modifiedAt = 10
  let entries: ReadonlyArray<string> = ["one"]
  let scans = 0
  const io = {
    now: () => now,
    modifiedAt: async () => modifiedAt,
    readSubdirectories: async () => {
      scans += 1
      return entries
    },
  }
  const catalog = new LocalRepositoryCatalog(["/repositories"], {
    ttlMs: 500,
    io,
  })
  await catalog.candidates()

  now += 500
  modifiedAt += 1
  entries = ["one", "two"]

  expect(await catalog.candidates()).toContain(join("/repositories", "two"))
  expect(scans).toBe(2)
})
