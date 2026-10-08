import { expect, test } from "bun:test"
import { Schema } from "effect"
import { dirname, join } from "node:path"
import {
  readSandboxBinding,
  SandboxSessionBinding,
  writeSandboxBinding,
} from "../../src/sandbox/binding"
import { SandboxCompletion } from "../../src/sandbox/config"
import { bridgeClient, runnerFixture } from "./harness"
import { readSandboxSubmission } from "../../src/sandbox/submission"

test("submit_result validates, durably accepts once across bridges, and audits each attempt", async () => {
  const runner = await runnerFixture()
  const first = bridgeClient(runner.transport)
  const second = bridgeClient(runner.transport)
  const completion = { environmentId: "one", branch: "agent choice '$()\n雪" }
  const file = join(dirname(runner.bindingFile), "submission.json")
  try {
    await first.initialize()
    const catalog = await first.request("tools/list")
    expect(JSON.stringify(catalog)).toContain('"name":"submit_result"')
    for (const args of [
      {},
      { branch: "choice" },
      { ...completion, environmentId: "" },
      { ...completion, branch: 7 },
      { ...completion, environment_source: "/workspace/repository" },
    ]) {
      expect(
        await first.request("tools/call", { name: "submit_result", arguments: args }),
      ).toMatchObject({ isError: true })
      expect(await Bun.file(file).exists()).toBe(false)
    }
    expect(
      await first.request("tools/call", { name: "submit_result", arguments: completion }),
    ).toMatchObject({ isError: false })
    const accepted = await Bun.file(file).json()
    expect(accepted.completion).toEqual(completion)
    expect(accepted.binding.runId).toBe(runner.name)
    await first.close()
    await second.initialize()
    await second.request("tools/list")
    const duplicate = await second.request("tools/call", {
      name: "submit_result",
      arguments: { environmentId: "two", branch: "" },
    })
    expect(duplicate).toMatchObject({ isError: true })
    expect(JSON.stringify(duplicate)).toContain("already submitted")
    expect(await Bun.file(file).json()).toEqual(accepted)
    const audit = await runner.holdLog()
    const lines = audit.split("\n").filter((line) => line.startsWith("workflowd.audit "))
    expect(lines).toHaveLength(7)
    expect(lines.every((line) => line.includes('"tool":"submit_result"'))).toBe(true)
    expect(lines.filter((line) => line.includes('"outcome":"ok"'))).toHaveLength(1)
  } finally {
    await first.close()
    await second.close()
    await runner.close()
  }
}, 120000)

test("concurrent bridges cannot replace a submission and settlement verifies its binding", async () => {
  const runner = await runnerFixture()
  const clients = [bridgeClient(runner.transport), bridgeClient(runner.transport)]
  const directory = join(runner.root, "bridge-session")
  const file = Bun.file(join(dirname(runner.bindingFile), "submission.json"))
  try {
    await Promise.all(
      clients.map(async (client) => {
        await client.initialize()
        await client.request("tools/list")
      }),
    )
    const results = await Promise.all(
      clients.map((client, index) =>
        client.request("tools/call", {
          name: "submit_result",
          arguments: { environmentId: String(index), branch: "" },
        }),
      ),
    )
    expect(
      results.filter((result) => JSON.stringify(result).includes('"isError":false')),
    ).toHaveLength(1)
    const saved = Schema.decodeUnknownSync(
      Schema.Struct({ binding: SandboxSessionBinding, completion: SandboxCompletion }),
    )(await file.json())
    const binding = await readSandboxBinding(directory)
    await writeSandboxBinding({ ...binding, state: "revoked" })
    expect(
      await readSandboxSubmission(directory, binding.runId, binding.leaseId, binding.sessionId),
    ).toEqual(saved.completion)
    await expect(
      readSandboxSubmission(directory, "foreign", binding.leaseId, binding.sessionId),
    ).rejects.toThrow("binding mismatch")
    await expect(
      readSandboxSubmission(directory, binding.runId, "foreign", binding.sessionId),
    ).rejects.toThrow("binding mismatch")
    await expect(
      readSandboxSubmission(directory, binding.runId, binding.leaseId, "foreign"),
    ).rejects.toThrow("binding mismatch")
    await Bun.write(
      file,
      JSON.stringify({ ...saved, binding: { ...saved.binding, sourceSha: "b".repeat(40) } }),
    )
    await expect(
      readSandboxSubmission(directory, binding.runId, binding.leaseId, binding.sessionId),
    ).rejects.toThrow("binding mismatch")
  } finally {
    await Promise.all(clients.map((client) => client.close()))
    await runner.close()
  }
}, 120000)

test("submit_result is refused for a revoked binding", async () => {
  const runner = await runnerFixture()
  const directory = join(runner.root, "bridge-session")
  try {
    const binding = await readSandboxBinding(directory)
    await writeSandboxBinding({ ...binding, state: "revoked" })
    const client = bridgeClient(runner.transport)
    try {
      expect((await client.settled)?.message).toContain("revoked")
      expect(await Bun.file(join(dirname(runner.bindingFile), "submission.json")).exists()).toBe(
        false,
      )
    } finally {
      await client.close()
    }
  } finally {
    await runner.close()
  }
}, 120000)
