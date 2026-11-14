import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Script } from "node:vm"
import ts from "typescript"

// Execute the actual script body. Only imported fixture/I/O boundaries are supplied
// here; its join, resource assignments, failure propagation and finally are intact.
const source = await readFile("scripts/evidence/legacy-audit-startup.mjs", "utf8")
const parsed = ts.createSourceFile(
  "startup.mjs",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
)
const body = parsed.statements
  .filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getText(parsed))
  .join("\n")
const script = new Script(`(async () => { ${body} })()`)

for (const failing of ["runner", "opencode"] as const) {
  test(`audit startup joins and closes a late success after ${failing} fails`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "audit-startup-control-"))
    const socket = join(directory, "resource.sock")
    const ready = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const failure = new Error(`${failing} startup failed`)
    let child: ReturnType<typeof Bun.spawn> | undefined
    let closes = 0
    let dispatches = 0
    let preflight = false
    let settled = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const close = async () => {
      closes++
      child?.kill("SIGTERM")
      await child?.exited
      await rm(socket, { force: true })
    }
    const start = async (name: string) => {
      assert.ok(preflight, "both fixtures require the completed pre-launch checks")
      if (name === failing) {
        await ready.promise
        failed.resolve()
        throw failure
      }
      const running = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const server = Bun.serve({ unix: process.argv[1], fetch: () => new Response("owned") });
         process.once("SIGTERM", async () => { await server.stop(true); process.exit(0) });
         setTimeout(() => process.exit(97), 4000);
         console.log("ready");`,
          socket,
        ],
        {
          env: { PATH: "/usr/bin:/bin", HOME: directory },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      child = running
      const reader = running.stdout.getReader()
      const first = await reader.read()
      reader.releaseLock()
      assert.equal(new TextDecoder().decode(first.value), "ready\n")
      ready.resolve()
      await release.promise
      return { close }
    }
    const outcome = Promise.resolve(
      script.runInNewContext({
        assert,
        join,
        command: async () => "{}",
        Bun: {
          write: async (path: string) => {
            assert.equal(path, "/evidence/legacy-audit-libraries.json")
            preflight = true
          },
        },
        dispatchRunnerFixture: () => start("runner"),
        sharedOpenCodeFixture: () => start("opencode"),
        sandboxGithubFixture: () => {
          dispatches++
          throw new Error("dispatch before successful join")
        },
      }),
    ).then(
      () => {
        settled = true
        return { error: undefined }
      },
      (error: unknown) => {
        settled = true
        return { error }
      },
    )
    try {
      await Promise.race([
        failed.promise,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("independent startup did not overlap")),
            1000,
          )
        }),
      ])
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(closes).toBe(0)
      expect(await (await fetch("http://localhost/", { unix: socket })).text()).toBe("owned")
      release.resolve()
      expect((await outcome).error).toBe(failure)
      expect(dispatches).toBe(0)
      expect(closes).toBe(1)
      expect(child?.exitCode).toBe(0)
      expect(existsSync(socket)).toBe(false)
      expect(() => process.kill(child!.pid, 0)).toThrow()
    } finally {
      clearTimeout(watchdog)
      ready.resolve()
      release.resolve()
      await outcome
      if (child?.exitCode === null) await close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 5000)
}
