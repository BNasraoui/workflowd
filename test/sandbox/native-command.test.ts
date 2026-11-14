import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { nativeCommand } from "../../deploy/sandbox/native-command.mjs"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"

test("native setup commands bound private output and isolate the child environment", async () => {
  const node = fixtureExecutable("node")
  const options = { directory: tmpdir(), timeoutMs: 2000 }
  const output = await nativeCommand(
    [
      node,
      "-e",
      "process.stdin.on('data', b => process.stdout.write(b)); process.stderr.write('::error::private diagnostic')",
    ],
    "fixture result",
    options,
  )
  expect(output).toBe("fixture result")
  expect(
    JSON.parse(
      await nativeCommand([node, "-e", "console.log(JSON.stringify(process.env))"], "", options),
    ),
  ).toEqual({
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  })
  await expect(
    nativeCommand([node, "-e", "process.stdout.write('x'.repeat(262145))"], "", options),
  ).rejects.toThrow()
})

for (const ending of ["cancel", "timeout"] as const) {
  test(`native setup ${ending} joins the owned command and its descendants`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-command-"))
    const marker = join(root, "processes.json")
    const controller = new AbortController()
    const node = fixtureExecutable("node")
    const pending = nativeCommand(
      [
        node,
        "-e",
        `
      const {spawn}=require('node:child_process'),{writeFileSync}=require('node:fs');
      const child=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore'});
      writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]));
      setInterval(() => {}, 1000);
    `,
      ],
      "",
      { directory: root, timeoutMs: ending === "timeout" ? 250 : 2000, signal: controller.signal },
    ).then(
      () => false,
      () => true,
    )
    let pids: number[] = []
    try {
      const deadline = Date.now() + 1500
      while (!(await Bun.file(marker).exists()) && Date.now() < deadline) await Bun.sleep(5)
      pids = JSON.parse(await readFile(marker, "utf8"))
      if (ending === "cancel") controller.abort()
      expect(await Promise.race([pending, Bun.sleep(500).then(() => false)])).toBe(true)
      for (const pid of pids) {
        const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
        expect(state === "" || state.split(") ")[1]?.startsWith("Z ")).toBe(true)
      }
    } finally {
      const cleanupErrors = []
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL")
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
            cleanupErrors.push(error)
        }
      }
      await pending
      await rm(root, { recursive: true, force: true })
      expect(cleanupErrors).toEqual([])
    }
  })
}
