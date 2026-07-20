import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { RuleTester } from "eslint"
import { resolve } from "node:path"
import tseslint from "typescript-eslint"
import effectPlugin from "../../eslint-rules/effect/index.mjs"

RuleTester.describe = describe
RuleTester.it = test
RuleTester.itOnly = test.only
setDefaultTimeout(20_000)

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
})

const typeAwareRuleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaVersion: "latest",
      projectService: {
        allowDefaultProject: ["effect-rule-type-case.ts"],
      },
      sourceType: "module",
      tsconfigRootDir: resolve(import.meta.dirname, "../.."),
    },
  },
})

const typeAwareFilename = "effect-rule-type-case.ts"

describe("effect flat plugin", () => {
  test("exports the four local rules", () => {
    expect(effectPlugin.meta.name).toBe("workflowd-effect")
    expect(Object.keys(effectPlugin.rules).sort()).toEqual([
      "no-direct-throw-in-gen",
      "no-sync-schema-decode-in-gen",
      "no-throwing-operation-in-sync",
      "require-promise-rejection-handler",
    ])
  })
})

ruleTester.run("no-direct-throw-in-gen", effectPlugin.rules["no-direct-throw-in-gen"], {
  valid: [
    {
      name: "allows throws in a nested callback",
      code: `
          import { Effect } from "effect"
          Effect.gen(function* () {
            const parse = () => { throw new Error("nested") }
            yield* Effect.sync(parse)
          })
        `,
    },
    {
      name: "ignores a shadowed import alias",
      code: `
          import { Effect as Fx } from "effect"
          function example(Fx: { gen: (callback: () => unknown) => unknown }) {
            return Fx.gen(function* () { throw new Error("not Effect.gen") })
          }
        `,
    },
    {
      name: "ignores a shadowed local Effect namespace alias",
      code: `
          import { Effect } from "effect"
          const Fx = Effect
          function example(Fx: { gen: (callback: () => unknown) => unknown }) {
            return Fx.gen(function* () { throw new Error("not Effect.gen") })
          }
        `,
    },
    {
      name: "keeps excluding nested callbacks for a referenced generator",
      code: `
          import { Effect } from "effect"
          function* program() {
            const parse = () => { throw new Error("nested") }
            yield* Effect.sync(parse)
          }
          Effect.gen(program)
        `,
    },
    {
      name: "does not treat a destructured binding as the Effect namespace",
      code: `
          import { Effect } from "effect"
          const { nested: Fx } = Effect
          Fx.gen(function* () { throw new Error("not Effect.gen") })
        `,
    },
    {
      name: "does not follow shadowed or cyclic member aliases",
      code: `
          import { Effect } from "effect"
          const importedGen = Effect.gen
          function example(importedGen: (callback: () => unknown) => unknown) {
            return importedGen(function* () { throw new Error("shadowed") })
          }
          const first = second
          const second = first
          first(function* () { throw new Error("cyclic") })
        `,
    },
    `
        const Effect = { gen: (callback: () => unknown) => callback() }
        Effect.gen(function* () { throw new Error("unrelated") })
      `,
  ],
  invalid: [
    {
      name: "reports a direct throw through an Effect import alias",
      code: `
          import { Effect as Fx } from "effect"
          Fx.gen(function* () { throw new Error("boom") })
        `,
      errors: [{ messageId: "directThrow" }],
    },
    {
      name: "supports the Effect.gen this-argument form",
      code: `
          import * as Effect from "effect/Effect"
          Effect.gen(this, function* () {
            if (Date.now() > 0) throw new Error("boom")
          })
        `,
      errors: [{ messageId: "directThrow" }],
    },
    {
      name: "resolves a referenced generator declaration through a local Effect alias",
      code: `
          import { Effect } from "effect"
          const Fx = Effect
          function* program() { throw new Error("boom") }
          Fx.gen(program)
        `,
      errors: [{ messageId: "directThrow" }],
    },
    {
      name: "resolves a const alias of Effect.gen",
      code: `
          import { Effect } from "effect"
          const gen = Effect.gen
          gen(function* () { throw new Error("boom") })
        `,
      errors: [{ messageId: "directThrow" }],
    },
  ],
})

ruleTester.run(
  "no-throwing-operation-in-sync",
  effectPlugin.rules["no-throwing-operation-in-sync"],
  {
    valid: [
      {
        name: "ignores Bun.serve in a nested callback",
        code: `
          import { Effect } from "effect"
          Effect.sync(() => () => Bun.serve({ fetch: () => new Response() }))
        `,
      },
      {
        name: "ignores a locally shadowed Bun binding",
        code: `
          import { Effect } from "effect"
          const Bun = { serve: () => "safe" }
          Effect.sync(() => Bun.serve())
        `,
      },
      {
        name: "ignores similarly named members from another module",
        code: `
          import { Effect } from "effect"
          import { Schema } from "other-library"
          Effect.sync(() => Schema.decodeUnknownSync(String)("value"))
        `,
      },
    ],
    invalid: [
      {
        name: "reports workflowd's Bun.serve listener acquisition",
        code: `
          import { Effect } from "effect"
          Effect.sync(() => Bun.serve({ fetch: () => new Response("ok") }))
        `,
        errors: [{ messageId: "throwingOperation", data: { operation: "Bun.serve" } }],
      },
      {
        name: "reports an invoked Schema decoder through import aliases",
        code: `
          import { Effect as Fx, Schema as S } from "effect"
          Fx.sync(() => S.decodeUnknownSync(S.String)(input))
        `,
        errors: [
          {
            messageId: "throwingOperation",
            data: { operation: "Schema.decodeUnknownSync" },
          },
        ],
      },
      {
        name: "reports a directly imported synchronous decoder",
        code: `
          import { Effect } from "effect"
          import { decodeSync as decode } from "effect/Schema"
          Effect.sync(() => decode(String)(input))
        `,
        errors: [{ messageId: "throwingOperation", data: { operation: "Schema.decodeSync" } }],
      },
      {
        name: "resolves a referenced const callback and local namespaces",
        code: `
          import { Effect, Schema } from "effect"
          const Fx = Effect
          const S = Schema
          const run = () => S.decodeUnknownSync(Model)(input)
          Fx.sync(run)
        `,
        errors: [
          {
            messageId: "throwingOperation",
            data: { operation: "Schema.decodeUnknownSync" },
          },
        ],
      },
      {
        name: "resolves a referenced const function callback",
        code: `
          import { Effect } from "effect"
          const start = function () { return Bun.serve({ fetch: () => new Response() }) }
          Effect.sync(start)
        `,
        errors: [{ messageId: "throwingOperation", data: { operation: "Bun.serve" } }],
      },
      {
        name: "resolves a const alias of sync from an aliased namespace",
        code: `
          import { Effect } from "effect"
          const Fx = Effect
          const sync = Fx.sync
          sync(() => Bun.serve({ fetch: () => new Response() }))
        `,
        errors: [{ messageId: "throwingOperation", data: { operation: "Bun.serve" } }],
      },
    ],
  },
)

ruleTester.run(
  "require-promise-rejection-handler",
  effectPlugin.rules["require-promise-rejection-handler"],
  {
    valid: [
      {
        name: "allows a returned catch chain with a handler",
        code: `
          import { Effect } from "effect"
          Effect.promise(() => request().catch(() => fallback))
        `,
      },
      {
        name: "allows a returned then chain with a rejection handler",
        code: `
          import { Effect as Fx } from "effect"
          Fx.promise(() => request().then(value => value, error => recover(error)))
        `,
      },
      {
        name: "allows the workflowd pathExists form",
        code: `
          import { Effect } from "effect"
          Effect.promise(() => stat(path).then(() => true, () => false))
        `,
      },
      {
        name: "allows a handled promise returned from a block callback",
        code: `
          import * as Effect from "effect/Effect"
          const handleError = (error: unknown) => String(error)
          Effect.promise(() => { return request().catch(handleError) })
        `,
      },
      {
        name: "allows imported, local, and member rejection handlers",
        code: `
          import { Effect } from "effect"
          import defaultRecover from "./default-errors"
          import { recover } from "./errors"
          function localRecover(error: unknown) { return String(error) }
          Effect.promise(() => zero().catch(defaultRecover))
          Effect.promise(() => first().catch(recover))
          Effect.promise(() => second().catch(localRecover))
          Effect.promise(() => third().catch(handlers.recover))
        `,
      },
      {
        name: "allows a referenced callback when every branch returns a handled chain",
        code: `
          import { Effect } from "effect"
          const recover = (error: unknown) => String(error)
          function run() {
            if (ready) return first().catch(recover)
            return second().then(value => value, recover)
          }
          Effect.promise(run)
        `,
      },
      {
        name: "allows conditional expressions with handled terminal branches",
        code: `
          import { Effect } from "effect"
          const recover = (error: unknown) => String(error)
          Effect.promise(() =>
            ready
              ? first().catch(recover)
              : second().then(value => value, recover)
          )
          Effect.promise(() => {
            return ready ? first().catch(recover) : second().catch(recover)
          })
        `,
      },
      {
        name: "does not blanket-match a promise method name",
        code: `
          const Effect = { promise: (callback: () => unknown) => callback() }
          Effect.promise(() => request())
        `,
      },
    ],
    invalid: [
      {
        name: "reports a plain returned promise",
        code: `
          import { Effect } from "effect"
          Effect.promise(() => request.arrayBuffer())
        `,
        errors: [{ messageId: "unhandledRejection" }],
      },
      {
        name: "reports catch without a handler",
        code: `
          import { Effect } from "effect"
          Effect.promise(() => request().catch())
        `,
        errors: [{ messageId: "unhandledRejection" }],
      },
      {
        name: "reports then without a rejection handler",
        code: `
          import { Effect } from "effect"
          Effect.promise(() => request().then(value => value))
        `,
        errors: [{ messageId: "unhandledRejection" }],
      },
      {
        name: "reports workflowd's async cleanup callback",
        code: `
          import { Effect } from "effect"
          Effect.promise(async () => { await cleanup() })
        `,
        errors: [{ messageId: "unhandledRejection" }],
      },
      {
        name: "rejects void as a catch handler",
        code: `
          import { Effect } from "effect"
          Effect.promise(() => request().catch(void 0))
        `,
        errors: [{ messageId: "unhandledRejection" }],
      },
      {
        name: "rejects literal and object rejection handlers",
        code: `
          import { Effect } from "effect"
          Effect.promise(() => first().catch(42))
          Effect.promise(() => second().then(value => value, {}))
        `,
        errors: [{ messageId: "unhandledRejection" }, { messageId: "unhandledRejection" }],
      },
      {
        name: "rejects an unshadowed undefined handler",
        code: `
          import { Effect } from "effect"
          Effect.promise(() => request().then(value => value, undefined))
        `,
        errors: [{ messageId: "unhandledRejection" }],
      },
      {
        name: "rejects unresolved and non-function local identifiers as handlers",
        code: `
          import { Effect } from "effect"
          const notAHandler = 42
          Effect.promise(() => first().catch(missingHandler))
          Effect.promise(() => second().catch(notAHandler))
        `,
        errors: [{ messageId: "unhandledRejection" }, { messageId: "unhandledRejection" }],
      },
      {
        name: "rejects a reachable bare return",
        code: `
          import { Effect } from "effect"
          const recover = (error: unknown) => String(error)
          Effect.promise(() => {
            if (skip) return
            return request().catch(recover)
          })
        `,
        errors: [{ messageId: "unhandledRejection" }],
      },
      {
        name: "rejects reachable callback fallthrough",
        code: `
          import { Effect } from "effect"
          const recover = (error: unknown) => String(error)
          Effect.promise(() => {
            if (ready) return request().catch(recover)
            recordNotReady()
          })
        `,
        errors: [{ messageId: "unhandledRejection" }],
      },
      {
        name: "resolves a referenced const function through a local Effect alias",
        code: `
          import { Effect } from "effect"
          const Fx = Effect
          const run = function () { return request() }
          Fx.promise(run)
        `,
        errors: [{ messageId: "unhandledRejection" }],
      },
      {
        name: "rejects an imported callback whose body cannot be checked",
        code: `
          import { Effect } from "effect"
          import { run } from "./request"
          Effect.promise(run)
        `,
        errors: [{ messageId: "unhandledRejection" }],
      },
      {
        name: "rejects an imported namespace as a rejection handler",
        code: `
          import { Effect } from "effect"
          import * as handlers from "./handlers"
          Effect.promise(() => request().catch(handlers))
        `,
        errors: [{ messageId: "unhandledRejection" }],
      },
      {
        name: "rejects a handled operation followed by an unhandled promise stage",
        code: `
          import { Effect } from "effect"
          const recover = (error: unknown) => String(error)
          Effect.promise(() => request().catch(recover).then(value => value))
        `,
        errors: [{ messageId: "unhandledRejection" }],
      },
      {
        name: "resolves a const alias of Effect.promise",
        code: `
          import { Effect } from "effect"
          const promise = Effect.promise
          promise(() => request())
        `,
        errors: [{ messageId: "unhandledRejection" }],
      },
    ],
  },
)

typeAwareRuleTester.run(
  "require-promise-rejection-handler with type information",
  effectPlugin.rules["require-promise-rejection-handler"],
  {
    valid: [
      {
        name: "accepts a typed callable parameter handler",
        filename: typeAwareFilename,
        code: `
          import { Effect } from "effect"
          declare const request: () => Promise<string>
          function run(recover: (error: unknown) => string) {
            return Effect.promise(() => request().catch(recover))
          }
        `,
      },
      {
        name: "accepts an asserted callable handler expression",
        filename: typeAwareFilename,
        code: `
          import { Effect } from "effect"
          declare const request: () => Promise<string>
          declare const candidate: unknown
          Effect.promise(() =>
            request().catch(candidate as (error: unknown) => string)
          )
        `,
      },
    ],
    invalid: [
      {
        name: "rejects typed non-callable member and literal handlers",
        filename: typeAwareFilename,
        code: `
          import { Effect } from "effect"
          declare const request: () => Promise<string>
          const handlers = { recover: 42 }
          Effect.promise(() => request().catch(handlers.recover))
          Effect.promise(() => request().catch("recover"))
        `,
        errors: [{ messageId: "unhandledRejection" }, { messageId: "unhandledRejection" }],
      },
    ],
  },
)

ruleTester.run("no-sync-schema-decode-in-gen", effectPlugin.rules["no-sync-schema-decode-in-gen"], {
  valid: [
    {
      name: "allows a decoder outside Effect.gen",
      code: `
          import { Schema } from "effect"
          const decode = Schema.decodeUnknownSync(Model)
          decode(input)
        `,
    },
    {
      name: "ignores decoder calls in nested callbacks",
      code: `
          import { Effect, Schema } from "effect"
          const decode = Schema.decodeUnknownSync(Model)
          Effect.gen(function* () {
            yield* Effect.sync(() => decode(input))
          })
        `,
    },
    {
      name: "ignores a shadowed decoder alias",
      code: `
          import { Effect, Schema } from "effect"
          const decode = Schema.decodeUnknownSync(Model)
          Effect.gen(function* () {
            const decode = (value: unknown) => value
            return decode(input)
          })
        `,
    },
    {
      name: "ignores asynchronous Schema decoders",
      code: `
          import { Effect, Schema as S } from "effect"
          Effect.gen(function* () { return S.decodeUnknown(Model)(input) })
        `,
    },
    {
      name: "ignores a shadowed local Schema namespace alias",
      code: `
          import { Effect, Schema } from "effect"
          const S = Schema
          Effect.gen(function* () {
            const S = { decodeUnknownSync: () => (value: unknown) => value }
            return S.decodeUnknownSync()(input)
          })
        `,
    },
  ],
  invalid: [
    {
      name: "reports a direct decoder factory result call",
      code: `
          import { Effect, Schema } from "effect"
          Effect.gen(function* () {
            return Schema.decodeUnknownSync(Model)(input)
          })
        `,
      errors: [{ messageId: "syncDecode", data: { decoder: "Schema.decodeUnknownSync" } }],
    },
    {
      name: "reports workflowd-like one-hop module aliases",
      code: `
          import { Effect as Fx, Schema as S } from "effect"
          const decodeTracked = S.decodeUnknownSync(Tracked)
          Fx.gen(function* () { return decodeTracked(row) })
        `,
      errors: [{ messageId: "syncDecode", data: { decoder: "Schema.decodeUnknownSync" } }],
    },
    {
      name: "reports a block-local direct-import alias",
      code: `
          import { Effect } from "effect"
          import { decodeSync as makeDecoder } from "effect/Schema"
          Effect.gen(function* () {
            const decode = makeDecoder(Model)
            return decode(input)
          })
        `,
      errors: [{ messageId: "syncDecode", data: { decoder: "Schema.decodeSync" } }],
    },
    {
      name: "resolves local namespaces, a referenced callback, and two-hop decoder aliases",
      code: `
          import { Effect, Schema } from "effect"
          const Fx = Effect
          const S = Schema
          const decode = S.decodeUnknownSync(Model)
          const decodeAgain = decode
          const program = function* () { return decodeAgain(input) }
          Fx.gen(program)
        `,
      errors: [{ messageId: "syncDecode", data: { decoder: "Schema.decodeUnknownSync" } }],
    },
    {
      name: "resolves a const alias of a Schema decoder factory",
      code: `
          import { Effect, Schema } from "effect"
          const makeDecoder = Schema.decodeUnknownSync
          const decode = makeDecoder(Model)
          Effect.gen(function* () { return decode(input) })
        `,
      errors: [{ messageId: "syncDecode", data: { decoder: "Schema.decodeUnknownSync" } }],
    },
  ],
})
