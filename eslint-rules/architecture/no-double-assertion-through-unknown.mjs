import * as ts from "typescript"

function isAssertionExpression(node) {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
}

function unwrapTransparentExpression(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression
  }
  return node
}

function containsUnknown(type) {
  return (
    (type.flags & ts.TypeFlags.Unknown) !== 0 ||
    (type.isUnionOrIntersection() && type.types.some(containsUnknown))
  )
}

function isUnknownTypeNode(node, checker) {
  while (ts.isParenthesizedTypeNode(node)) node = node.type
  return (
    node.kind === ts.SyntaxKind.UnknownKeyword ||
    Boolean(checker && containsUnknown(checker.getTypeFromTypeNode(node)))
  )
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow double type assertions through unknown",
    },
    schema: [],
    messages: {
      doubleAssertion: "Do not bypass type safety with a double assertion through unknown.",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices
    const nodeMap = services?.esTreeNodeToTSNodeMap
    if (!nodeMap) return {}

    const checker = services.program?.getTypeChecker()
    const checkAssertion = (node) => {
      const tsNode = nodeMap.get(node)
      if (!isAssertionExpression(tsNode)) return

      const innerAssertion = unwrapTransparentExpression(tsNode.expression)
      if (
        isAssertionExpression(innerAssertion) &&
        isUnknownTypeNode(innerAssertion.type, checker)
      ) {
        context.report({ node, messageId: "doubleAssertion" })
      }
    }

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    }
  },
}
