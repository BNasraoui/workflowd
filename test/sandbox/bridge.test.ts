import { expect, spyOn, test } from "bun:test"
import { Schema } from "effect"
import * as crypto from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bindingDirectory,
  sandboxPolicyHash,
  transportHash,
  writeSandboxBinding,
} from "../../src/sandbox/binding"
import { sandboxCompletionInstructions } from "../../src/sandbox/config"
import * as transportModule from "../../src/sandbox/transport"
import { bridgeClient } from "./harness"

const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))
const catalog = [{ name: "environment_list" }]

async function fixture(tools = catalog) {
  const root = await mkdtemp(join(tmpdir(), "sandbox-bridge-"))
  const directory = join(root, "session")
  const transport: transportModule.SandboxTransport = {
    leaseId: "fixture-lease",
    peerId: "fixture-peer",
    repositoryPath: "/workspace/repository",
    address: "127.0.0.1",
    port: 2222,
    knownHostsFile: join(root, "known_hosts"),
    identityFile: join(root, "key"),
  }
  await mkdir(directory)
  await writeSandboxBinding(
    {
      runId: "fixture-run",
      leaseId: transport.leaseId,
      sessionId: "ses_fixture",
      executorId: "fixture",
      endpointIdentity: "fixture",
      directory,
      locationIdentity: "fixture",
      bridgeServerName: "wfdlease_fixture",
      repositoryId: 1,
      sourceSha: "a".repeat(40),
      policyHash: sandboxPolicyHash,
      transportHash: transportHash(transport),
      deadline: Date.now() + 60000,
      state: "active",
    },
    true,
  )
  const peer = join(root, "peer.js")
  await writeFile(
    peer,
    `import { appendFile } from "node:fs/promises"
import { createInterface } from "node:readline"
const root = process.argv[2]
if (process.argv[3].endsWith(" audit")) {
  const records = JSON.parse(await Bun.stdin.text())
  await appendFile(root + "/delivered.jsonl", records.map(record => JSON.stringify(record) + "\\n").join(""))
  console.log(JSON.stringify({ emittedThrough: records.at(-1).sequence }))
} else {
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line)
    await appendFile(root + "/forwarded.jsonl", line + "\\n")
    if (frame.id === undefined) continue
    const result = frame.method === "tools/list"
      ? { tools: ${JSON.stringify(tools)} }
      : frame.method === "tools/call"
        ? { content: [{ type: "text", text: "valid call completed" }] }
        : {}
    console.log(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }))
  }
}
`,
  )
  const ssh = spyOn(transportModule, "sandboxSshArguments").mockReturnValue([
    process.execPath,
    peer,
    root,
    "bridge",
  ])
  // Accept only this fixture catalog in place of the pinned container-use manifest.
  // Binding and audit hashes still use the real implementation.
  const createHash = crypto.createHash
  const hashing = spyOn(crypto, "createHash").mockImplementation((algorithm, options) => {
    const hash = createHash(algorithm, options)
    const update = hash.update.bind(hash)
    spyOn(hash, "update").mockImplementation((data, encoding) => {
      if (data === JSON.stringify(catalog))
        spyOn(hash, "digest").mockReturnValue(
          "64d460e7eb2964c9995b03c3aa16ffcad89d4067fe6a903656843a651d5b1fdf",
        )
      return typeof data === "string" ? update(data, encoding) : update(data)
    })
    return hash
  })
  const bindingFile = join(bindingDirectory(directory), "binding.json")
  const client = bridgeClient(transport, bindingFile)
  return {
    root,
    directory,
    client,
    close: async () => {
      await client.close()
      hashing.mockRestore()
      ssh.mockRestore()
      await rm(root, { recursive: true, force: true })
    },
  }
}

for (const [reason, call] of [
  [
    "a foreign environment_source",
    { name: "environment_list", arguments: { environment_source: "/local/worktree" } },
  ],
  [
    "a disallowed tool",
    { name: "foreign_tool", arguments: { environment_source: "/workspace/repository" } },
  ],
] as const) {
  test(`bridge rejects ${reason} without forwarding it and serves the next call`, async () => {
    const runner = await fixture()
    try {
      await runner.client.initialize()
      await runner.client.request("tools/list")
      const result = await runner.client.request("tools/call", call)
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("/workspace/repository") }],
      })
      expect(
        await runner.client.request("tools/call", {
          name: "environment_list",
          arguments: { environment_source: "/workspace/repository" },
        }),
      ).toEqual({ content: [{ type: "text", text: "valid call completed" }] })
      const forwarded = (await Bun.file(join(runner.root, "forwarded.jsonl")).text())
        .trim()
        .split("\n")
        .map((line) => decodeRecord(JSON.parse(line)))
      expect(forwarded.filter((frame) => frame.method === "tools/call")).toEqual([
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "environment_list",
            arguments: { environment_source: "/workspace/repository" },
          },
        },
      ])
      const records = (await Bun.file(join(runner.root, "delivered.jsonl")).text())
        .trim()
        .split("\n")
        .map((line) => decodeRecord(JSON.parse(line)))
      expect(records).toMatchObject([
        { sequence: 1, tool: call.name, outcome: "error", complete: true, exitCode: null },
        { sequence: 2, tool: "environment_list", outcome: "ok", complete: true },
      ])
      expect(
        await Bun.file(join(bindingDirectory(runner.directory), "audit", "1.json")).json(),
      ).toEqual(records[0])
    } finally {
      await runner.close()
    }
  })
}

test("sandbox instructions specify the repository for every container-use call", () => {
  expect(sandboxCompletionInstructions).toContain(
    'Every container-use call must pass environment_source "/workspace/repository".',
  )
})

for (const frame of [
  { jsonrpc: "2.0", method: "tools/list" },
  { jsonrpc: "2.0", id: 9, method: "tools/call", result: {} },
]) {
  test("unexpected client frames still terminate the bridge", async () => {
    const runner = await fixture()
    try {
      await runner.client.initialize()
      await runner.client.raw(JSON.stringify(frame) + "\n")
      expect((await runner.client.settled)?.message).toBe("Unexpected sandbox client frame")
    } finally {
      await runner.close()
    }
  })
}

test("a tool manifest mismatch still terminates the bridge", async () => {
  const runner = await fixture([])
  try {
    await runner.client.initialize()
    await expect(runner.client.request("tools/list")).rejects.toThrow(
      "Sandbox tool manifest differs from pinned container-use",
    )
  } finally {
    await runner.close()
  }
})
