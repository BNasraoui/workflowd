import { dirname, relative, sep } from "node:path"
import * as ts from "typescript"

function projectRoot(program) {
  const configFilePath = program.getCompilerOptions().configFilePath
  return configFilePath ? dirname(configFilePath) : program.getCurrentDirectory()
}

function projectPath(program, fileName) {
  return relative(projectRoot(program), fileName).split(sep).join("/")
}

function resolveAlias(checker, symbol) {
  const seen = new Set()
  while ((symbol.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(symbol)) {
    seen.add(symbol)
    symbol = checker.getAliasedSymbol(symbol)
  }
  return symbol
}

function isEffectSymbol(resolved) {
  if (resolved.getName() !== "Effect") return false

  return resolved.declarations?.some((declaration) =>
    /(?:^|\/)node_modules\/effect(?:\/|$)/.test(
      declaration.getSourceFile().fileName.replaceAll("\\", "/"),
    ),
  )
}

function containsUnknown(type) {
  return (
    (type.flags & ts.TypeFlags.Unknown) !== 0 ||
    (type.isUnionOrIntersection() && type.types.some(containsUnknown))
  )
}

function typeNodeContainsUnknown(checker, node, substitutions, seenTypeParameters = new Set()) {
  while (ts.isParenthesizedTypeNode(node)) node = node.type

  if (ts.isTypeReferenceNode(node)) {
    const symbol = checker.getSymbolAtLocation(node.typeName)
    const substitution = symbol && substitutions.get(symbol)
    if (symbol && substitution && !seenTypeParameters.has(symbol)) {
      seenTypeParameters.add(symbol)
      const result = typeNodeContainsUnknown(
        checker,
        substitution.node,
        substitution.substitutions,
        seenTypeParameters,
      )
      seenTypeParameters.delete(symbol)
      if (result) return true
    }
  }

  if (containsUnknown(checker.getTypeFromTypeNode(node))) return true
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.some((type) =>
      typeNodeContainsUnknown(checker, type, substitutions, seenTypeParameters),
    )
  }
  return false
}

function localTypeAliasDeclaration(symbol) {
  return symbol.declarations?.find(
    (declaration) =>
      ts.isTypeAliasDeclaration(declaration) &&
      !/(?:^|\/)node_modules(?:\/|$)/.test(
        declaration.getSourceFile().fileName.replaceAll("\\", "/"),
      ),
  )
}

function typeNodeContainsUnknownEffect(checker, node, substitutions, seenAliases) {
  while (ts.isParenthesizedTypeNode(node)) node = node.type
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.some((type) =>
      typeNodeContainsUnknownEffect(checker, type, substitutions, seenAliases),
    )
  }
  if (!ts.isTypeReferenceNode(node)) return false

  const symbol = checker.getSymbolAtLocation(node.typeName)
  if (!symbol) return false

  const resolved = resolveAlias(checker, symbol)
  if (isEffectSymbol(resolved)) {
    return Boolean(
      node.typeArguments
        ?.slice(0, 2)
        .some((channel) => typeNodeContainsUnknown(checker, channel, substitutions)),
    )
  }

  const declaration = localTypeAliasDeclaration(resolved)
  if (!declaration || seenAliases.has(declaration)) return false

  const aliasSubstitutions = new Map()
  for (const [index, parameter] of (declaration.typeParameters ?? []).entries()) {
    const parameterSymbol = checker.getSymbolAtLocation(parameter.name)
    if (!parameterSymbol) continue

    const argument = node.typeArguments?.[index]
    if (argument) {
      aliasSubstitutions.set(parameterSymbol, { node: argument, substitutions })
    } else if (parameter.default) {
      aliasSubstitutions.set(parameterSymbol, {
        node: parameter.default,
        substitutions: aliasSubstitutions,
      })
    }
  }

  seenAliases.add(declaration)
  const result = typeNodeContainsUnknownEffect(
    checker,
    declaration.type,
    aliasSubstitutions,
    seenAliases,
  )
  seenAliases.delete(declaration)
  return result
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow unknown in production Effect success and error channels",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      unknownEffectChannel: "Effect success and error channels must not contain unknown.",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices
    const program = services?.program
    const nodeMap = services?.esTreeNodeToTSNodeMap
    if (!program || !nodeMap || !projectPath(program, context.filename).startsWith("src/"))
      return {}

    const checker = program.getTypeChecker()
    return {
      TSTypeReference(node) {
        const tsNode = nodeMap.get(node)
        if (
          !ts.isTypeReferenceNode(tsNode) ||
          !typeNodeContainsUnknownEffect(checker, tsNode, new Map(), new Set())
        ) {
          return
        }

        context.report({ node, messageId: "unknownEffectChannel" })
      },
    }
  },
}
