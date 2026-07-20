import { effectCallback, isCallableHandler, isEffectMember } from "./ast.mjs"

function unwrap(expression) {
  if (
    expression.type === "ChainExpression" ||
    expression.type === "TSAsExpression" ||
    expression.type === "TSNonNullExpression" ||
    expression.type === "TSTypeAssertion"
  ) {
    return unwrap(expression.expression)
  }
  return expression
}

function hasRejectionHandler(expression, sourceCode) {
  const current = unwrap(expression)
  if (current.type !== "CallExpression" || current.callee.type !== "MemberExpression") return false
  const property = current.callee.property
  const name =
    !current.callee.computed && property.type === "Identifier"
      ? property.name
      : current.callee.computed && property.type === "Literal"
        ? property.value
        : undefined
  if (name === "catch") return isCallableHandler(current.arguments[0], sourceCode)
  return name === "then" && isCallableHandler(current.arguments[1], sourceCode)
}

function expressionHandlesRejection(expression, sourceCode) {
  const current = unwrap(expression)
  if (current.type === "ConditionalExpression") {
    return (
      expressionHandlesRejection(current.consequent, sourceCode) &&
      expressionHandlesRejection(current.alternate, sourceCode)
    )
  }
  return hasRejectionHandler(current, sourceCode)
}

function analyzeStatements(statements, sourceCode) {
  let canContinue = true
  let valid = true
  for (const statement of statements) {
    if (!canContinue) break
    const result = analyzeStatement(statement, sourceCode)
    canContinue = result.canContinue
    valid = valid && result.valid
  }
  return { canContinue, valid }
}

function analyzeStatement(statement, sourceCode) {
  if (statement.type === "ReturnStatement") {
    return {
      canContinue: false,
      valid:
        statement.argument !== null && expressionHandlesRejection(statement.argument, sourceCode),
    }
  }
  if (statement.type === "BlockStatement") {
    return analyzeStatements(statement.body, sourceCode)
  }
  if (statement.type === "IfStatement") {
    const consequent = analyzeStatement(statement.consequent, sourceCode)
    const alternate =
      statement.alternate === null
        ? { canContinue: true, valid: true }
        : analyzeStatement(statement.alternate, sourceCode)
    return {
      canContinue: consequent.canContinue || alternate.canContinue,
      valid: consequent.valid && alternate.valid,
    }
  }
  if (
    statement.type === "ThrowStatement" ||
    statement.type === "BreakStatement" ||
    statement.type === "ContinueStatement"
  ) {
    return { canContinue: false, valid: false }
  }
  if (
    statement.type === "DoWhileStatement" ||
    statement.type === "ForInStatement" ||
    statement.type === "ForOfStatement" ||
    statement.type === "ForStatement" ||
    statement.type === "LabeledStatement" ||
    statement.type === "SwitchStatement" ||
    statement.type === "TryStatement" ||
    statement.type === "WhileStatement" ||
    statement.type === "WithStatement"
  ) {
    return { canContinue: true, valid: false }
  }
  return { canContinue: true, valid: true }
}

function callbackHandlesRejection(callback, sourceCode) {
  if (callback.async) return false
  if (callback.body.type !== "BlockStatement") {
    return expressionHandlesRejection(callback.body, sourceCode)
  }
  const result = analyzeStatements(callback.body.body, sourceCode)
  return result.valid && !result.canContinue
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require Effect.promise callbacks to return a rejection-handled Promise chain",
    },
    schema: [],
    messages: {
      unhandledRejection:
        "Effect.promise requires a returned .catch(handler) or .then(success, rejection) chain; otherwise use Effect.tryPromise.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode

    return {
      CallExpression(node) {
        if (!isEffectMember(node.callee, "promise", sourceCode)) return
        const callback = effectCallback(node, "promise", sourceCode)
        if (callback === undefined || !callbackHandlesRejection(callback, sourceCode)) {
          context.report({ node, messageId: "unhandledRejection" })
        }
      },
    }
  },
}
