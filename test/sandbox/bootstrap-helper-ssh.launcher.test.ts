import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { readlink } from "node:fs/promises"
import { serveBootstrap } from "../../deploy/sandbox/bootstrap-helper.mjs"
import { exchangeJobProof } from "../../src/sandbox/bootstrap"
import { fixtureExecutable } from "../helpers/fixture-executable.mjs"
import { disposableSsh } from "./fixtures/ssh.mjs"

test("private bootstrap waits for asynchronous admission before ending its input", async () => {
  // A relative socket path keeps a deep checkout under the 107-byte sun_path bound,
  // which Node's connect otherwise fails without output.
  const ssh = await disposableSsh(
    (root) =>
      `cd ${root} && exec ${fixtureExecutable("node")} ${resolve("test/sandbox/fixtures/capability-job.mjs")} attach .`,
  )
  let activated = false
  const server = await serveBootstrap({
    directory: ssh.root,
    identity: { peerId: "fixture", agentImage: "fixture", workflowSha: "fixture" },
    issue: async () => "fixture-signed-token",
    activate: async () => {
      await Bun.sleep(50)
      activated = true
    },
    timeoutMs: 1000,
  })
  const completed = server.completed.then(
    () => "accepted",
    () => "refused",
  )
  try {
    await exchangeJobProof(
      [...ssh.args, "exec /usr/local/bin/runner-control bootstrap"],
      { audience: "workflowd:fixture", peerId: "fixture" },
      async (proof) => {
        expect(proof).toEqual({
          token: "fixture-signed-token",
          peerId: "fixture",
          agentImage: "fixture",
          workflowSha: "fixture",
        })
        expect(activated).toBe(false)
        return { mode: "remote-tools" }
      },
      AbortSignal.timeout(2000),
    )
    expect(await completed).toBe("accepted")
    expect(activated).toBe(true)
  } finally {
    server.close()
    await ssh.close()
  }
})

test("fixture namespace guard refuses missing, malformed and equal host namespace before SSH startup", async () => {
  const original = process.env.WORKFLOWD_FIXTURE_HOST_NETNS
  try {
    for (const value of [
      undefined,
      "net:[]",
      "net:[1]garbage",
      await readlink("/proc/self/ns/net"),
    ]) {
      if (value === undefined) delete process.env.WORKFLOWD_FIXTURE_HOST_NETNS
      else process.env.WORKFLOWD_FIXTURE_HOST_NETNS = value
      await expect(
        disposableSsh(() => {
          throw new Error("SSH configuration reached")
        }),
      ).rejects.toThrow("SSH fixture requires isolated netns")
    }
  } finally {
    if (original === undefined) delete process.env.WORKFLOWD_FIXTURE_HOST_NETNS
    else process.env.WORKFLOWD_FIXTURE_HOST_NETNS = original
  }
})
