import { expect, test } from "bun:test"
import { Session } from "@opencode-ai/client/effect"
import { Effect } from "effect"
import { join } from "node:path"
import { runnerFixture } from "./harness"
import { sharedOpenCodeFixture } from "./opencode-fixture"
import { makeSandboxOpenCode } from "../../src/sandbox/opencode"
import {
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
    const records = (await runner.holdLog())
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line.slice("workflowd.audit ".length)))
    expect(records).toMatchObject([
      { sequence: 1, tool: "environment_create", outcome: "ok", complete: true },
      { sequence: 2, tool: "environment_list", outcome: "ok", complete: true },
    ])
  } finally {
    await Effect.runPromise(executor.stop(binding))
    await fixture.close()
    await runner.close()
  }
}, 120000)
