import { expect, test } from "bun:test"
import { Schema } from "effect"

const Rule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
  effect: Schema.Literals(["allow", "deny", "ask"]),
})
const Policy = Schema.Struct({
  agents: Schema.Record(Schema.String, Schema.Struct({ permissions: Schema.Array(Rule) })),
  mcp: Schema.Struct({ servers: Schema.Record(Schema.String, Schema.Unknown) }),
})
const allowed = ["read", "grep", "glob", "list", "StructuredOutput"]
const denied = [
  "execute",
  "codemode",
  "websearch",
  "webfetch",
  "skill",
  "shell",
  "bash",
  "edit",
  "write",
  "patch",
  "subagent",
  "task",
  "external_directory",
  "question",
  "workflowd_dispatch_agent",
  "other_server_tool",
  "future-tool",
]
const matches = (pattern: string, value: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  ).test(value)

test("the deployed v2 reviewer and fixer deny every action outside the read-only allowlist", async () => {
  const file = Bun.file("deploy/opencode/opencode2.json")
  expect(await file.exists()).toBe(true)
  const config = Schema.decodeUnknownSync(Policy)(await file.json())
  expect(config.mcp.servers).toEqual({})
  for (const agent of ["pr-reviewer", "pr-fixer"]) {
    const rules = config.agents[agent]!.permissions
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    // Reject wildcard or newly added grants, even if not in today's tool catalog.
    expect(
      [
        ...new Set(rules.filter((rule) => rule.effect === "allow").map((rule) => rule.action)),
      ].sort(),
    ).toEqual([...allowed].sort())
    const effective = (action: string, resource = "*") =>
      [{ action: "*", resource: "*", effect: "allow" }, ...rules]
        .filter((rule) => matches(rule.action, action) && matches(rule.resource, resource))
        .at(-1)?.effect
    for (const tool of allowed) expect(effective(tool)).toBe("allow")
    for (const tool of denied) expect(effective(tool)).toBe("deny")
    expect(effective("read", ".env")).toBe("deny")
    expect(effective("read", ".env.example")).toBe("allow")
  }
})

test.each(["pr-reviewer", "pr-fixer"])("legacy agent %s also denies by default", async (agent) => {
  const text = await Bun.file(`deploy/opencode/agent/${agent}.md`).text()
  const config = Schema.decodeUnknownSync(
    Schema.Struct({
      permission: Schema.Record(
        Schema.String,
        Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
      ),
    }),
  )(Bun.YAML.parse(text.split("---")[1]!))
  expect(config.permission["*"]).toBe("deny")
  expect(
    Object.entries(config.permission)
      .filter(
        ([, value]) =>
          value === "allow" ||
          (typeof value === "object" && Object.values(value).includes("allow")),
      )
      .map(([key]) => key)
      .sort(),
  ).toEqual([...allowed].sort())
})

test("the reviewer server uses an isolated global config root and disables project config", async () => {
  const file = Bun.file("deploy/systemd/opencode2-server.service.d/20-review-isolation.conf")
  expect(await file.exists()).toBe(true)
  const unit = await file.text()
  expect(unit).toContain("Environment=XDG_CONFIG_HOME=%h/.config/workflowd/opencode2")
  expect(unit).toContain("Environment=OPENCODE_DISABLE_PROJECT_CONFIG=1")
  expect(unit).toContain(
    "Environment=OPENCODE_CONFIG=%h/.config/workflowd/opencode2-sandbox-agent.json",
  )
})
