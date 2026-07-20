import type { Rule } from "eslint"

type ArchitectureRuleName =
  | "no-double-assertion-through-unknown"
  | "no-test-contract-replacements"
  | "no-unknown-effect-channels"

export const rules: Record<ArchitectureRuleName, Rule.RuleModule>

declare const plugin: { rules: typeof rules }

export default plugin
