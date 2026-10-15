import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import ts from "typescript"

type Arguments = { tokens: string[]; sandbox: boolean }
const foregroundSettings = '{"env":{"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS":"1"}}'
const parse = (text: string) => ts.createSourceFile("launch.ts", text, ts.ScriptTarget.Latest, true)
const strings = (node: ts.ArrayLiteralExpression) =>
  node.elements.filter(ts.isStringLiteral).map((element) => element.text)

// Scan all production modules, not a list of known launcher functions: host profiles
// and relocated launchers must satisfy the same policy after future merges.
function launches(source: ts.SourceFile, sandboxArguments: string[]) {
  const found: Array<{ line: number; variants: Arguments[] }> = []
  const expand = (node: ts.Expression): Arguments[] => {
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
          : [{ tokens: [ts.isStringLiteral(element) ? element.text : "<dynamic>"], sandbox: false }]
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
      // These are Claude's launch/resume switches, independent of the executable
      // variable name, caller, and whether argv is passed through the agent host.
      if (
        literals.includes("--print") ||
        literals.includes("--output-format") ||
        (literals.includes("-p") && literals.includes("--resume"))
      )
        found.push({
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          variants: expand(node),
        })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function violations(source: ts.SourceFile, sandboxArguments: string[]) {
  return launches(source, sandboxArguments).flatMap(({ line, variants }) =>
    variants
      .filter(({ tokens, sandbox }) => {
        const values = tokens.flatMap((token, index) =>
          token === "--setting-sources" ? [tokens[index + 1]] : [],
        )
        const settings = tokens.flatMap((token, index) =>
          token === "--settings" ? [tokens[index + 1]] : [],
        )
        return (
          values.length !== 1 ||
          values[0] !== (sandbox ? "" : "user") ||
          settings.length !== 1 ||
          settings[0] !== foregroundSettings
        )
      })
      .map(({ sandbox }) => ({ line, sandbox })),
  )
}

test("every Claude launch/resume disables background tasks and selects the allowed settings sources", async () => {
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
  let count = 0
  const failures: unknown[] = []
  for await (const path of new Bun.Glob("**/*.ts").scan(root)) {
    const source = parse(await readFile(join(root, path), "utf8"))
    count += launches(source, sandboxArguments).length
    failures.push(...violations(source, sandboxArguments).map((failure) => ({ path, ...failure })))
  }
  expect(count).toBeGreaterThanOrEqual(3)
  expect(failures).toEqual([])
})

test("the policy catches new host profiles and missing or weakened sandbox selection", () => {
  const background = `"--settings", '${foregroundSettings}'`
  const host = (settings: string, tasks = background) =>
    parse(`runHostWorker({ profile: "claude-resume",
    argv: [binary, "-p", "--resume", session, ${settings}, ${tasks}] })`)
  expect(violations(host('"--setting-sources", "user"'), [])).toEqual([])
  expect(violations(host(""), [])).toHaveLength(1)
  expect(violations(host('"--setting-sources", "user,project"'), [])).toHaveLength(1)
  for (const tasks of ["", background.replace('"1"', '"0"'), `${background}, ${background}`])
    expect(violations(host('"--setting-sources", "user"', tasks), [])).toHaveLength(1)
  const launch = parse(`runCliWorker(options, [binary, "--print",
    ${background},
    ...(sandbox ? await nativeSandboxArguments("claude", binary, cwd, binding)
      : ["--setting-sources", "user"])])`)
  expect(violations(launch, ["--setting-sources", ""])).toEqual([])
  expect(violations(launch, [])).toHaveLength(1)
  expect(violations(launch, ["--setting-sources", "user"])).toHaveLength(1)
})
