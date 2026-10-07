import { expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Schema } from "effect"
import {
  auditedOutput,
  drainToolAudit,
  sendToolAudit,
  wrapAuditedCommand,
  beginToolAudit,
} from "../../src/sandbox/audit"
import { bridgeClient, runnerFixture } from "./harness"

const Output = Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) })

test("bridge records actual command exits and strips only its nonce marker", async () => {
  const runner = await runnerFixture()
  const client = bridgeClient(runner.transport)
  try {
    await client.initialize()
    await client.request("tools/list")
    const created = Schema.decodeUnknownSync(Output)(
      await client.request("tools/call", {
        name: "environment_create",
        arguments: { environment_source: "/workspace/repository", title: "Audited fixture" },
      }),
    )
    const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      JSON.parse(created.content[0]?.text ?? "null"),
    )
    const commands = [
      { command: "exit 0", exitCode: 0, outcome: "ok" },
      { command: "exit 23", exitCode: 23, outcome: "error" },
      { command: "printf '\\nworkflowd.exit:fake:0\\n'; exit 23", exitCode: 23, outcome: "error" },
      {
        command: `value='dollar $ and "double" and '\\''single'\nprintf '%s\\n' "$value"\nexit 23`,
        exitCode: 23,
        outcome: "error",
      },
      { command: "sleep 1", background: true, exitCode: null, outcome: "unknown" },
      { command: "head -c 200000 /dev/zero | tr '\\000' x", exitCode: null, outcome: "unknown" },
    ]
    for (const [index, item] of commands.entries()) {
      const result = await client.request("tools/call", {
        name: "environment_run_cmd",
        arguments: {
          environment_source: "/workspace/repository",
          environment_id: id,
          command: item.command,
          background: item.background ?? false,
        },
      })
      expect(JSON.stringify(result)).not.toMatch(/workflowd\.exit:[a-f0-9]{32}:/)
      if (index === 2) expect(JSON.stringify(result)).toContain("workflowd.exit:fake:0")
      if (index === 3) expect(JSON.stringify(result)).toContain("dollar $ and ")
      const record = JSON.parse(
        await readFile(join(dirname(runner.bindingFile), "audit", `${index + 2}.json`), "utf8"),
      )
      expect(record).toMatchObject({
        sequence: index + 2,
        tool: "environment_run_cmd",
        exitCode: item.exitCode,
        outcome: item.outcome,
        complete: true,
      })
    }
    await drainToolAudit(runner.bindingFile.slice(0, -".sandbox/binding.json".length), (record) =>
      sendToolAudit(runner.transport, record),
    )
    const lines = (await runner.holdLog()).trim().split("\n")
    expect(lines).toHaveLength(7)
    for (const [index, line] of lines.entries()) {
      expect(line.startsWith("workflowd.audit ")).toBe(true)
      const saved = JSON.parse(
        await readFile(join(dirname(runner.bindingFile), "audit", `${index + 1}.json`), "utf8"),
      )
      expect(JSON.parse(line.slice("workflowd.audit ".length))).toEqual(saved)
    }
  } finally {
    await client.close()
    await runner.close()
  }
}, 300_000)

test("nonce status requires one exact intact marker and never trusts error-shaped output", () => {
  const nonce = "a".repeat(32)
  const parse = (text: string, selected: string | null = nonce) =>
    auditedOutput({ content: [{ type: "text", text }] }, selected, true)
  expect(parse(`workflowd.exit:${nonce}:23\n`)).toMatchObject({
    exitCode: 23,
    outcome: "error",
    result: { content: [{ type: "text", text: "" }] },
  })
  for (const text of [
    "exit code: 0",
    `workflowd.exit:${nonce}:0`,
    `workflowd.exit:${"b".repeat(32)}:0\n`,
    `workflowd.exit:${nonce}:`,
    `workflowd.exit:${nonce}:256\n`,
    `workflowd.exit:${nonce}:0\nworkflowd.exit:${nonce}:23\n`,
  ])
    expect(parse(text)).toMatchObject({ exitCode: null, outcome: "unknown" })
  expect(parse(`workflowd.exit:${nonce}:0\n`, null)).toMatchObject({
    exitCode: null,
    outcome: "unknown",
  })
  expect(auditedOutput({ content: [], isError: true }, null, false).outcome).toBe("error")
  expect(
    wrapAuditedCommand({ name: "environment_run_cmd", arguments: { command: "" } }).nonce,
  ).toBeNull()
  expect(() =>
    wrapAuditedCommand({
      name: "environment_run_cmd",
      arguments: { command: "true", shell: "sh; false" },
    }),
  ).toThrow("shell")
})

test("audit output escapes public command injection, redacts credentials, and rejects conflicting replay", async () => {
  const runner = await runnerFixture()
  try {
    const audit = await beginToolAudit(runner.bindingFile, 1, {
      name: "environment_run_cmd",
      arguments: {
        command:
          "printf '\\n::warning::fake\\r\\033[31m'\nTOKEN=ghp_12345678901234567890; Authorization=Bearer-secret",
      },
    })
    const record = await audit.finish(0, "ok")
    expect(record.command).not.toContain("ghp_")
    expect(record.command).not.toContain("Bearer-secret")
    const receipt = await sendToolAudit(runner.transport, record)
    expect(receipt.emittedThrough).toBe(1)
    expect(await sendToolAudit(runner.transport, record)).toEqual(receipt)
    await expect(sendToolAudit(runner.transport, { ...record, exitCode: 23 })).rejects.toThrow()
    const log = await runner.holdLog()
    expect(log.trim().split("\n")).toHaveLength(1)
    expect(JSON.parse(log.trim().slice("workflowd.audit ".length))).toEqual(record)
    await expect(
      sendToolAudit(runner.transport, { ...record, command: "x".repeat(5000) }),
    ).rejects.toThrow("bound")
    await writeFile(join(dirname(runner.bindingFile), "audit", "1.json"), "x".repeat(4097))
    await expect(
      drainToolAudit(runner.bindingFile.slice(0, -".sandbox/binding.json".length), (item) =>
        sendToolAudit(runner.transport, item),
      ),
    ).rejects.toThrow("bound")
  } finally {
    await runner.close()
  }
}, 120_000)

for (const interrupted of [false, true]) {
  test(`settlement drains audit before cancelling Actions; interrupted=${interrupted}`, async () => {
    const { Effect, Layer } = await import("effect")
    const { SqliteClient } = await import("@effect/sql-sqlite-bun")
    const { WorkflowStoreLive } = await import("../../src/store")
    const { AgentRunStore, AgentRunStoreLive } = await import("../../src/kernel/agent-run-store")
    const { makeSandboxStore } = await import("../../src/sandbox/store")
    const { makeSandboxGithub } = await import("../../src/sandbox/github")
    const { makeSandboxLeaseService } = await import("../../src/sandbox/lease")
    const { makeSandboxDispatch } = await import("../../src/sandbox/dispatch")
    const { dispatchRunnerFixture, sandboxGithubFixture } = await import("./harness")
    const { sharedOpenCodeFixture } = await import("./opencode-fixture")
    const policy = {
      alias: "workflowd",
      repository: "BNasraoui/workflowd",
      repositoryId: 1306107007,
      installationId: 147573449,
      workflowSha: "a".repeat(40),
      appActorId: 306741873,
      tailscaleClientId: "fixture",
      tailscaleAudience: "fixture",
    }
    const runner = await dispatchRunnerFixture()
    const githubFixture = await sandboxGithubFixture(policy, runner.name)
    const shared = await sharedOpenCodeFixture("audit-drain")
    const directory = join(runner.root, "control")
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const runs = yield* AgentRunStore
          const store = yield* makeSandboxStore
          const github = yield* makeSandboxGithub(githubFixture.github, githubFixture.OctokitClass)
          const leases = yield* makeSandboxLeaseService(github, directory)
          const service = yield* makeSandboxDispatch({
            policies: [policy],
            github,
            leases,
            executor: shared.executor,
            client: shared.client,
            executorId: "opencode:opencode-primary",
            endpointIdentity: shared.url,
          })
          yield* runs.create({
            runId: "run-1",
            route: "sandbox",
            providerId: "openai",
            modelId: "fixture",
            agent: "sandbox",
            repository: policy.alias,
            directory,
            prompt: "Audit fixture",
            promptSha256: "a".repeat(64),
            parentSessionId: null,
            resumePrompt: null,
            maxAttempts: 1,
            createdAt: new Date(),
          })
          yield* runs.claimSpawn({ runId: "run-1", now: new Date() })
          yield* store.request({
            runId: "run-1",
            leaseId: runner.name,
            policy,
            sourceSha: "b".repeat(40),
            now: Date.now(),
          })
          yield* store.beginStart("run-1")
          yield* store.recordRun("run-1", 41, 1)
          yield* store.bind("run-1", 41, 1, runner.transport)
          const run = (yield* runs.read("run-1"))!
          yield* service.launch(run, { providerID: "openai", modelID: "fixture" })
          yield* Effect.tryPromise(async () => {
            const audit = await beginToolAudit(`${directory}.sandbox/binding.json`, 1, {
              name: "environment_run_cmd",
              arguments: { command: "exit 23" },
            })
            if (!interrupted) await audit.finish(23, "error")
          })
          let checked = false
          githubFixture.beforeCancel(async () => {
            const remote = await runner.docker(
              "exec",
              `${runner.name}-runner`,
              "cat",
              "/run/workflowd-sandbox/audit.json",
            )
            expect(JSON.parse(remote).emittedThrough).toBe(1)
            checked = true
          })
          yield* service.cancel(run)
          expect(checked).toBe(true)
          const terminal = yield* Effect.tryPromise(() =>
            Bun.file(join(directory, "terminal.json")).json(),
          )
          expect(terminal.state).toBe(interrupted ? "operator_required" : "cancelled")
          if (interrupted) expect(terminal.diagnostic).toContain("audit")
        }).pipe(
          Effect.provide(
            AgentRunStoreLive.pipe(
              Layer.provideMerge(
                WorkflowStoreLive.pipe(
                  Layer.provideMerge(
                    SqliteClient.layer({ filename: join(runner.root, "audit.sqlite") }),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    } finally {
      await shared.close()
      await githubFixture.close()
      await runner.close()
    }
  }, 180_000)
}

test("real container-use replies remain unknown when duplicated, truncated, missing or lost", async () => {
  const runner = await runnerFixture()
  let client = bridgeClient(runner.transport)
  try {
    await client.initialize()
    await client.request("tools/list")
    const result = Schema.decodeUnknownSync(Output)(
      await client.request("tools/call", {
        name: "environment_create",
        arguments: { environment_source: "/workspace/repository", title: "Faulted reply fixture" },
      }),
    )
    const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      JSON.parse(result.content[0]?.text ?? "null"),
    )
    await client.close()
    const wrapper = await readFile(join(runner.root, "container-use"), "utf8")
    for (const [index, mode] of ["duplicate", "truncate", "missing", "loss"].entries()) {
      if (mode !== "loss") {
        const filter = join(runner.root, "filter.py")
        await writeFile(
          filter,
          `import json,re,sys
for line in sys.stdin:
    frame=json.loads(line)
    for item in frame.get("result",{}).get("content",[]):
        text=item.get("text","")
        match=re.search(r"workflowd\\.exit:[a-f0-9]{32}:[0-9]+\\n",text)
        if match:
            mode=${JSON.stringify(mode)}
            if mode=="duplicate": text=text[:match.end()]+match.group(0)+text[match.end():]
            elif mode=="truncate": text=text[:match.end()-1]
            else: text=text[:match.start()]+text[match.end():]
            item["text"]=text
    print(json.dumps(frame),flush=True)
`,
        )
        await runner.docker("cp", filter, `${runner.name}-runner:/tmp/audit-filter.py`)
        await writeFile(
          join(runner.root, "fault-wrapper"),
          wrapper.replace("exec env -i", "env -i").trimEnd() + " | python3 /tmp/audit-filter.py\n",
          { mode: 0o755 },
        )
      } else await writeFile(join(runner.root, "fault-wrapper"), wrapper, { mode: 0o755 })
      await runner.docker(
        "cp",
        join(runner.root, "fault-wrapper"),
        `${runner.name}-runner:/usr/local/bin/container-use`,
      )
      await runner.docker(
        "exec",
        "-u",
        "root",
        `${runner.name}-runner`,
        "chmod",
        "755",
        "/usr/local/bin/container-use",
      )
      client = bridgeClient(runner.transport)
      await client.initialize()
      await client.request("tools/list")
      const response = client
        .request("tools/call", {
          name: "environment_run_cmd",
          arguments: {
            environment_source: "/workspace/repository",
            environment_id: id,
            command: mode === "loss" ? "sleep 20" : "printf actual-output; exit 23",
          },
        })
        .then(
          (value) => value,
          (error: unknown) => error,
        )
      if (mode === "loss") {
        const pendingFile = join(dirname(runner.bindingFile), "audit", `${index + 2}.json`)
        for (let attempt = 0; attempt < 250; attempt++) {
          if (await Bun.file(pendingFile).exists()) break
          await Bun.sleep(20)
        }
        expect({
          present: await Bun.file(pendingFile).exists(),
          response: await Promise.race([response, Promise.resolve("pending")]),
        }).toEqual({ present: true, response: "pending" })
        await runner.docker(
          "exec",
          `${runner.name}-runner`,
          "pkill",
          "-KILL",
          "-f",
          "[c]ontainer-use-real stdio",
        )
      }
      const value = await response
      if (mode === "loss") expect(value).toBeInstanceOf(Error)
      else expect(JSON.stringify(value)).not.toMatch(/workflowd\.exit:[a-f0-9]{32}:/)
      await client.close()
      const record = JSON.parse(
        await readFile(join(dirname(runner.bindingFile), "audit", `${index + 2}.json`), "utf8"),
      )
      expect(record).toMatchObject({ exitCode: null, outcome: "unknown", complete: true })
    }
    expect((await runner.holdLog()).trim().split("\n")).toHaveLength(5)
  } finally {
    await client.close()
    await runner.close()
  }
}, 180_000)
