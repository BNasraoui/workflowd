import type { ExecutionCapability } from "../execution-capability-contract"
import type { ExecutionPolicy } from "./policy"

export type ModelFamily = {
  readonly family: string
  readonly version: string
  readonly nativeHarness: "codex" | "claude" | "opencode"
}

/** Canonical vendor IDs only; arbitrary display names never establish a family. */
export function modelFamily(
  capability: ExecutionCapability,
  policy?: ExecutionPolicy,
): ModelFamily | undefined {
  for (const family of policy?.families ?? []) {
    const mapping = family.models.find(
      (m) =>
        m.model === capability.identity.model &&
        (m.provider === undefined || m.provider === capability.identity.provider),
    )
    if (mapping !== undefined)
      return { family: family.name, version: mapping.version, nativeHarness: family.harness }
  }
  const { model, provider, executor } = capability.identity
  const openai = /^gpt-(\d+(?:\.\d+)*)-(luna|terra|sol|astra)$/.exec(model)
  if (
    openai?.[1] &&
    openai[2] &&
    (provider === "openai" || (provider === null && executor.startsWith("codex:")))
  )
    return { family: openai[2], version: openai[1], nativeHarness: "codex" }
  const claude = /^claude-(haiku|sonnet|opus|fable)-(\d+(?:-\d{1,3})*)(?:-\d{8})?(?:\[1m\])?$/.exec(
    model,
  )
  if (
    claude?.[1] &&
    claude[2] &&
    (provider === "anthropic" || (provider === null && executor.startsWith("claude:")))
  )
    return { family: claude[1], version: claude[2].replaceAll("-", "."), nativeHarness: "claude" }
  return undefined
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
