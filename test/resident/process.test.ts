import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startAppServer } from "../../src/resident/process"
test("owns a stdio server and closes only its subprocess", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workflowd-resident-test-"))
  const binary = join(directory, "codex")
  await writeFile(
    binary,
    '#!/usr/bin/env bun\nimport { createInterface } from "node:readline"; for await (const line of createInterface({input:process.stdin})) { const frame=JSON.parse(line); if(frame.id !== undefined) console.log(JSON.stringify({id:frame.id,result:{ok:true,args:process.argv.slice(2)}})); }\n',
    { mode: 0o700 },
  )
  const server = startAppServer({ binary, home: directory }, () => {})
  try {
    await server.initialize()
    const result = await server.rpc.request("thread/list", {})
    expect(result).toMatchObject({
      ok: true,
      args: expect.arrayContaining([
        expect.stringContaining("mcp_servers.workflowd_subscriptions="),
      ]),
    })
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
