import { expect, test } from "bun:test"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { disposableSsh } from "./fixtures/ssh.mjs"

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
