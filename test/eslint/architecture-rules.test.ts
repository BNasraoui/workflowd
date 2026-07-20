import { afterAll, describe, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuleTester } from "eslint"
import tseslint from "typescript-eslint"

import architecture from "../../eslint-rules/architecture/index.mjs"

RuleTester.describe = describe
RuleTester.it = test

const fixtureRoot = mkdtempSync(join(tmpdir(), "workflowd-architecture-rules-"))

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

function createProject(name: string, productionSource: string): string {
  const root = join(fixtureRoot, name)
  mkdirSync(join(root, "src"), { recursive: true })
  mkdirSync(join(root, "test"), { recursive: true })
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["src/**/*.ts", "test/**/*.ts"],
    }),
  )
  writeFileSync(join(root, "src", "contracts.ts"), productionSource)
  writeFileSync(join(root, "test", "rule.test.ts"), "export {}\n")
  return root
}

function typedRuleTester(projectRoot: string): RuleTester {
  return new RuleTester({
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: projectRoot,
      },
    },
  })
}

function installEffectPackage(projectRoot: string): void {
  const packageRoot = join(projectRoot, "node_modules", "effect")
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "effect", version: "0.0.0", types: "index.d.ts" }),
  )
  writeFileSync(
    join(packageRoot, "index.d.ts"),
    [
      "export namespace Effect {",
      "  export interface Effect<A, E = never, R = never> {",
      "    readonly success: A",
      "    readonly error: E",
      "    readonly requirements: R",
      "  }",
      "}",
      "",
    ].join("\n"),
  )
}

const alphaProject = createProject("alpha", "export interface AlphaPort { run(): void }\n")
const betaProject = createProject("beta", "export type BetaDependencies = { run(): void }\n")
const contractRule = architecture.rules["no-test-contract-replacements"]

typedRuleTester(alphaProject).run("no-test-contract-replacements (alpha)", contractRule, {
  valid: [
    {
      name: "allows unrelated contracts in tests",
      filename: join(alphaProject, "test", "rule.test.ts"),
      code: "interface ScenarioInput {}",
    },
    {
      name: "does not report production declarations",
      filename: join(alphaProject, "src", "contracts.ts"),
      code: "export interface AlphaPort { run(): void }",
    },
    {
      name: "does not leak names from another project",
      filename: join(alphaProject, "test", "rule.test.ts"),
      code: "type Beta = {}",
    },
  ],
  invalid: [
    {
      name: "rejects a Port declaration in a test",
      filename: join(alphaProject, "test", "rule.test.ts"),
      code: "type LocalPort = {}",
      errors: [
        {
          messageId: "replacementContract",
          data: { name: "LocalPort" },
          line: 1,
          column: 6,
          endLine: 1,
          endColumn: 15,
        },
      ],
    },
    {
      name: "rejects a Dependencies declaration in a test",
      filename: join(alphaProject, "test", "rule.test.ts"),
      code: "interface LocalDependencies {}",
      errors: [
        {
          messageId: "replacementContract",
          data: { name: "LocalDependencies" },
          line: 1,
          column: 11,
          endLine: 1,
          endColumn: 28,
        },
      ],
    },
    {
      name: "rejects a production contract name",
      filename: join(alphaProject, "test", "rule.test.ts"),
      code: "interface AlphaPort {}",
      errors: [
        {
          messageId: "replacementContract",
          data: { name: "AlphaPort" },
          line: 1,
          column: 11,
          endLine: 1,
          endColumn: 20,
        },
      ],
    },
    {
      name: "rejects a suffix-stripped production contract name",
      filename: join(alphaProject, "test", "rule.test.ts"),
      code: "type Alpha = {}",
      errors: [
        {
          messageId: "replacementContract",
          data: { name: "Alpha" },
          line: 1,
          column: 6,
          endLine: 1,
          endColumn: 11,
        },
      ],
    },
  ],
})

typedRuleTester(betaProject).run("no-test-contract-replacements (beta)", contractRule, {
  valid: [
    {
      name: "isolates cached production names from an earlier project",
      filename: join(betaProject, "test", "rule.test.ts"),
      code: "type Alpha = {}",
    },
  ],
  invalid: [
    {
      name: "uses the current project's suffix-stripped contract names",
      filename: join(betaProject, "test", "rule.test.ts"),
      code: "type Beta = {}",
      errors: [
        {
          messageId: "replacementContract",
          data: { name: "Beta" },
          line: 1,
          column: 6,
          endLine: 1,
          endColumn: 10,
        },
      ],
    },
  ],
})

typedRuleTester(alphaProject).run(
  "no-test-contract-replacements (cached alpha rerun)",
  contractRule,
  {
    valid: [],
    invalid: [
      {
        name: "keeps each project's cache stable across runs",
        filename: join(alphaProject, "test", "rule.test.ts"),
        code: "type Alpha = { rerun: true }",
        errors: [{ messageId: "replacementContract", data: { name: "Alpha" } }],
      },
    ],
  },
)

const syntaxRuleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
  },
})
const doubleAssertionRule = architecture.rules["no-double-assertion-through-unknown"]

syntaxRuleTester.run("no-double-assertion-through-unknown", doubleAssertionRule, {
  valid: [
    "const value = input as unknown",
    "const value = input as any as Target",
    "type Unknown = unknown; const value = input as Unknown as Target",
  ],
  invalid: [
    {
      name: "rejects the exact as-unknown-as syntax with an imported target",
      code: 'import type { Target } from "./target"\nconst value = input as unknown as Target',
      errors: [
        {
          messageId: "doubleAssertion",
          line: 2,
          column: 15,
          endLine: 2,
          endColumn: 41,
        },
      ],
    },
    {
      name: "does not confuse a shadowing value named unknown with the type keyword",
      code: "const unknown = input\nunknown as unknown as Target",
      errors: [
        {
          messageId: "doubleAssertion",
          line: 2,
          column: 1,
          endLine: 2,
          endColumn: 29,
        },
      ],
    },
    {
      name: "reports only the direct double-assertion node in a longer chain",
      code: "const value = input as unknown as Target as Final",
      errors: [
        {
          messageId: "doubleAssertion",
          line: 1,
          column: 15,
          endLine: 1,
          endColumn: 41,
        },
      ],
    },
    {
      name: "rejects a parenthesized inner as assertion",
      code: "const value = (input as unknown) as Target",
      errors: [
        {
          messageId: "doubleAssertion",
          line: 1,
          column: 15,
          endLine: 1,
          endColumn: 43,
        },
      ],
    },
    {
      name: "rejects a parenthesized unknown type",
      code: "const value = input as (unknown) as Target",
      errors: [
        {
          messageId: "doubleAssertion",
          line: 1,
          column: 15,
          endLine: 1,
          endColumn: 43,
        },
      ],
    },
    {
      name: "rejects angle-bracket double assertions",
      code: "const value = <Target><unknown>input",
      errors: [
        {
          messageId: "doubleAssertion",
          line: 1,
          column: 15,
          endLine: 1,
          endColumn: 37,
        },
      ],
    },
    {
      name: "rejects mixed angle-bracket and as assertions",
      code: "const value = (<unknown>input) as Target",
      errors: [
        {
          messageId: "doubleAssertion",
          line: 1,
          column: 15,
          endLine: 1,
          endColumn: 41,
        },
      ],
    },
    {
      name: "unwraps a non-null expression between assertions",
      code: "const value = (input as unknown)! as Target",
      errors: [
        {
          messageId: "doubleAssertion",
          line: 1,
          column: 15,
          endLine: 1,
          endColumn: 44,
        },
      ],
    },
    {
      name: "unwraps a satisfies expression between assertions",
      code: "const value = (input as unknown satisfies Intermediate) as Target",
      errors: [
        {
          messageId: "doubleAssertion",
          line: 1,
          column: 15,
          endLine: 1,
          endColumn: 66,
        },
      ],
    },
  ],
})

const aliasedUnknownAssertion =
  "type UnknownAlias = unknown\nconst value = input as UnknownAlias as Target"
writeFileSync(join(alphaProject, "test", "double-assertion.test.ts"), aliasedUnknownAssertion)

typedRuleTester(alphaProject).run(
  "no-double-assertion-through-unknown (type-aware)",
  doubleAssertionRule,
  {
    valid: [
      {
        name: "allows aliases that do not resolve to unknown",
        filename: join(alphaProject, "test", "double-assertion.test.ts"),
        code: "type StringAlias = string\nconst value = input as StringAlias as Target",
      },
    ],
    invalid: [
      {
        name: "rejects a local type alias that resolves to unknown",
        filename: join(alphaProject, "test", "double-assertion.test.ts"),
        code: aliasedUnknownAssertion,
        errors: [
          {
            messageId: "doubleAssertion",
            line: 2,
            column: 15,
            endLine: 2,
            endColumn: 46,
          },
        ],
      },
    ],
  },
)

const effectProject = createProject("effect", "export {}\n")
installEffectPackage(effectProject)

const effectSources = {
  "aliased-success.ts":
    'import type { Effect as Fx } from "effect"\nexport type Bad = Fx.Effect<unknown, Error>',
  "aliased-error.ts":
    'import type { Effect as RuntimeEffect } from "effect"\nexport type Bad = RuntimeEffect.Effect<string, unknown>',
  "safe-effect.ts":
    'import type { Effect as Fx } from "effect"\nexport type Safe = Fx.Effect<string, Error, unknown>',
  "local-effect.ts":
    "namespace Effect { export interface Effect<A, E> { success: A; error: E } }\nexport type Local = Effect.Effect<unknown, unknown>",
}

for (const [fileName, source] of Object.entries(effectSources)) {
  writeFileSync(join(effectProject, "src", fileName), source)
}

const effectRule = architecture.rules["no-unknown-effect-channels"]

typedRuleTester(effectProject).run("no-unknown-effect-channels", effectRule, {
  valid: [
    {
      name: "allows unknown in the Effect requirements channel",
      filename: join(effectProject, "src", "safe-effect.ts"),
      code: effectSources["safe-effect.ts"],
    },
    {
      name: "ignores unrelated local Effect types",
      filename: join(effectProject, "src", "local-effect.ts"),
      code: effectSources["local-effect.ts"],
    },
    {
      name: "does not enforce production Effect policy in tests",
      filename: join(effectProject, "test", "rule.test.ts"),
      code: 'import type { Effect } from "effect"\ntype TestEffect = Effect.Effect<unknown, unknown>',
    },
  ],
  invalid: [
    {
      name: "resolves an imported Effect alias with unknown success",
      filename: join(effectProject, "src", "aliased-success.ts"),
      code: effectSources["aliased-success.ts"],
      errors: [
        {
          messageId: "unknownEffectChannel",
          line: 2,
          column: 19,
          endLine: 2,
          endColumn: 44,
        },
      ],
    },
    {
      name: "resolves an imported Effect alias with unknown error",
      filename: join(effectProject, "src", "aliased-error.ts"),
      code: effectSources["aliased-error.ts"],
      errors: [
        {
          messageId: "unknownEffectChannel",
          line: 2,
          column: 19,
          endLine: 2,
          endColumn: 56,
        },
      ],
    },
  ],
})

const effectAliasProject = createProject("effect-aliases", "export {}\n")
installEffectPackage(effectAliasProject)

const effectAliasSources = {
  "one-hop.ts": [
    'import type { Effect as Fx } from "effect"',
    "type WorkflowEffect<A, E> = Fx.Effect<A, E>",
    "export type Bad = WorkflowEffect<unknown, Error>",
  ].join("\n"),
  "reordered.ts": [
    'import type { Effect as RenamedEffect } from "effect"',
    "type Reordered<A, E> = RenamedEffect.Effect<E, A>",
    "export type Bad = Reordered<Error, unknown>",
  ].join("\n"),
  "multi-hop.ts": [
    'import type { Effect as Fx } from "effect"',
    "type Base<A, E> = Fx.Effect<A, E>",
    "type Middle<X, Y> = Base<X, Y>",
    "type WorkflowEffect<P, Q> = Middle<P, Q>",
    "export type Bad = WorkflowEffect<string, unknown>",
  ].join("\n"),
}

for (const [fileName, source] of Object.entries(effectAliasSources)) {
  writeFileSync(join(effectAliasProject, "src", fileName), source)
}

typedRuleTester(effectAliasProject).run("no-unknown-effect-channels (local aliases)", effectRule, {
  valid: [],
  invalid: [
    {
      name: "substitutes a one-hop generic Effect alias",
      filename: join(effectAliasProject, "src", "one-hop.ts"),
      code: effectAliasSources["one-hop.ts"],
      errors: [
        {
          messageId: "unknownEffectChannel",
          line: 3,
          column: 19,
          endLine: 3,
          endColumn: 49,
        },
      ],
    },
    {
      name: "substitutes reordered parameters through a renamed Effect import",
      filename: join(effectAliasProject, "src", "reordered.ts"),
      code: effectAliasSources["reordered.ts"],
      errors: [
        {
          messageId: "unknownEffectChannel",
          line: 3,
          column: 19,
          endLine: 3,
          endColumn: 44,
        },
      ],
    },
    {
      name: "substitutes parameters through multiple local aliases",
      filename: join(effectAliasProject, "src", "multi-hop.ts"),
      code: effectAliasSources["multi-hop.ts"],
      errors: [
        {
          messageId: "unknownEffectChannel",
          line: 5,
          column: 19,
          endLine: 5,
          endColumn: 50,
        },
      ],
    },
  ],
})

const unrelatedAliasProject = createProject("unrelated-aliases", "export {}\n")
const unrelatedAliasSources = {
  "generic.ts": [
    "type LocalResult<A, E> = { value: A; error: E }",
    "export type Fine = LocalResult<unknown, Error>",
  ].join("\n"),
  "local-effect.ts": [
    "namespace Effect { export interface Effect<A, E> { value: A; error: E } }",
    "type LocalEffect<A, E> = Effect.Effect<A, E>",
    "export type Fine = LocalEffect<unknown, Error>",
  ].join("\n"),
  "cycle.ts": ["type Cycle<A, E> = Cycle<A, E>", "export type Fine = Cycle<unknown, Error>"].join(
    "\n",
  ),
}

for (const [fileName, source] of Object.entries(unrelatedAliasSources)) {
  writeFileSync(join(unrelatedAliasProject, "src", fileName), source)
}

typedRuleTester(unrelatedAliasProject).run(
  "no-unknown-effect-channels (unrelated aliases)",
  effectRule,
  {
    valid: Object.entries(unrelatedAliasSources).map(([fileName, code]) => ({
      name: `ignores ${fileName}`,
      filename: join(unrelatedAliasProject, "src", fileName),
      code,
    })),
    invalid: [],
  },
)
