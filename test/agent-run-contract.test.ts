import { describe, expect, test } from "bun:test"
import {
  parseAgentRunCodexRoutes,
  parseAgentRunRepositories,
  parseAgentRunRoutes,
  resolveAgentRunRoute,
  resolveAgentRunRouteChoice,
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
})

describe("agent-run codex route configuration", () => {
  test("parses name=model pairs, empty models, and bare names to the CLI default", () => {
    expect(parseAgentRunCodexRoutes("implement=gpt-5.1-codex, quick=, fastscan")).toEqual([
      { name: "implement", modelID: "gpt-5.1-codex" },
      { name: "quick", modelID: null },
      { name: "fastscan", modelID: null },
    ])
  })

  test("rejects malformed codex route specs", () => {
    expect(() => parseAgentRunCodexRoutes("bad name=gpt-5.1-codex")).toThrow("invalid route name")
    expect(() => parseAgentRunCodexRoutes("a=p/m")).toThrow("codex model id")
    expect(() => parseAgentRunCodexRoutes("fast,fast")).toThrow("unique")
    expect(() => parseAgentRunCodexRoutes("fast=,fast=")).toThrow("unique")
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

describe("agent-run cross-provider route resolution", () => {
  const openCode = parseAgentRunRoutes(
    "implement=zai-coding-plan/glm-5.3-flash,hard=anthropic/claude-fable-5",
  )
  const codex = parseAgentRunCodexRoutes("scan=gpt-5.1-codex,default")

  test("resolves opencode routes first and codex routes by name or bare model id", () => {
    expect(resolveAgentRunRouteChoice(openCode, codex, "hard")).toEqual({
      outcome: "resolved",
      provider: "opencode",
      route: { name: "hard", providerID: "anthropic", modelID: "claude-fable-5" },
    })
    expect(resolveAgentRunRouteChoice(openCode, codex, "scan")).toEqual({
      outcome: "resolved",
      provider: "codex",
      route: { name: "scan", modelID: "gpt-5.1-codex" },
    })
    expect(resolveAgentRunRouteChoice(openCode, codex, "gpt-5.1-codex")).toEqual({
      outcome: "resolved",
      provider: "codex",
      route: { name: "scan", modelID: "gpt-5.1-codex" },
    })
    // A bare name without '=' maps to the codex CLI default model.
    expect(resolveAgentRunRouteChoice(openCode, codex, "default")).toEqual({
      outcome: "resolved",
      provider: "codex",
      route: { name: "default", modelID: null },
    })
  })

  test("refuses names and model ids served by both providers as ambiguous", () => {
    const both = parseAgentRunCodexRoutes("implement=gpt-5.1-codex")
    expect(resolveAgentRunRouteChoice(openCode, both, "implement")).toEqual({
      outcome: "refused",
      reason: "ambiguous_route",
    })
    const sharedModel = parseAgentRunCodexRoutes("scan=claude-fable-5")
    expect(resolveAgentRunRouteChoice(openCode, sharedModel, "claude-fable-5")).toEqual({
      outcome: "refused",
      reason: "ambiguous_route",
    })
  })

  test("refuses provider-prefixed ids and unknown names as before", () => {
    expect(resolveAgentRunRouteChoice(openCode, codex, "codex/gpt-5.1-codex")).toEqual({
      outcome: "refused",
      reason: "provider_prefixed_route",
    })
    expect(resolveAgentRunRouteChoice(openCode, codex, "nope")).toEqual({
      outcome: "refused",
      reason: "unknown_route",
    })
  })
})
