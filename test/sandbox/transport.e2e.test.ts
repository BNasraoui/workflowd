import { expect, test } from "bun:test"
import { sandboxSshArguments, type SandboxTransport } from "../../src/sandbox/transport"
import { join } from "node:path"
import { hostname } from "node:os"
import { bridgeClient, runnerFixture } from "./harness"
import { Schema } from "effect"
import { writeFile } from "node:fs/promises"

const transport: SandboxTransport = {
  leaseId: "fixture-lease",
  peerId: "fixture-peer",
  repositoryPath: "/workspace/repository",
  address: "127.0.0.1",
  port: 2222,
  knownHostsFile: "/tmp/fixture/known_hosts",
  identityFile: "/tmp/fixture/key",
}

test("SSH binds the pinned host key without forwarding or ambient configuration", () => {
  const args = sandboxSshArguments(transport)
  expect(args).toContain("StrictHostKeyChecking=yes")
  expect(args).toContain("ForwardAgent=no")
  expect(args).toContain("ClearAllForwardings=yes")
  expect(args).toContain("BatchMode=yes")
  expect(args.slice(-2)).toEqual(["runner@127.0.0.1", "exec /usr/local/bin/container-use stdio"])
})

test("SSH rejects an address that could introduce remote command arguments", () => {
  expect(() => sandboxSshArguments({ ...transport, address: "peer -oProxyCommand=bad" })).toThrow()
})

test("tooling and the SSH fixture run without root defaults", async () => {
  const runner = await runnerFixture()
  try {
    const toolingUid = await runner.docker(
      "run",
      "--rm",
      "--memory=64m",
      "--memory-swap=64m",
      "workflowd-sandbox-tooling:fixture",
      "id",
      "-u",
    )
    expect(Number(toolingUid)).toBeGreaterThan(0)
    const daemon = await runner.docker("exec", `${runner.name}-runner`, "cat", "/proc/1/status")
    const ids = daemon.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m)
    expect(ids).not.toBeNull()
    expect(ids?.slice(1).every((id) => Number(id) > 0)).toBe(true)
  } finally {
    await runner.close()
  }
}, 120_000)

test("container-use creates, executes and commits entirely through runner SSH", async () => {
  const runner = await runnerFixture()
  const client = bridgeClient(runner.transport)
  try {
    await client.initialize()
    const catalog = Schema.decodeUnknownSync(
      Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
    )(await client.request("tools/list"))
    expect(catalog.tools.some((tool) => tool.name === "environment_create")).toBe(true)
    const created = Schema.decodeUnknownSync(
      Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
    )(
      await client.request("tools/call", {
        name: "environment_create",
        arguments: {
          environment_source: "/workspace/repository",
          title: "Remote fixture task",
        },
      }),
    )
    const value: unknown = JSON.parse(created.content[0]?.text ?? "null")
    const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(value)
    const result = await client.request("tools/call", {
      name: "environment_run_cmd",
      arguments: {
        environment_source: "/workspace/repository",
        environment_id: id,
        command: "hostname; pwd; printf remote-only > sandbox.txt; cat sandbox.txt",
      },
    })
    expect(JSON.stringify(result)).toContain("/workdir")
    expect(JSON.stringify(result)).toContain("remote-only")
    expect(JSON.stringify(result)).not.toContain(hostname())
    const refs = await runner.docker(
      "exec",
      "-u",
      "runner",
      `${runner.name}-runner`,
      "git",
      "-C",
      "/workspace/repository",
      "for-each-ref",
      "--format=%(refname)",
    )
    expect(refs).toContain(`container-use/${id}`)
    expect(await Bun.file(join(runner.root, "sandbox.txt")).exists()).toBe(false)
  } finally {
    await client.close()
    await runner.close()
  }
}, 300_000)

test("bridge refuses malformed frames, foreign repositories, and an unpinned SSH host", async () => {
  const runner = await runnerFixture()
  try {
    const invalidFrames = [
      '{"jsonrpc":"2.0","method":"tools/list"}\n',
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
      '{"jsonrpc":"2.0","id":1,"method":"resources/read"}\n',
      "x".repeat(1024 * 1024 + 1) + "\n",
      "x".repeat(1024 * 1024 + 1),
    ]
    for (const frame of invalidFrames) {
      const client = bridgeClient(runner.transport)
      try {
        await client.raw(frame)
        expect(await client.settled).toBeInstanceOf(Error)
      } finally {
        await client.close()
      }
    }
    const incomplete = bridgeClient(runner.transport)
    await incomplete.raw('{"jsonrpc":')
    await incomplete.close()
    expect((await incomplete.settled)?.message).toContain("Incomplete")

    const duplicate = bridgeClient(runner.transport)
    try {
      await duplicate.initialize()
      await expect(duplicate.request("initialize")).rejects.toThrow("already initialized")
    } finally {
      await duplicate.close()
    }
    const foreign = bridgeClient(runner.transport)
    try {
      await foreign.initialize()
      await foreign.request("tools/list")
      await expect(
        foreign.request("tools/call", {
          name: "environment_create",
          arguments: {
            environment_source: "/another/repository",
            title: "rejected",
          },
        }),
      ).rejects.toThrow("repository is not allowed")
    } finally {
      await foreign.close()
    }
    const wrongKey = await Bun.file(join(runner.root, "key.pub")).text()
    await writeFile(
      runner.transport.knownHostsFile,
      `[127.0.0.1]:${runner.transport.port} ${wrongKey}`,
    )
    const impostor = bridgeClient(runner.transport)
    try {
      await expect(impostor.initialize()).rejects.toThrow()
    } finally {
      await impostor.close()
    }
  } finally {
    await runner.close()
  }
}, 120_000)
