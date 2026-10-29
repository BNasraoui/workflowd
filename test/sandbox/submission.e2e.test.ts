import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { makeSandboxStore } from "../../src/sandbox/store"
import { makePublishStore } from "../../src/sandbox/publish-store"
import { dirname, join } from "node:path"
import {
  readSandboxBinding,
  SandboxSessionBinding,
  writeSandboxBinding,
} from "../../src/sandbox/binding"
import { SandboxCompletion } from "../../src/sandbox/config"
import { bridgeClient, runnerFixture } from "./harness"
import { readSandboxSubmission } from "../../src/sandbox/submission"

test("completion requires bounded Unicode plain text without altering agent wording", () => {
  const decode = Schema.decodeUnknownSync(SandboxCompletion)
  const valid = {
    environmentId: "one",
    branch: "anything",
    title: "雪 'safe' `title`",
    commitMessage: "Fix result\n\n```text\n雪 'literal' `message`\n```\n",
    body: "## Result\n\nReadable agent description.",
  }
  expect(decode(valid)).toEqual(valid)
  expect(decode({ ...valid, title: "😀".repeat(200), commitMessage: "é".repeat(5120) }).title).toBe(
    "😀".repeat(200),
  )
  for (const fields of [
    { title: undefined },
    { commitMessage: undefined },
    { commitMessage: "Fix result\n\n```sh\n雪 '$() `message`\n```\n" },
    { title: "" },
    { commitMessage: "" },
    { title: "x".repeat(201) },
    { title: "two\nlines" },
    { title: "line\u2028separator" },
    { title: "bad\tcontrol" },
    { title: "hidden\u200bformat" },
    { commitMessage: "bidi\u202econtrol" },
    { commitMessage: "bad\rcontrol" },
    { commitMessage: "bad\u0085control" },
    { title: "\ud800" },
    { commitMessage: "\udfff" },
    { commitMessage: "é".repeat(5121) },
  ])
    expect(() => decode({ ...valid, ...fields })).toThrow()
})

test("submit_result validates, durably accepts once across bridges, and audits each attempt", async () => {
  const runner = await runnerFixture()
  const first = bridgeClient(runner.transport)
  const second = bridgeClient(runner.transport)
  const completion = {
    title: "Agent title",
    commitMessage: "Agent message\n\nDetails",
    body: "## Result\n\nReadable agent description.",
    environmentId: "one",
    branch: "agent choice '$()\n雪",
  }
  const file = join(dirname(runner.bindingFile), "submission.json")
  try {
    await first.initialize()
    const catalog = await first.request("tools/list")
    expect(JSON.stringify(catalog)).toContain('"name":"submit_result"')
    for (const args of [
      ...[
        null,
        "<!-- hidden -->",
        "@org/team",
        "Closes #1",
        "bad\tcontrol",
        "bad\u200dtext",
        "\ud800",
        "é".repeat(16385),
      ].map((body) => ({ ...completion, body })),
      {},
      { branch: "choice" },
      { ...completion, environmentId: "" },
      { ...completion, branch: 7 },
      { ...completion, title: "hidden\u200bformat" },
      { ...completion, commitMessage: "bidi\u202econtrol" },
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
      arguments: { ...completion, environmentId: "two", branch: "" },
    })
    expect(duplicate).toMatchObject({ isError: true })
    expect(JSON.stringify(duplicate)).toContain("already submitted")
    expect(await Bun.file(file).json()).toEqual(accepted)
    const audit = await runner.holdLog()
    const lines = audit.split("\n").filter((line) => line.startsWith("workflowd.audit "))
    expect(lines).toHaveLength(17)
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
          arguments: {
            environmentId: String(index),
            branch: "",
            title: "Concurrent result",
            commitMessage: "Publish result",
            body: "## Result\n\nReadable agent description.",
          },
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

test("submit_result rejects taken and pending names, then accepts the agent's other name", async () => {
  const runner = await runnerFixture()
  const client = bridgeClient(runner.transport)
  const completion = {
    environmentId: "one",
    branch: "taken/雪'$()",
    title: "Agent title",
    commitMessage: "Agent message",
    body: "## Result\n\nReadable agent description.",
  }
  const file = Bun.file(join(dirname(runner.bindingFile), "submission.json"))
  try {
    runner.branchResponses.set(completion.branch, 200)
    runner.branchResponses.set("unavailable", 503)
    await Effect.runPromise(
      Effect.gen(function* () {
        const leases = yield* makeSandboxStore
        yield* leases.request({
          runId: "pending",
          leaseId: "pending",
          sourceSha: "a".repeat(40),
          now: Date.now(),
          policy: {
            alias: "fixture",
            repository: "fixture/repo",
            repositoryId: 1,
            installationId: 1,
            workflowSha: "a".repeat(40),
            appActorId: 1,
            agentImage: "ghcr.io/bnasraoui/workflowd-agent-base@sha256:" + "f".repeat(64),
            tailscaleClientId: "fixture",
            tailscaleAudience: "fixture",
          },
        })
        const publications = yield* makePublishStore
        yield* publications.seal({
          runId: "pending",
          actionsRunId: 41,
          attempt: 1,
          baseRef: "main",
          deadline: Date.now() + 60000,
          metadata: {
            ...completion,
            branch: "pending/雪'$()",
            sourceSha: "a".repeat(40),
            resultSha: "b".repeat(40),
            treeSha: "c".repeat(40),
            bundleSha256: "d".repeat(64),
            manifestSha256: "e".repeat(64),
          },
        })
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: runner.submissionCheck.databasePath })),
      ),
    )
    await client.initialize()
    await client.request("tools/list")
    for (const branch of [completion.branch, "pending/雪'$()"]) {
      const result = await client.request("tools/call", {
        name: "submit_result",
        arguments: { ...completion, branch },
      })
      expect(result).toMatchObject({ isError: true })
      expect(JSON.stringify(result)).toContain("choose another")
      expect(await file.exists()).toBe(false)
    }
    expect(runner.submissionRequests).toContain(completion.branch)
    const unavailable = await client.request("tools/call", {
      name: "submit_result",
      arguments: { ...completion, branch: "unavailable" },
    })
    expect(unavailable).toMatchObject({ isError: true })
    expect(JSON.stringify(unavailable)).toContain("Could not verify branch availability")
    expect(await file.exists()).toBe(false)
    const available = { ...completion, branch: "another/雪'$()" }
    expect(
      await client.request("tools/call", { name: "submit_result", arguments: available }),
    ).toMatchObject({ isError: false })
    expect(
      (await Bun.file(join(dirname(runner.bindingFile), "submission.json")).json()).completion,
    ).toEqual(available)
  } finally {
    await client.close()
    await runner.close()
  }
}, 120000)
