import { describe, expect, test } from "bun:test"
import {
  AGENT_RUNS_ENRICHMENT_CONTRACT,
  AgentRunsEnrichmentStore,
} from "../../src/kernel/agent-runs-enrichment-store"
import { DOGFOOD_ENRICHMENT_CONTRACT, DogfoodStore } from "../../src/kernel/dogfood-store"

describe("enrichment wire contracts", () => {
  test("each surface keeps its pinned contract string", () => {
    expect(DOGFOOD_ENRICHMENT_CONTRACT).toBe("provenance-dogfood-enrichment/v1")
    expect(AGENT_RUNS_ENRICHMENT_CONTRACT).toBe("agent-runs-enrichment/v1")
  })

  test("the two enrichment surfaces never share a contract string", () => {
    // Distinct consumers (provenance CLI vs OpenMob) version independently: a
    // shared string would let one store's document be served on the other's
    // route undetected, so the contracts must differ where they must.
    expect(AGENT_RUNS_ENRICHMENT_CONTRACT).not.toBe(DOGFOOD_ENRICHMENT_CONTRACT)
    expect(DogfoodStore.key).not.toBe(AgentRunsEnrichmentStore.key)
  })
})
