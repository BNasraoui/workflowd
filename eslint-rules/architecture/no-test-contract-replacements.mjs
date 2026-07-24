import { dirname, relative, sep } from "node:path"
import * as ts from "typescript"

const replacementContractName = /(?:Port|Dependencies)$/
const productionContractNamesByProgram = new WeakMap()

function projectRoot(program) {
  const configFilePath = program.getCompilerOptions().configFilePath
  return configFilePath ? dirname(configFilePath) : program.getCurrentDirectory()
}

function projectPath(program, fileName) {
  return relative(projectRoot(program), fileName).split(sep).join("/")
}

function productionContractNames(program) {
  const cached = productionContractNamesByProgram.get(program)
  if (cached) return cached

  const names = new Set()
  const productionSources = program
    .getSourceFiles()
    .map((source) => ({ path: projectPath(program, source.fileName), source }))
    .filter(({ path }) => path.startsWith("src/") && path.endsWith(".ts"))
    .sort((left, right) => left.path.localeCompare(right.path))

  for (const { source } of productionSources) {
    for (const statement of source.statements) {
      if (
        (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
        replacementContractName.test(statement.name.text)
      ) {
        names.add(statement.name.text)
        names.add(statement.name.text.replace(replacementContractName, ""))
      }
    }
  }

  productionContractNamesByProgram.set(program, names)
  return names
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require tests to reuse production contracts and forbid local Port or Dependencies types",
    },
    schema: [],
    messages: {
      replacementContract:
        "Tests must reuse production contracts and must not declare '{{name}}'; local Port and Dependencies types are forbidden.",
    },
  },
  create(context) {
    const program = context.sourceCode.parserServices?.program
    if (!program || !projectPath(program, context.filename).startsWith("test/")) {
      return {}
    }

    const productionNames = productionContractNames(program)
    const checkDeclaration = (node) => {
      const name = node.id.name
      if (!replacementContractName.test(name) && !productionNames.has(name)) return

      context.report({
        node: node.id,
        messageId: "replacementContract",
        data: { name },
      })
    }

    return {
      TSInterfaceDeclaration: checkDeclaration,
      TSTypeAliasDeclaration: checkDeclaration,
    }
  },
}
