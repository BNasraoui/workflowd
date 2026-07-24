export * from "./common"
export * from "./design"
export * from "./implementation"
export * from "./plan"
export * from "./questions"
export * from "./research"
export * from "./structure"

import { designStageContract } from "./design"
import { implementationStageContract } from "./implementation"
import { planStageContract } from "./plan"
import { questionsStageContract } from "./questions"
import { researchStageContract } from "./research"
import { structureStageContract } from "./structure"

// QRSPI v1 is one closed typed flow; task-specific composition belongs at the flow level.
export const builtInStageContracts = [
  questionsStageContract,
  researchStageContract,
  designStageContract,
  structureStageContract,
  planStageContract,
  implementationStageContract,
] as const

export type BuiltInStageContract = (typeof builtInStageContracts)[number]
export type BuiltInStageKey = BuiltInStageContract["stageKey"]
export type BuiltInStageContractName = BuiltInStageContract["ref"]["name"]
