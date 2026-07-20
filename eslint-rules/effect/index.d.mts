import type { Rule } from "eslint"

type RuleName =
  | "no-direct-throw-in-gen"
  | "no-sync-schema-decode-in-gen"
  | "no-throwing-operation-in-sync"
  | "require-promise-rejection-handler"

export const rules: Readonly<Record<RuleName, Rule.RuleModule>>

declare const plugin: {
  readonly meta: {
    readonly name: "workflowd-effect"
    readonly version: string
  }
  readonly rules: typeof rules
}

export default plugin
