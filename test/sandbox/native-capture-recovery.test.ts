import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { captureNativeResult } from "../../deploy/sandbox/native-capture.mjs"
import { command } from "./harness"

// Real offline Git/archive/sealing, with only the stopped-container export port
// substituted. This does not execute the runner's image/network/engine operations.
for (const interrupted of [false, true]) {
  test(`native artifact custody recovers a lost response and retains interrupted capture: ${interrupted}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "native-capture-recovery-"))
    const directory = join(root, "native")
    const source = join(directory, "source.git")
    const workspace = join(root, "offline-workspace")
    const invocation = {
      nonce: "a".repeat(64),
      session: "11111111-1111-4111-8111-111111111111",
      state: "stopped",
      outcome: "completed",
    }
    const request = {
      nonce: invocation.nonce,
      session: invocation.session,
      completion: {
        branch: "free/agent-choice",
        title: "Native result",
        body: "Public work",
        commitMessage: "Native change",
      },
    }
    let exports = 0
    const backend = {
      async exportWorkspace() {
        exports++
        if (interrupted) throw new Error("Stopped export interrupted")
        await command(["tar", "-cf", join(directory, "capture.tar"), "-C", workspace, "."])
      },
    }
    const run = async (args: string[], input = "") => {
      const child = Bun.spawn(args, {
        cwd: directory,
        stdin: new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, output] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error("Sealing failed")
      return output.trim()
    }
    const capture = (candidate = request) =>
      captureNativeResult({
        root,
        directory,
        invocation,
        request: candidate,
        backend,
        command: run,
        tooling: resolve("deploy/sandbox"),
      })
    try {
      await mkdir(source, { recursive: true, mode: 0o700 })
      await mkdir(workspace)
      await command(["git", "init", "-b", "main"], source)
      await writeFile(join(source, "file.txt"), "source\n")
      await command(["git", "add", "."], source)
      await command(["git", "commit", "-m", "source"], source)
      await writeFile(join(root, "source.sha"), await command(["git", "rev-parse", "HEAD"], source))
      await writeFile(join(workspace, "file.txt"), "intended public result\n")
      await expect(capture({ ...request, nonce: "foreign" })).rejects.toThrow()
      expect(exports).toBe(0)
      if (interrupted) {
        await expect(capture()).rejects.toThrow()
        await expect(capture()).rejects.toThrow()
        expect(exports).toBe(1)
        expect(await Bun.file(join(root, "result/result.bundle")).exists()).toBe(false)
      } else {
        const first = await capture()
        const bundle = await readFile(join(root, "result/result.bundle"))
        expect(await capture()).toEqual(first)
        expect(exports).toBe(1)
        expect(await readFile(join(root, "result/result.bundle"))).toEqual(bundle)
        await expect(
          capture({
            ...request,
            completion: { ...request.completion, title: "Different candidate" },
          }),
        ).rejects.toThrow()
        await writeFile(join(root, "result/result.bundle"), "corrupted artifact")
        await expect(capture()).rejects.toThrow()
        expect(exports).toBe(1)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
