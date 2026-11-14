import { expect, test } from "bun:test"
import { Session } from "@opencode-ai/client/effect"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { runnerFixture } from "./harness"
import { sharedOpenCodeFixture } from "./opencode-fixture"
import { makeSandboxOpenCode } from "../../src/sandbox/opencode"
import { sendToolAudit } from "../../src/sandbox/audit"
import {
  bindingDirectory,
  sandboxBridgeName,
  sandboxPolicyHash,
  transportHash,
  writeSandboxBinding,
} from "../../src/sandbox/binding"

test("OpenCode keeps its bridge after a parallel Code Mode error cancels a running tool", async () => {
  const runner = await runnerFixture()
  const fixture = await sharedOpenCodeFixture("bridge-cancellation")
  const executor = makeSandboxOpenCode(fixture.client, fixture.executor)
  const directory = join(fixture.root, "owned")
  const binding = {
    runId: runner.name,
    leaseId: runner.transport.leaseId,
    sessionId: Session.ID.create(),
    executorId: "opencode:fixture",
    endpointIdentity: fixture.url,
    directory,
    locationIdentity: await Effect.runPromise(executor.reserve(directory)),
    bridgeServerName: sandboxBridgeName(runner.transport.leaseId),
    repositoryId: 1,
    sourceSha: "b".repeat(40),
    policyHash: sandboxPolicyHash,
    transportHash: transportHash(runner.transport),
    deadline: Date.now() + 120000,
    state: "reserved" as const,
  }
  try {
    await writeSandboxBinding(binding, true)
    const active = await Effect.runPromise(
      executor.start(binding, runner.transport, {
        providerID: "openai",
        modelID: "gpt-6-astra-fixture",
      }),
    )
    fixture.script([
      {
        name: "execute",
        arguments: JSON.stringify({
          code: `return await Promise.all([
            tools.${binding.bridgeServerName}.environment_create({
              environment_source: "/workspace/repository", title: "Cancellation regression"
            }),
            tools.opencode.search({query: "read file contents from environment"})
          ])`,
        }),
      },
    ])
    expect(
      JSON.stringify(await fixture.prompt(binding.sessionId, "Run the parallel calls")),
    ).toContain("Unknown tool 'opencode.search'")
    fixture.script([
      {
        name: "execute",
        arguments: JSON.stringify({
          code: `return await tools.${binding.bridgeServerName}.environment_list({environment_source:"/workspace/repository"})`,
        }),
      },
    ])
    const next = await fixture.prompt(binding.sessionId, "Check the completed environment")
    expect(JSON.stringify(next)).toContain(
      `"tool":"${binding.bridgeServerName}.environment_list","status":"completed"`,
    )
    await Effect.runPromise(executor.check(active))
    const lines = (await runner.holdLog()).trimEnd().split("\n")
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line.startsWith("workflowd.audit ")).toBe(true)
    expect(lines.map((line): unknown => JSON.parse(line.slice("workflowd.audit ".length)))).toEqual(
      [
        { sequence: 1, outcome: "ok" },
        { sequence: 2, outcome: "ok" },
      ],
    )
    const records: unknown[] = await Promise.all(
      [1, 2].map((sequence) =>
        Bun.file(join(bindingDirectory(directory), "audit", `${sequence}.json`)).json(),
      ),
    )
    // The pinned MCP client starts at 0: initialize, tools/list, then these calls.
    expect(records).toEqual(
      ["environment_create", "environment_list"].map((tool, index) => ({
        runId: binding.runId,
        leaseId: binding.leaseId,
        sequence: index + 1,
        callId: createHash("sha256")
          .update(String(index + 2))
          .digest("hex"),
        tool,
        command: null,
        commandSha256: null,
        exitCode: null,
        outcome: "ok",
        complete: true,
      })),
    )
    const delivered: unknown = JSON.parse(
      await runner.docker(
        "exec",
        `${runner.name}-runner`,
        "cat",
        "/run/workflowd-sandbox/audit.json",
      ),
    )
    expect(delivered).toEqual({
      records: Object.fromEntries(records.map((record, index) => [String(index + 1), record])),
      emittedThrough: 2,
    })
    expect(await sendToolAudit(runner.transport, [])).toEqual({ emittedThrough: 2 })
  } finally {
    await Effect.runPromise(executor.stop(binding))
    await fixture.close()
    await runner.close()
  }
}, 120000)
