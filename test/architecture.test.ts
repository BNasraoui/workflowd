import { describe, expect, test } from "bun:test"
import * as ts from "typescript"

const sourcePaths = [...new Bun.Glob("src/**/*.ts").scanSync()].sort()
const testPaths = [...new Bun.Glob("test/**/*.ts").scanSync()].sort()
const trackedPaths = Bun.spawnSync([
  "git",
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "--deduplicate",
  "-z",
])
  .stdout.toString()
  .split("\0")
  .filter((path) => path !== "" && !path.startsWith(".beads/"))
  .sort()
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile)
const parsedConfig = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  ts.sys.getCurrentDirectory(),
)
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options)
const checker = program.getTypeChecker()

type ArchitectureFixture = {
  readonly sourcePath: string
}

const replacementContractName = /(?:Port|Dependencies)$/
const productionContractNames = new Set<string>()
for (const path of sourcePaths) {
  const source = program.getSourceFile(ts.sys.resolvePath(path))!
  for (const statement of source.statements) {
    if (
      (ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement)) &&
      replacementContractName.test(statement.name.text)
    ) {
      productionContractNames.add(statement.name.text)
      productionContractNames.add(
        statement.name.text.replace(replacementContractName, ""),
      )
    }
  }
}

function isUnknownChannel(channel: ts.Type): boolean {
  return (
    (channel.flags & ts.TypeFlags.Unknown) !== 0 ||
    (channel.isUnionOrIntersection() && channel.types.some(isUnknownChannel))
  )
}

describe("architecture type hygiene", () => {
  test("Effect success and error channels do not contain unknown", async () => {
    const violations: Array<string> = []
    for (const path of sourcePaths) {
      const source = program.getSourceFile(ts.sys.resolvePath(path))!
      const visit = (node: ts.Node): void => {
        if (
          ts.isTypeReferenceNode(node) &&
          ["Effect", "Effect.Effect"].includes(node.typeName.getText(source)) &&
          node.typeArguments?.slice(0, 2).some((channel) =>
            isUnknownChannel(checker.getTypeFromTypeNode(channel)),
          )
        ) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source))
          violations.push(`${path}:${position.line + 1}: ${node.getText(source)}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(violations).toEqual([])
  })

  test("tests do not declare replacement contract types", async () => {
    const violations: Array<string> = []
    for (const path of testPaths) {
      const source = ts.createSourceFile(
        path,
        await Bun.file(path).text(),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      const visit = (node: ts.Node): void => {
        if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
          const name = node.name.text
          if (
            !replacementContractName.test(name) &&
            !productionContractNames.has(name)
          ) {
            ts.forEachChild(node, visit)
            return
          }
          const position = source.getLineAndCharacterOfPosition(
            node.getStart(source),
          )
          violations.push(`${path}:${position.line + 1}: ${name}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(violations).toEqual([])
  })

  test("source and tests do not double-cast through unknown", async () => {
    const violations: Array<string> = []
    for (const path of [...sourcePaths, ...testPaths]) {
      const source = ts.createSourceFile(
        path,
        await Bun.file(path).text(),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      const visit = (node: ts.Node): void => {
        if (
          ts.isAsExpression(node) &&
          ts.isAsExpression(node.expression) &&
          node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
        ) {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source))
          violations.push(`${path}:${position.line + 1}: ${node.getText(source)}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(violations).toEqual([])
  })
})

describe("product identity", () => {
  test("tracked product files contain no superseded identifiers", async () => {
    const forbiddenIdentifiers = [
      ["opencode", "hooks"].join("-"),
      ["OPENCODE", "HOOKS"].join("_"),
      ["OpenCode", "Hooks", "Job"].join("-"),
    ]
    const violations: Array<string> = []

    for (const path of trackedPaths) {
      const file = Bun.file(path)
      if (!(await file.exists())) continue
      const content = await file.text()
      for (const identifier of forbiddenIdentifiers) {
        if (path.includes(identifier) || content.includes(identifier)) {
          violations.push(`${path}: ${identifier}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})
