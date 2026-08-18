import { describe, expect, test } from "bun:test"
import { persistedSnapshotMustRemainCompatible, qrspiSpec } from "../../provenance/qrspi.spec"

describe("QRSPI Provenance spec", () => {
  test("exports the shared Rule as its immutable handle", () => {
    expect(persistedSnapshotMustRemainCompatible.key).toBe("persisted-compatibility")
    expect(Object.isFrozen(persistedSnapshotMustRemainCompatible)).toBe(true)
    expect(qrspiSpec.key).toBe("qrspi-runtime")
    expect(Object.isFrozen(qrspiSpec)).toBe(true)
  })
})
