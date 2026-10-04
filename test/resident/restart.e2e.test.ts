import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { existsSync } from "node:fs"
import { Schema } from "effect"
import type { HostReady } from "./fixtures/resident-host"
import type { FakeThread } from "./fixtures/fake-codex-app-server"

const Ready = Schema.Struct({ port: Schema.Number })
const ResidentRow = Schema.Struct({
  run_id: Schema.String,
  state: Schema.String,
  current_turn: Schema.NullOr(Schema.String),
})
const RunRow = Schema.Struct({ state: Schema.String })
const Count = Schema.Struct({ n: Schema.Number })
const UnitRow = Schema.Struct({ unit: Schema.String, invocation: Schema.String })
const UnitState = Schema.Struct({
  pid: Schema.Number,
  invocation: Schema.String,
  description: Schema.String,
})
const ThreadHistory = Schema.Struct({
  turns: Schema.Array(Schema.Struct({ status: Schema.String })),
})

test.each(["survives", "unit-killed", "invocation-mismatch"])(
  "resident restart: %s",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "workflowd-resident-restart-"))
    const binary = join(import.meta.dir, "fixtures/fake-codex-app-server.ts")
    const fakeSystemd = join(import.meta.dir, "fixtures/fake-systemd")
    await chmod(binary, 0o755)
    await mkdir(join(root, "repo"))
    let host: ReturnType<typeof Bun.spawn> | undefined
    let db: Database | undefined
    const waitFor = async <T>(read: () => T | undefined, timeoutMs = 15000): Promise<T> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const value = read()
        if (value !== undefined) return value
        await Bun.sleep(25)
      }
      throw new Error("resident test timed out")
    }
    const start = async (index: number) => {
      await rm(join(root, "ready.json"), { force: true })
      host = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/resident-host.ts")], {
        env: {
          ...process.env,
          PATH: `${fakeSystemd}:${process.env.PATH}`,
          RESIDENT_FAKE_SYSTEMD_ROOT: join(root, "units"),
          RESIDENT_TEST_ROOT: root,
          RESIDENT_TEST_BINARY: binary,
        },
        stdout: Bun.file(join(root, `host-${index}.log`)),
        stderr: Bun.file(join(root, `host-${index}.stderr.log`)),
      })
      const ready = await waitFor(() => {
        if (host?.exitCode !== null) throw new Error(`host exited ${host?.exitCode}`)
        return existsSync(join(root, "ready.json"))
          ? Bun.file(join(root, "ready.json")).text()
          : undefined
      })
      const parsed: unknown = JSON.parse(await ready)
      const value: HostReady = Schema.decodeUnknownSync(Ready)(parsed)
      return value.port
    }
    try {
      const port = await start(1)
      db = new Database(join(root, "state.db"))
      void fetch(`http://127.0.0.1:${port}/dispatch`, { method: "POST" }).catch(() => undefined)
      await waitFor(() => {
        const raw = db!.query("SELECT run_id, state, current_turn FROM resident_threads").get()
        if (raw == null) return undefined
        const row = Schema.decodeUnknownSync(ResidentRow)(raw)
        return row.current_turn === `dispatch:${row.run_id}` ? row : undefined
      })
      await waitFor(() => {
        const run = Schema.decodeUnknownSync(RunRow)(
          db!.query("SELECT state FROM kernel_agent_runs").get(),
        )
        return run.state === "verified" ? run : undefined
      })
      const before = Schema.decodeUnknownSync(UnitRow)(
        db.query("SELECT unit, invocation FROM resident_servers").get(),
      )
      expect(before.invocation).toBeTruthy()
      const unitPath = join(root, "units", `${before.unit}.json`)
      const unitState = Schema.decodeUnknownSync(UnitState)(
        JSON.parse(await readFile(unitPath, "utf8")),
      )
      host!.kill("SIGINT")
      expect(await host!.exited).toBe(0)
      if (scenario === "unit-killed") process.kill(-unitState.pid, "SIGKILL")
      if (scenario === "invocation-mismatch")
        await writeFile(unitPath, JSON.stringify({ ...unitState, invocation: crypto.randomUUID() }))
      await start(2)
      if (scenario === "invocation-mismatch") {
        await waitFor(() => {
          const run = Schema.decodeUnknownSync(RunRow)(
            db!.query("SELECT state FROM kernel_agent_runs").get(),
          )
          return run.state === "operator_required" ? run : undefined
        })
        expect(db.query("SELECT state FROM resident_threads").get()).toMatchObject({
          state: "operator_required",
        })
        return
      }
      const after = Schema.decodeUnknownSync(UnitRow)(
        db.query("SELECT unit, invocation FROM resident_servers").get(),
      )
      expect(after.unit).toBe(before.unit)
      if (scenario === "survives") expect(after.invocation).toBe(before.invocation)
      else expect(after.invocation).not.toBe(before.invocation)
      const terminal = await waitFor(() => {
        const row = Schema.decodeUnknownSync(RunRow)(
          db!.query("SELECT state FROM kernel_agent_runs").get(),
        )
        return row.state === "completed" ? row : undefined
      })
      expect(terminal.state).toBe("completed")
      const parsed: unknown = JSON.parse(
        await readFile(join(root, "codex-home", "fixture-thread.json"), "utf8"),
      )
      const history: {
        readonly turns: ReadonlyArray<{ readonly status: FakeThread["turns"][number]["status"] }>
      } = Schema.decodeUnknownSync(ThreadHistory)(parsed)
      expect(history.turns.map((turn) => turn.status)).toEqual(
        scenario === "survives" ? ["completed"] : ["interrupted", "completed"],
      )
      expect(
        Schema.decodeUnknownSync(Count)(
          db.query("SELECT count(*) AS n FROM resident_inbox WHERE id LIKE 'restart:%'").get(),
        ).n,
      ).toBe(scenario === "survives" ? 0 : 1)
    } catch (error) {
      const logs = await Promise.all(
        [1, 2].map(async (i) =>
          readFile(join(root, `host-${i}.stderr.log`), "utf8").catch(() => ""),
        ),
      )
      const state = db?.query("SELECT * FROM resident_threads").all()
      const inbox = db?.query("SELECT * FROM resident_inbox").all()
      throw new Error(
        `${String(error)}\n${logs.join("\n")}\n${JSON.stringify({ state, inbox, root })}`,
        { cause: error },
      )
    } finally {
      if (host?.exitCode === null) {
        host.kill("SIGINT")
        await host.exited
      }
      const unitName = Schema.decodeUnknownSync(
        Schema.NullOr(Schema.Struct({ unit: Schema.String })),
      )(db?.query("SELECT unit FROM resident_servers").get() ?? null)?.unit
      db?.close()
      const units =
        unitName === undefined
          ? null
          : await readFile(join(root, "units", `${unitName}.json`), "utf8").then(
              JSON.parse,
              () => null,
            )
      if (units?.pid) {
        try {
          process.kill(-units.pid, "SIGKILL")
        } catch {
          /* already stopped */
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  },
  30000,
)
