import { expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { loadConfig } from "../../src/config"
import { localDiscoverySources } from "../../src/execution/local"
import { makeExecutionCapabilities } from "../../src/execution-capabilities"
import { makeClaudeDiscovery } from "../../src/execution/claude"

test("Claude observes resolved aliases and options without sending a prompt", async () => {
  const directory = await mkdtemp("/tmp/opencode/workflowd-claude-catalog-")
  const binary = join(directory, "claude")
  const frames = join(directory, "frames")
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
createInterface({input:process.stdin}).on("line", line => {
  appendFileSync(${JSON.stringify(frames)}, line + "\\n");
  const f=JSON.parse(line);
  if(f.type === "control_request") process.stdout.write(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:f.request_id,response:{commands:[],agents:[],output_style:"default",available_output_styles:[],account:{},models:[
    {value:"opus",resolvedModel:"claude-opus-5-5",displayName:"Opus",supportsEffort:true,supportedEffortLevels:["high","max"],supportsFastMode:true},
    {value:"unresolved",displayName:"Custom"}
  ]}}}) + "\\n");
});
`,
  )
  await chmod(binary, 0o755)
  try {
    const config = await loadConfig({
      WORKFLOWD_MODE: "execution",
      WORKFLOWD_AGENT_RUN_TOKEN: "fixture-secret",
      WORKFLOWD_AGENT_RUN_REPOSITORIES: `fixture=${directory}`,
      WORKFLOWD_AGENT_RUN_CLAUDE_BIN: binary,
      WORKFLOWD_EXECUTION_CAPABILITIES_CLAUDE_ENABLED: "true",
      WORKFLOWD_HOST_ID: "mint",
    })
    const sources = localDiscoverySources(config).filter((s) => s.kind === "claude")
    const discovery = makeExecutionCapabilities({
      host: "mint",
      sources,
      refreshMs: 100,
      timeoutMs: 1000,
    })
    try {
      const result = await discovery.list()
      expect(result.capabilities).toHaveLength(1)
      expect(result.capabilities[0]).toMatchObject({
        identity: { model: "claude-opus-5-5" },
        selectionModel: "claude-opus-5-5",
        availability: "unknown",
        thinking: { efforts: [{ id: "high" }, { id: "max" }] },
        speed: { tiers: [{ id: "standard" }, { id: "fast", native: "fastMode" }] },
      })
      const messages = (await readFile(frames, "utf8"))
        .trim()
        .split("\n")
        .map((line) =>
          Schema.decodeUnknownSync(Schema.Struct({ type: Schema.String }))(JSON.parse(line)),
        )
      expect(messages.some((frame) => frame.type === "user")).toBe(false)
    } finally {
      await discovery.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Claude timeout terminates the owned process and awaits its teardown", async () => {
  const directory = await mkdtemp("/tmp/opencode/workflowd-claude-timeout-")
  const binary = join(directory, "claude")
  const pidPath = join(directory, "pid")
  await writeFile(
    binary,
    `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(pidPath)},String(process.pid));for await (const chunk of Bun.stdin.stream()) { }`,
    { mode: 0o700 },
  )
  const discovery = makeExecutionCapabilities({
    host: "mint",
    refreshMs: 100,
    timeoutMs: 200,
    sources: [makeClaudeDiscovery("claude:local", binary, directory)],
  })
  try {
    const result = await discovery.list()
    expect(result.sources[0]?.status).toBe("unavailable")
    await discovery.close()
    const pid = Number(await readFile(pidPath, "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    await discovery.close()
    await rm(directory, { recursive: true, force: true })
  }
})
