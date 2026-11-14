import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import ts from "typescript"
import { Schema } from "effect"
import { claudeProjectArguments } from "../../src/execution/project-config"
import { claudeInteractiveSettings } from "../../src/kernel/claude-interactive"

type Arguments = { tokens: string[]; sandbox: boolean }
const parse = (text: string) => ts.createSourceFile("launch.ts", text, ts.ScriptTarget.Latest, true)
const strings = (node: ts.ArrayLiteralExpression) =>
  node.elements.filter(ts.isStringLiteral).map((element) => element.text)

// Claude's print/headless switches, independent of executable variable name or caller.
// A standalone "-p" is checked in every expanded Claude launch (other tools use it).
const printMode = (literals: readonly string[]) =>
  literals.includes("--print") ||
  literals.includes("--output-format") ||
  literals.includes("--input-format")

// Scan all production modules, not a list of known launcher functions: host profiles
// and relocated launchers must satisfy the same policy after future merges.
function launches(
  source: ts.SourceFile,
  sandboxArguments: string[],
  projectArguments: readonly string[] = claudeProjectArguments,
  settings = claudeInteractiveSettings,
) {
  const found: Array<{ line: number; print: boolean; variants: Arguments[] }> = []
  const projectImports = source.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "../execution/project-config"
    )
      return []
    const bindings = statement.importClause?.namedBindings
    return bindings && ts.isNamedImports(bindings)
      ? bindings.elements
          .filter(
            (binding) =>
              (binding.propertyName?.text ?? binding.name.text) === "claudeProjectArguments",
          )
          .map((binding) => binding.name.text)
      : []
  })
  const token = (element: ts.Expression) =>
    ts.isStringLiteral(element)
      ? element.text
      : ts.isIdentifier(element) && element.text === "claudeInteractiveSettings"
        ? settings
        : "<dynamic>"
  const expand = (node: ts.Expression): Arguments[] => {
    if (ts.isIdentifier(node) && projectImports.includes(node.text))
      return [{ tokens: [...projectArguments], sandbox: false }]
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node))
      return expand(node.expression)
    if (ts.isConditionalExpression(node))
      return [...expand(node.whenTrue), ...expand(node.whenFalse)]
    if (ts.isCallExpression(node) && node.expression.getText(source) === "nativeSandboxArguments")
      return [{ tokens: sandboxArguments, sandbox: true }]
    if (!ts.isArrayLiteralExpression(node)) return [{ tokens: [], sandbox: false }]
    return node.elements.reduce<Arguments[]>(
      (variants, element) => {
        const additions = ts.isSpreadElement(element)
          ? expand(element.expression)
          : [{ tokens: [token(element)], sandbox: false }]
        return variants.flatMap((variant) =>
          additions.map((addition) => ({
            tokens: [...variant.tokens, ...addition.tokens],
            sandbox: variant.sandbox || addition.sandbox,
          })),
        )
      },
      [{ tokens: [], sandbox: false }],
    )
  }
  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node)) {
      const literals = strings(node)
      // A launch selects a session, settings or the shared Claude project arguments.
      if (
        printMode(literals) ||
        ["--settings", "--session-id", "--resume"].some((value) => literals.includes(value)) ||
        node.elements.some(
          (element) =>
            ts.isSpreadElement(element) &&
            ts.isIdentifier(element.expression) &&
            projectImports.includes(element.expression.text),
        )
      ) {
        found.push({
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          print: printMode(literals),
          variants: expand(node),
        })
        // Nested fragments are part of this launch's expanded variants.
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const foreground = (value: string | undefined) => {
  try {
    const parsed = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
      ),
    )(value ?? "")
    return parsed.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === "1"
  } catch {
    return false
  }
}

function violations(
  source: ts.SourceFile,
  sandboxArguments: string[],
  projectArguments: readonly string[] = claudeProjectArguments,
) {
  return launches(source, sandboxArguments, projectArguments).flatMap(({ line, print, variants }) =>
    variants
      .filter(({ tokens, sandbox }) => {
        const values = tokens.flatMap((token, index) =>
          token === "--setting-sources" ? [tokens[index + 1]] : [],
        )
        const settings = tokens.flatMap((token, index) =>
          token === "--settings" ? [tokens[index + 1]] : [],
        )
        return (
          print ||
          printMode(tokens) ||
          tokens.includes("-p") ||
          values.length !== 1 ||
          values[0] !== (sandbox ? "" : "user") ||
          settings.length !== 1 ||
          !foreground(settings[0])
        )
      })
      .map(({ sandbox }) => ({ line, sandbox, print })),
  )
}

test("every Claude launch is interactive, foreground-only and selects the allowed settings sources", async () => {
  expect(foreground(claudeInteractiveSettings)).toBe(true)
  const root = join(import.meta.dir, "../../src")
  const native = parse(await readFile(join(root, "sandbox/native.ts"), "utf8"))
  const sandboxArrays: string[][] = []
  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node) && strings(node).includes("--tools"))
      sandboxArrays.push(strings(node))
    ts.forEachChild(node, visit)
  }
  visit(native)
  expect(sandboxArrays).toHaveLength(1)
  const sandboxArguments = sandboxArrays[0]!
  let variants = 0
  const failures: unknown[] = []
  for await (const path of new Bun.Glob("**/*.ts").scan(root)) {
    const source = parse(await readFile(join(root, path), "utf8"))
    for (const launch of launches(source, sandboxArguments)) variants += launch.variants.length
    failures.push(...violations(source, sandboxArguments).map((failure) => ({ path, ...failure })))
  }
  // Dispatched shared-host, dispatched sandbox and resumed turns.
  expect(variants).toBeGreaterThanOrEqual(3)
  expect(failures).toEqual([])
})

test("the policy catches print mode, new profiles and missing or weakened selection", () => {
  const settings = `"--settings", '{"env":{"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS":"1"}}'`
  const host = (sources: string, tasks = settings, mode = "") =>
    parse(`runHostWorker({ profile: "claude-resume",
    argv: [binary, ${mode} "--resume", session, ${sources}, ${tasks}] })`)
  expect(violations(host('"--setting-sources", "user"'), [])).toEqual([])
  expect(violations(host('"--setting-sources", "user"', settings, '"-p",'), [])).toHaveLength(1)
  expect(violations(host("", ""), [])).toHaveLength(1)
  expect(violations(host(""), [])).toHaveLength(1)
  expect(violations(host('"--setting-sources", "user,project"'), [])).toHaveLength(1)
  for (const tasks of [
    `"--settings", "{}"`,
    settings.replace('"1"', '"0"'),
    `${settings}, ${settings}`,
  ])
    expect(violations(host('"--setting-sources", "user"', tasks), [])).toHaveLength(1)
  const launch = parse(`runClaudeInteractiveTurn([binary, "--settings", claudeInteractiveSettings,
    ...(sandbox ? await nativeSandboxArguments("claude", binary, cwd, binding)
      : ["--setting-sources", "user"])])`)
  expect(violations(launch, ["--setting-sources", ""])).toEqual([])
  expect(violations(launch, [])).toHaveLength(1)
  expect(violations(launch, ["--setting-sources", "user"])).toHaveLength(1)
  const shared = `import {claudeProjectArguments as sources} from "../execution/project-config";
    turn([binary, "--settings", claudeInteractiveSettings, ...sources]);`
  expect(violations(parse(shared), [])).toEqual([])
  expect(violations(parse(shared), [], ["--setting-sources", "user,project"])).toHaveLength(1)
  expect(
    violations(parse(shared.replace("../execution/project-config", "./unrelated")), []),
  ).toHaveLength(1)
  expect(violations(parse(`run([binary, "--print", ${settings}, ...sources])`), [])).toHaveLength(1)
  // Standalone -p, without --resume, in a settings launch or a shared-arguments launch.
  expect(
    violations(
      parse(`run([binary, "-p", ${settings}, "--setting-sources", "user", "--session-id", id])`),
      [],
    ),
  ).toHaveLength(1)
  expect(violations(parse(shared.replace("[binary,", '[binary, "-p",')), [])).toHaveLength(1)
  expect(
    violations(parse(shared.replace("...sources]", '...sources, ...(x ? ["-p"] : [])]')), []),
  ).toHaveLength(1)
  // Other tools' -p (systemctl, ssh, unzip) is not a Claude launch.
  expect(violations(parse(`run(["systemctl", "--user", "show", unit, "-p", "State"])`), [])).toEqual(
    [],
  )
})
