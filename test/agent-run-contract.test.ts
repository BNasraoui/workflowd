import { describe, expect, test } from "bun:test"
import {
  parseAgentRunRepositories,
  parseAgentRunRoutes,
  resolveAgentRunRoute,
} from "../src/agent-run-contract"

describe("agent-run route configuration", () => {
  test("parses name=provider/model pairs", () => {
    const routes = parseAgentRunRoutes(
      "implement=zai-coding-plan/glm-5.3-flash, hard=anthropic/claude-fable-5",
    )
    expect(routes).toEqual([
      { name: "implement", providerID: "zai-coding-plan", modelID: "glm-5.3-flash" },
      { name: "hard", providerID: "anthropic", modelID: "claude-fable-5" },
    ])
  })

  test("rejects malformed route specs", () => {
    expect(() => parseAgentRunRoutes("implement")).toThrow("invalid route name")
    expect(() => parseAgentRunRoutes("implement=glm-5.3-flash")).toThrow("provider/model")
    expect(() => parseAgentRunRoutes("a=p/m,a=q/n")).toThrow("unique")
    expect(() => parseAgentRunRoutes("bad name=p/m")).toThrow("invalid route name")
  })

  test("parses repository allow-list entries and rejects relative paths", () => {
    expect(parseAgentRunRepositories("workflowd=/home/ben/repos/workflowd")).toEqual([
      { name: "workflowd", directory: "/home/ben/repos/workflowd" },
    ])
    expect(() => parseAgentRunRepositories("workflowd=repos/workflowd")).toThrow(
      "normalized absolute path",
    )
    expect(() => parseAgentRunRepositories("a=/x,a=/y")).toThrow("unique")
  })
})

describe("agent-run route resolution", () => {
  const routes = parseAgentRunRoutes(
    "implement=zai-coding-plan/glm-5.3-flash,quick=zai-coding-plan/glm-5.3-flash,hard=anthropic/claude-fable-5",
  )

  test("resolves a route name and a bare unambiguous model id", () => {
    expect(resolveAgentRunRoute(routes, "hard")).toEqual({
      outcome: "resolved",
      route: { name: "hard", providerID: "anthropic", modelID: "claude-fable-5" },
    })
    expect(resolveAgentRunRoute(routes, "claude-fable-5")).toEqual({
      outcome: "resolved",
      route: { name: "hard", providerID: "anthropic", modelID: "claude-fable-5" },
    })
  })

  test("refuses provider-prefixed ids so no caller path carries provider dialects", () => {
    expect(resolveAgentRunRoute(routes, "anthropic/claude-fable-5")).toEqual({
      outcome: "refused",
      reason: "provider_prefixed_route",
    })
  })

  test("refuses unknown and ambiguous requests distinctly", () => {
    expect(resolveAgentRunRoute(routes, "gpt-9")).toEqual({
      outcome: "refused",
      reason: "unknown_route",
    })
    // glm-5.3-flash is served by two routes; a bare model id cannot pick one.
    expect(resolveAgentRunRoute(routes, "glm-5.3-flash")).toEqual({
      outcome: "refused",
      reason: "ambiguous_route",
    })
  })
})
